/**
 * yt-dlp — окремий процес на виклик (бінарник в образі, запінений sha256 у
 * Dockerfile). Від нього береться ЛИШЕ відповідь плеєра: назва, тривалість,
 * мова і посилання на доріжки субтитрів (`-O` з шаблоном JSON, без завантажень).
 * Саму доріжку (json3) шлюз бере звичайним fetch: посилання timedtext вже
 * підписане і PO-токена не потребує (перевірено 2026-09-24), а ще один процес
 * на кожну доріжку коштував би пам'яті й секунд.
 *
 * **Капкан, перевірений першим (журнал 58):** YouTube просить «Sign in to
 * confirm you're not a bot» для IP датацентру. З VPS не проходять 2 відео з 3,
 * і по IPv4, і по IPv6; шість `player_client` і PO-токен (bgutil) цього не
 * знімають. Тому бот-перевірка — не збій адаптера, а `blocked`: вхід цілий,
 * платформа відмовляє саме серверу, повтор не допоможе. Здоров'ю це не вирок,
 * лише `limited` з причиною (connectors.md §3).
 */
import { execFile } from 'node:child_process';
import { charge } from '../../meter.js';
import type { Segment } from '../../shape.js';
import { AdapterError } from '../types.js';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type YtDlpRunner = (args: string[]) => Promise<RunResult>;

export interface SpawnOptions {
  path: string;
  timeoutMs: number;
  /** Скільки процесів yt-dlp живе одночасно (без JS-рушія — ~60 МіБ кожен). */
  concurrency: number;
}

/**
 * Запуск бінарника. Оточення — мінімальне, без секретів шлюзу: yt-dlp чужий
 * код, і `PRODUCT_KEYS` йому ні до чого.
 */
export function spawnYtDlp(opts: SpawnOptions): YtDlpRunner {
  let running = 0;
  const waiting: (() => void)[] = [];
  const acquire = () =>
    running < opts.concurrency ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return async (args) => {
    await acquire();
    try {
      return await new Promise<RunResult>((resolve) => {
        execFile(
          opts.path,
          args,
          {
            timeout: opts.timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 16 << 20,
            env: {
              PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
              HOME: '/tmp',
              LANG: 'C.UTF-8',
            },
          },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
            resolve({
              code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
              stdout: String(stdout),
              stderr: e && typeof e.code === 'string' ? `${e.code}: ${e.message}` : String(stderr),
              timedOut: e?.killed === true,
            });
          },
        );
      });
    } finally {
      release();
    }
  };
}

/**
 * Шаблон `-O`: лише потрібні поля, одним рядком JSON.
 *
 * `--no-js-runtimes` — свідомо. JS-челендж плеєра (n/sig) потрібен посиланням
 * на ПОТОКИ, а субтитри й метадані приходять і без нього — ті самі доріжки,
 * ті самі посилання timedtext без PO-токена (перевірено 2026-09-24). Ціна
 * челенджу — node поруч із yt-dlp: пік cgroup одного запуску 250 МіБ проти 62,
 * і два одночасні запуски впирали шлюз у mem_limit (замір — README продукту).
 */
const FIELDS = '%(.{id,title,language,duration,subtitles,automatic_captions})j';

export function infoArgs(videoId: string): string[] {
  return [
    '--ignore-config',
    '--no-update',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--cache-dir',
    '/tmp/yt-dlp-cache',
    '--no-js-runtimes',
    '--socket-timeout',
    '20',
    '-O',
    FIELDS,
    '--',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
}

/** Остання змістовна помилка yt-dlp — людям, без шляхів і посилань на FAQ. */
function lastError(stderr: string): string {
  const lines = stderr.split('\n').filter((l) => l.startsWith('ERROR:'));
  const line = (lines.at(-1) ?? stderr.trim().split('\n').at(-1) ?? '').replace(/^ERROR:\s*/, '');
  return line.replace(/\s*(Use --cookies|See {1,2}https?:\/\/).*$/s, '').slice(0, 240);
}

/** Невдалий запуск → помилка адаптера. */
export function classifyRun(r: RunResult, timeoutMs: number): AdapterError {
  if (r.timedOut) return new AdapterError('down', `yt-dlp не вклався в ${Math.round(timeoutMs / 1000)} с`);
  const text = r.stderr;
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(text)) {
    return new AdapterError('blocked', 'YouTube вимагає вхід для цього відео (вікове обмеження) — без акаунта транскрипта не буде');
  }
  if (/confirm you.{0,3}re not a bot|Sign in to confirm/i.test(text)) {
    return new AdapterError(
      'blocked',
      'YouTube просить вхід (бот-перевірка) для IP сервера — транскрипт цього відео недоступний; повтор не допоможе',
    );
  }
  if (/members-only|Join this channel/i.test(text)) return new AdapterError('blocked', 'відео лише для членів каналу');
  if (/HTTP Error 429|Too Many Requests/i.test(text)) return new AdapterError('rate_limited', 'YouTube відповів 429 на yt-dlp');
  if (/Private video|Video unavailable|has been removed|no longer available|not a valid URL|Incomplete YouTube ID|does not exist/i.test(text)) {
    return new AdapterError('not_found', 'відео немає або воно приватне');
  }
  if (/ENOENT|EACCES/.test(text)) return new AdapterError('down', 'yt-dlp не запускається (немає бінарника в образі?)');
  return new AdapterError('down', `yt-dlp: ${lastError(text) || `код ${r.code}`}`);
}

