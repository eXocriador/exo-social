/**
 * Адаптер `telegram-archive` — Telegram через архів tg-archive.
 *
 * Читає HTTP API переглядача під ОКРЕМИМ акаунтом переглядача, заведеним з
 * `allowed_chat_refs: []`. Два рівні білого списку свідомо:
 *   • акаунт переглядача — що шлюзу взагалі видно з Telegram (власник
 *     відмічає чати в адмінці переглядача);
 *   • область ключа (social_scope) — що з цього видно конкретному продукту.
 * Сесію Telethon шлюз не чіпає і не бачить: вона в томі tg-archive, куди
 * ходить лише backup.
 *
 * Ref шлюзу — `telegram-archive:<акаунт>:<ref переглядача>`. Ref переглядача —
 * непрозорі 22 символи (`secrets.token_urlsafe(16)`), стабільні на все життя
 * рядка; числовий id чату назовні не йде зовсім.
 */
import { decodeCursor, encodeCursor, formatRef, type Conversation, type Message } from '../../shape.js';
import { assertTimeZone, dayBounds, parseArchiveTime, TimeArgError, toIsoUtc, toNaiveUtc } from '../../time.js';
import {
  AdapterError,
  type AccountHealth,
  type Adapter,
  type ChatList,
  type DayBatch,
  type MessageBatch,
} from '../types.js';
import { ViewerClient, type ViewerClientOptions } from './client.js';

export const NAME = 'telegram-archive';

/** Сирі сторінки, якими ходить обхід дня; назовні йде вже обмежене бюджетом. */
const DAY_PAGE = 500;

export interface TelegramArchiveOptions extends ViewerClientOptions {
  account: string;
}

// ── нормалізація у спільну форму ────────────────────────────────────────────

interface ArchiveRow {
  id?: unknown;
  date?: unknown;
  text?: unknown;
  sender_name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  reply_to_msg_id?: unknown;
  reply_to_top_id?: unknown;
  forward_from_id?: unknown;
  edit_date?: unknown;
  is_outgoing?: unknown;
  is_deleted?: unknown;
  is_pinned?: unknown;
  media?: { type?: unknown; file_name?: unknown } | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null);
/** Архів віддає 0/1 так само часто, як true/false. */
const truthy = (v: unknown): boolean => v === true || (typeof v === 'number' && v !== 0) || v === '1' || v === 'true';

/**
 * Рядок архіву → повідомлення §3. `raw_data` Telethon, шляхи медіа, колонки
 * відправника — геть: 1–3 КБ на повідомлення, яких читачеві не треба.
 */
export function toMessage(raw: unknown): Message | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as ArchiveRow;
  const id = int(r.id);
  const date = str(r.date);
  if (id === null || !date) return null;
  const m: Message = { id, date: toIsoUtc(date) };
  const from =
    str(r.sender_name) ||
    `${str(r.first_name)} ${str(r.last_name)}`.trim() ||
    (str(r.username) ? `@${str(r.username)}` : '');
  if (from) m.from = from;
  if (truthy(r.is_outgoing)) m.out = true;
  const text = str(r.text);
  if (text) m.text = text;
  const reply = int(r.reply_to_msg_id);
  if (reply !== null) m.reply_to = reply;
  const topic = int(r.reply_to_top_id);
  if (topic !== null) m.topic = topic;
  const mediaType = r.media ? str(r.media.type) : '';
  if (mediaType) m.media = str(r.media?.file_name) ? `${mediaType}: ${str(r.media?.file_name)}` : mediaType;
  if (int(r.forward_from_id) !== null) m.fwd = true;
  if (str(r.edit_date)) m.edited = true;
  if (truthy(r.is_deleted)) m.deleted = true;
  if (truthy(r.is_pinned)) m.pinned = true;
  return m;
}

interface ChatRow {
  ref?: unknown;
  type?: unknown;
  title?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  last_message_date?: unknown;
  participants_count?: unknown;
}

