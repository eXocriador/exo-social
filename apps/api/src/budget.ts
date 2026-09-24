/**
 * Бюджет відповіді — один на всі адаптери (connectors.md §3).
 *
 * Перенесення `internal/budget` — нашого власного доповнення до форку
 * telegram-archive-mcp (коміт eXocriador 2026-09-23; решта форку — апстрім під
 * GPL-3.0, і сюди вона не переноситься). Автор той самий, тож тут — MIT. Та
 * сама причина: модель, що просить «останні 5000 повідомлень» великого чату,
 * отримала б мегабайт, і результат інструмента витіснив би з контексту все
 * інше (заміряно на чаті в 10 тис. повідомлень: 75 тис. токенів без бюджету,
 * 3,3 тис. із ним). Тому відповідь обмежена і кількістю, і байтами; обрізана
 * каже `truncated`, пояснює `note` і дає курсор `next`, а не мовчить.
 *
 * Що змінилось проти Go-версії, і чому:
 *   • Байти рахуються ТОЧНО, а не «конверт ≈ 160»: резерв під конверт
 *     береться з найгіршого випадку (обрізано, є `note` і `next`), тож
 *     відповідь не виходить за стелю навіть на межі.
 *   • Укорочення першого повідомлення повторюється, доки воно справді не
 *     влізе: екранування JSON (`\"`, `\uXXXX`) робить байти тексту і байти
 *     серіалізованого рядка різними.
 *   • Проєкції `raw_data` → компактне тут немає: її робить адаптер, бо лише
 *     він знає свою сиру форму. Бюджет бачить уже спільну форму (shape.ts).
 */
import type { Conversation, Message, Segment } from './shape.js';

export interface Limits {
  /** Найбільше елементів в одній відповіді, хоч би скільки попросили. */
  maxItems: number;
  /** Найбільше байтів серіалізованої відповіді (компактний JSON). */
  maxBytes: number;
}

/** ~100 коротких повідомлень або ~32 КБ (8–10 тис. токенів) — що настане раніше. */
export const DEFAULT_LIMITS: Limits = { maxItems: 100, maxBytes: 32 << 10 };