interface Track {
  ext?: unknown;
  url?: unknown;
}

export interface VideoInfo {
  id: string;
  title: string | null;
  language: string | null;
  duration: number | null;
  subtitles: Record<string, Track[]>;
  automatic_captions: Record<string, Track[]>;
}

export async function fetchInfo(run: YtDlpRunner, videoId: string, timeoutMs: number): Promise<VideoInfo> {
  charge('ytdlp');
  const r = await run(infoArgs(videoId));
  if (r.code !== 0) throw classifyRun(r, timeoutMs);
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new AdapterError('down', 'yt-dlp віддав не JSON');
  }
  const tracks = (v: unknown): Record<string, Track[]> =>
    v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, t]) => Array.isArray(t))) : {};
  return {
    id: typeof raw.id === 'string' ? raw.id : videoId,
    title: typeof raw.title === 'string' ? raw.title : null,
    language: typeof raw.language === 'string' ? raw.language : null,
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    subtitles: tracks(raw.subtitles),
    automatic_captions: tracks(raw.automatic_captions),
  };
}

export interface Choice {
  /** Мова без `-orig`. */
  language: string;
  source: 'manual' | 'auto';
  url: string;
}

const json3 = (list: Track[] | undefined): string | null => {
  const t = list?.find((x) => x.ext === 'json3' && typeof x.url === 'string');
  return t ? (t.url as string) : null;
};

/**
 * Яку доріжку брати.
 *   Мову названо: ручні субтитри цією мовою → розпізнані в оригіналі (`xx-orig`).
 *   Не названо: ручні мовою відео → розпізнані мовою відео → будь-які ручні →
 *   будь-які розпізнані в оригіналі.
 * **Автоперекладу немає зовсім** (з 2026-09-25): він видає переклад за
 * мовлення, а головне — саме запити перекладених доріжок дали IP сервера 429
 * на timedtext (журнал 59). Перекласти може продукт — через blackgate.
 * `null` — у відео доріжки немає (або немає названою мовою).
 */
export function pickTrack(info: VideoInfo, want: string | null): Choice | null {
  const manual = info.subtitles;
  const auto = info.automatic_captions;
  const m = (lang: string): Choice | null => {
    const url = json3(manual[lang]);
    return url ? { language: lang, source: 'manual', url } : null;
  };
  const a = (key: string): Choice | null => {
    const url = json3(auto[key]);
    return url ? { language: key.replace(/-orig$/, ''), source: 'auto', url } : null;
  };
  if (want) return m(want) ?? a(`${want}-orig`);

  const lang = info.language;
  if (lang) {
    const own = m(lang) ?? a(`${lang}-orig`);
    if (own) return own;
  }
  for (const key of Object.keys(manual)) {
    if (key === 'live_chat') continue;
    const c = m(key);
    if (c) return c;
  }
  for (const key of Object.keys(auto)) {
    if (!key.endsWith('-orig')) continue;
    const c = a(key);
    if (c) return c;
  }
  return null;
}

/** Мови, які є, — для підказки на «немає такою мовою». */
export function languagesOf(info: VideoInfo): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(info.subtitles)) if (k !== 'live_chat') out.add(k);
  for (const k of Object.keys(info.automatic_captions)) if (k.endsWith('-orig')) out.add(k.replace(/-orig$/, ''));
  return [...out];
}

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: { utf8?: unknown }[];
}

/** Найдовший сегмент, у який зливаються рядки субтитрів, секунди. */
export const SEGMENT_SPAN = 30;

const tenth = (s: number) => Math.round(s * 10) / 10;

/**
 * json3 → сегменти. Рядки субтитрів (по 2–5 слів) зливаються в сегменти до
 * `SEGMENT_SPAN` секунд: так година мовлення — ~120 сегментів, а не тисяча, і
 * бюджет ріже за байтами, а не за кількістю.
 */
export function toSegments(body: unknown, span = SEGMENT_SPAN): Segment[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new AdapterError('down', 'доріжка субтитрів не json3');
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const raw of events as Json3Event[]) {
    if (!Array.isArray(raw.segs)) continue;
    const text = raw.segs
      .map((s) => (typeof s.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = (typeof raw.tStartMs === 'number' ? raw.tStartMs : 0) / 1000;
    const end = start + (typeof raw.dDurationMs === 'number' ? raw.dDurationMs : 0) / 1000;
    if (cur && start - cur.start < span) {
      cur.text += ` ${text}`;
      cur.end = Math.max(cur.end, end);
    } else {
      if (cur) out.push(cur);
      cur = { start, end, text };
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ start: tenth(s.start), end: tenth(s.end), text: s.text }));
}