export function toConversation(account: string, raw: unknown): Conversation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as ChatRow;
  const ref = str(r.ref);
  if (!ref) return null;
  const c: Conversation = {
    ref: formatRef({ adapter: NAME, account, id: ref }),
    name: str(r.title) || `${str(r.first_name)} ${str(r.last_name)}`.trim() || (str(r.username) ? `@${str(r.username)}` : ref),
    type: str(r.type) || 'unknown',
    platform: 'telegram',
  };
  if (str(r.last_message_date)) c.last_message = toIsoUtc(str(r.last_message_date));
  const participants = int(r.participants_count);
  if (participants !== null) c.participants = participants;
  return c;
}

function rowsOf(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new AdapterError('down', 'переглядач віддав не список повідомлень');
  return body;
}

// ── курсор ─────────────────────────────────────────────────────────────────

interface Cursor {
  d: string;
  i: number;
}

const isCursor = (v: unknown): v is Cursor =>
  typeof v === 'object' && v !== null && typeof (v as Cursor).d === 'string' && Number.isInteger((v as Cursor).i);

// ── адаптер ────────────────────────────────────────────────────────────────

export function createTelegramArchive(opts: TelegramArchiveOptions): Adapter {
  const client = new ViewerClient(opts);
  const now = opts.now ?? Date.now;
  let health: AccountHealth = {
    adapter: NAME,
    account: opts.account,
    state: 'unknown',
    reason: 'ще жодної проби',
    limited: false,
    checkedAt: null,
  };

  function mark(state: AccountHealth['state'], reason: string | null, limited = false): AccountHealth {
    health = { ...health, state, reason, limited, checkedAt: new Date(now()).toISOString() };
    return health;
  }

  /** Кожен виклик — теж свідок стану входу: відмова видна одразу, не за хвилину. */
  async function observed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      if (health.state !== 'ok') mark('ok', null);
      return out;
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.kind === 'expired') mark('expired', err.message);
        else if (err.kind === 'down') mark('down', err.message);
        else if (err.kind === 'rate_limited') health = { ...health, limited: true };
      }
      throw err;
    }
  }

  function own(account: string): void {
    // Чужий акаунт — не «помилка конфігу», а просто розмова, якої тут немає.
    if (account !== opts.account) throw new AdapterError('not_found', 'розмови немає або вона поза областю');
  }

  const messages = (id: string, query: Record<string, string | number | undefined>) =>
    observed(async () => rowsOf(await client.get(`/api/chats/${encodeURIComponent(id)}/messages`, query)));

  return {
    name: NAME,
    accounts: [opts.account],

    health: () => health,

    async probe() {
      try {
        if (client.hasSession && (await client.sessionAlive())) return mark('ok', null);
        await client.login(true);
        return mark('ok', null);
      } catch (err) {
        if (err instanceof AdapterError) {
          if (err.kind === 'expired') return mark('expired', err.message);
          // Стеля входів — не вирок: стан лишається, яким був.
          if (err.kind === 'rate_limited') return (health = { ...health, limited: true, reason: err.message });
          return mark('down', err.message);
        }
        return mark('down', (err as Error).message);
      }
    },

    async listConversations(account, page): Promise<ChatList> {
      own(account);
      const body = (await observed(() => client.get('/api/chats', { limit: page.limit, offset: page.offset }))) as {
        chats?: unknown;
        total?: unknown;
        has_more?: unknown;
      };
      if (!Array.isArray(body.chats)) throw new AdapterError('down', 'переглядач віддав не список чатів');
      return {
        conversations: body.chats.map((c) => toConversation(opts.account, c)).filter((c): c is Conversation => c !== null),
        total: typeof body.total === 'number' ? body.total : null,
        hasMore: body.has_more === true,
      };
    },

    async getConversation(account, id) {
      own(account);
      const c = toConversation(opts.account, await observed(() => client.get(`/api/chats/${encodeURIComponent(id)}`)));
      if (!c) throw new AdapterError('not_found', 'розмови немає або вона поза областю');
      return c;
    },

    async getMessages(account, id, page): Promise<MessageBatch> {
      own(account);
      let cursor: Cursor | null = null;
      if (page.cursor) {
        cursor = decodeCursor(page.cursor, isCursor);
        if (!cursor) throw new AdapterError('bad_request', 'cursor не з цього адаптера — беріть next з попередньої відповіді');
      }
      const rows = await messages(id, {
        limit: page.limit,
        before_date: cursor?.d,
        before_id: cursor?.i,
      });
      return { messages: rows.map(toMessage).filter((m): m is Message => m !== null), maybeMore: rows.length >= page.limit };
    },

    async searchMessages(account, id, query, limit): Promise<MessageBatch> {
      own(account);
      const rows = await messages(id, { search: query, limit });
      return { messages: rows.map(toMessage).filter((m): m is Message => m !== null), maybeMore: rows.length >= limit };
    },

    async getMessagesByDate(account, id, day): Promise<DayBatch> {
      own(account);
      const tz = day.timezone || 'UTC';
      let bounds: { start: number; end: number };
      try {
        assertTimeZone(tz);
        bounds = dayBounds(day.date, tz);
      } catch (err) {
        if (err instanceof TimeArgError) throw new AdapterError('bad_request', err.message);
        throw err;
      }
      const { rows, truncated } = await collectDay(bounds, day.limit, (cur) =>
        messages(id, { limit: DAY_PAGE, before_date: cur.date, before_id: cur.id || undefined }),
      );
      return {
        messages: rows.map(toMessage).filter((m): m is Message => m !== null),
        maybeMore: truncated,
        timezone: tz,
      };
    },

    cursorOf(m) {
      return encodeCursor({ d: m.date, i: Number(m.id) } satisfies Cursor);
    },

    async close() {
      await client.logout();
    },
  };
}