/** Скільки просити в адаптера: значення викликача (або `def`), не більше maxItems. */
export function clampLimit(limits: Limits, requested: number | null | undefined, def: number): number {
  let n = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : def;
  if (n > limits.maxItems) n = limits.maxItems;
  return n;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export const NOTE_CURSOR =
  'More messages exist than fit in one answer. Narrow the question (search, a date) or page with cursor=next — do not read the whole conversation.';
export const NOTE_NARROW = 'More messages exist than fit in one answer. Narrow the query.';
export const NOTE_CHATS = 'More conversations exist than fit in one answer. Page with offset.';

/** Сторінка повідомлень — те, що віддають інструменти повідомлень. */
export interface Page {
  count: number;
  truncated: boolean;
  /** Непрозорий курсор на наступну (старішу) сторінку. */
  next?: string;
  note?: string;
  messages: Message[];
}

export interface FitOptions<E extends object> {
  /**
   * Адаптер каже, що за цими рядками можуть бути ще (прийшла повна сторінка).
   * Разом з обрізанням це дає курсор, узятий з останнього збереженого.
   */
  maybeMore: boolean;
  /** Як з повідомлення зробити курсор на наступну сторінку. Немає — курсора немає. */
  cursorOf?: ((m: Message) => string) | undefined;
  /** Своя примітка на обрізання (get_messages_by_date). */
  note?: string | undefined;
  /** Поля інструмента, що йдуть перед сторінкою (`conversation`, `date`…) — теж у бюджеті. */
  extra?: E | undefined;
}

/**
 * Найдовший курсор, під який резервуються байти, коли його ще не видно.
 * 512, а не 256 (з 2026-09-24, адаптер youtube): курсор коментарів несе
 * pageToken Data API, а той сам буває за 200 символів.
 */
const CURSOR_RESERVE = 512;

/**
 * Скласти обмежену сторінку, зберігаючи рядки з ПОЧАТКУ. Рядки мають іти в
 * порядку, у якому рухається курсор (для get_messages — новіші першими).
 */
export function fitMessages<E extends object = Record<never, never>>(
  limits: Limits,
  rows: Message[],
  opts: FitOptions<E>,
): E & Page {
  const withCursor = typeof opts.cursorOf === 'function';
  const note = opts.note ?? (withCursor ? NOTE_CURSOR : NOTE_NARROW);
  const extra = (opts.extra ?? {}) as E;
  // Найгірший конверт: обрізано, примітка, курсор. Байти під нього — наперед.
  const envelope = byteLength({
    ...extra,
    count: limits.maxItems,
    truncated: true,
    ...(withCursor ? { next: 'x'.repeat(CURSOR_RESERVE) } : {}),
    note,
    messages: [],
  });

  const kept: Message[] = [];
  let used = envelope;
  let truncated = false;

  for (let i = 0; i < rows.length; i++) {
    if (kept.length >= limits.maxItems) {
      truncated = true;
      break;
    }
    let item = rows[i]!;
    // Кома між елементами (для першого — запас у 1 байт).
    let size = byteLength(item) + 1;
    if (used + size > limits.maxBytes) {
      // Перше повідомлення потрапляє ЗАВЖДИ, укорочене, якщо мусить: порожня
      // сторінка не дала б викликачеві курсора, з яким рухатись далі.
      if (kept.length === 0) {
        item = shorten(item, limits.maxBytes - used - 1);
        size = byteLength(item) + 1;
      } else {
        truncated = true;
        break;
      }
    }
    used += size;
    kept.push(item);
    if (i === rows.length - 1 && opts.maybeMore) truncated = true;
  }

  let next: string | undefined;
  if (withCursor && truncated && kept.length > 0) {
    const candidate = opts.cursorOf!(kept[kept.length - 1]!);
    // Курсор довший за резерв пробив би стелю. Без нього сторінка лишається
    // чесною (truncated + note); зламаний бюджет — ні.
    if (candidate.length <= CURSOR_RESERVE) next = candidate;
  }
  return {
    ...extra,
    count: kept.length,
    truncated,
    ...(next !== undefined ? { next } : {}),
    ...(truncated ? { note } : {}),
    messages: kept,
  };
}

/** Укоротити текст так, щоб серіалізоване повідомлення влізло в `max` байтів. */
export function shorten(m: Message, max: number): Message {
  if (byteLength(m) <= max) return m;
  const text = Buffer.from(m.text ?? '', 'utf8');
  let keep = text.length - (byteLength(m) - max) - 16;
  for (;;) {
    if (keep < 0) keep = 0;
    // Назад до початку символу UTF-8: інакше розрізаний символ став би �.
    while (keep > 0 && (text[keep]! & 0xc0) === 0x80) keep--;
    const out: Message = { ...m, text: text.subarray(0, keep).toString('utf8') + '…', cut: true };
    const over = byteLength(out) - max;
    if (over <= 0 || keep === 0) return out;
    keep -= Math.max(over, 1);
  }
}

export const NOTE_TRANSCRIPT =
  'The transcript is longer than fits in one answer. Page with cursor=next — or stop once the question is answered.';

/** Сторінка транскрипту. */
export interface SegmentPage {
  count: number;
  truncated: boolean;
  next?: string;
  note?: string;
  segments: Segment[];
}

/**
 * Обмежити транскрипт тими самими стелями. Сегмент (≤ 30 с мовлення, сотні
 * байтів) сам по собі стелі не пробиває, тож укорочення тут немає; перший
 * потрапляє завжди — інакше курсора не було б.
 */
export function fitSegments<E extends object>(
  limits: Limits,
  rows: Segment[],
  opts: { cursorAfter: (i: number) => string; extra: E },
): E & SegmentPage {
  let used = byteLength({
    ...opts.extra,
    count: limits.maxItems,
    truncated: true,
    next: 'x'.repeat(CURSOR_RESERVE),
    note: NOTE_TRANSCRIPT,
    segments: [],
  });
  const kept: Segment[] = [];
  let truncated = false;
  for (const row of rows) {
    const size = byteLength(row) + 1;
    if (kept.length > 0 && (kept.length >= limits.maxItems || used + size > limits.maxBytes)) {
      truncated = true;
      break;
    }
    used += size;
    kept.push(row);
  }
  const next = truncated ? opts.cursorAfter(kept.length - 1) : undefined;
  return {
    ...opts.extra,
    count: kept.length,
    truncated,
    ...(next !== undefined && next.length <= CURSOR_RESERVE ? { next } : {}),
    ...(truncated ? { note: NOTE_TRANSCRIPT } : {}),
    segments: kept,
  };
}

/** Сторінка розмов. */
export interface ChatPage {
  total?: number;
  count: number;
  truncated: boolean;
  note?: string;
  conversations: Conversation[];
}

/** Обмежити список розмов тими самими стелями. */
export function fitChats(limits: Limits, rows: Conversation[], opts: { total?: number; hasMore: boolean }): ChatPage {
  let used = byteLength({ total: opts.total ?? 0, count: limits.maxItems, truncated: true, note: NOTE_CHATS, conversations: [] });
  const kept: Conversation[] = [];
  let truncated = false;
  for (const row of rows) {
    const size = byteLength(row) + 1;
    if (kept.length >= limits.maxItems || used + size > limits.maxBytes) {
      truncated = true;
      break;
    }
    used += size;
    kept.push(row);
  }
  truncated = truncated || opts.hasMore;
  return {
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    count: kept.length,
    truncated,
    ...(truncated ? { note: NOTE_CHATS } : {}),
    conversations: kept,
  };
}

/** Довільний текст (тіло помилки апстріму) — до стелі байтів, по межі символу. */
export function cutText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = Math.max(0, maxBytes - 64);
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString('utf8') + '\n…[truncated: answer exceeded the context budget]';
}
