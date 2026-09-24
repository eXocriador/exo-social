/**
 * Дати архіву і межі календарного дня в часовому поясі.
 *
 * Архів зберігає дати наївним UTC (`2026-06-10T18:04:17`). Назовні шлюз
 * віддає ISO з `Z` — спільна форма §3 каже «ISO, UTC», і наївна дата в чужих
 * руках тихо читається як місцева.
 */

const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Дата архіву → мілісекунди UTC; `null` — не дата. */
export function parseArchiveTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = NAIVE.test(s) ? `${s.replace(' ', 'T')}Z` : ZONED.test(s) ? s : null;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Дата архіву → ISO UTC з `Z`, зберігаючи дробові секунди, якщо вони є. */
export function toIsoUtc(raw: string): string {
  const s = raw.trim();
  if (NAIVE.test(s)) return `${s.replace(' ', 'T')}Z`;
  const ms = parseArchiveTime(s);
  return ms === null ? s : new Date(ms).toISOString();
}

/** Мілісекунди UTC → наївний ISO, яким переглядач читає курсор. */
export function toNaiveUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, '').replace(/Z$/, '');
}

export class TimeArgError extends Error {}

/** Чи знає рантайм цю IANA-назву. */
export function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new TimeArgError('invalid timezone: expected an IANA name such as Europe/Kyiv');
  }
}

/** Зсув пояса в мс для цієї миті (місцевий − UTC). */
function offsetAt(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(ms / 1000) * 1000;
}

/** Мить UTC, коли в поясі `tz` настає північ дня y-m-d. */
function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  // Двічі: зсув на місцевій півночі може відрізнятись від зсуву на UTC-півночі
  // (перехід на літній час цього дня).
  let at = guess - offsetAt(guess, tz);
  at = guess - offsetAt(at, tz);
  return at;
}

/** Межі дня `YYYY-MM-DD` у поясі `tz` як [початок, кінець) у мс UTC. */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new TimeArgError('invalid date format: expected YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || y < 2) {
    throw new TimeArgError('invalid date format: expected YYYY-MM-DD');
  }
  assertTimeZone(tz);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return {
    start: zonedMidnight(y, mo, d, tz),
    end: zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz),
  };
}