/**
 * Обхід одного дня. Власна реалізація: апстрім telegram-archive-mcp вміє те
 * саме (GPL-3.0), але його код сюди не переноситься — relic під MIT.
 *
 * Переглядач віддає сторінки новіші першими і гортає ключовим курсором
 * (`before_date` + `before_id`). Тож день читається ЗАДОМ НАПЕРЕД: від його
 * кінця до першого повідомлення, старшого за початок. З вікна [start, end)
 * тримається не більше `limit` рядків, і це найстаріші: кожен новий рядок
 * обходу старший за всі взяті, тож надлишок відпадає з «нового» кінця черги.
 * Пам'ять — `limit` рядків плюс множина вже бачених id.
 *
 * Зупинка — будь-що з трьох: сторінка порожня; трапився рядок старший за
 * початок дня; сторінка не принесла жодного нового id (API проігнорував
 * курсор — без цього обхід крутився б вічно).
 */
export async function collectDay(
  bounds: { start: number; end: number },
  limit: number,
  page: (cur: { date: string; id: number }) => Promise<unknown[]>,
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const window: unknown[] = []; // у порядку обходу: від новіших до старіших
  const seen = new Set<number>();
  let overflow = false;
  let cursor = { date: toNaiveUtc(bounds.end), id: 0 };

  for (;;) {
    const rows = await page(cursor);
    let fresh: { id: number; date: string } | null = null;
    let pastStart = false;

    for (const raw of rows) {
      const r = raw as { id?: unknown; date?: unknown };
      const id = typeof r.id === 'number' ? r.id : NaN;
      const date = typeof r.date === 'string' ? r.date : '';
      const at = parseArchiveTime(date);
      if (at === null) throw new AdapterError('down', `переглядач віддав дату, якої не розібрати: ${date.slice(0, 40)}`);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      fresh = { id, date };
      if (at < bounds.start) {
        pastStart = true;
        break;
      }
      if (at >= bounds.end) continue;
      window.push(raw);
      if (window.length > limit) {
        window.shift();
        overflow = true;
      }
    }

    if (rows.length === 0 || pastStart || fresh === null) break;
    cursor = fresh;
  }

  return { rows: window.reverse(), truncated: overflow };
}
