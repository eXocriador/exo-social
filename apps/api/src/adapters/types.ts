/**
 * Інтерфейс адаптера — як `Publisher` в exopost
 * (`packages/publishers/exopost_publishers/base.py`): `verify` (тут — `probe`,
 * стан входу), `retryable` (тут — `AdapterError.kind`), реєстр за іменем.
 *
 * Адаптер — на ІНСТРУМЕНТ, не на платформу (connectors.md, схема): важка
 * робота лишається в готовому інструменті (tg-archive, мости mautrix, yt-dlp),
 * адаптер лише перекладає його відповідь у спільну форму (shape.ts). Політики
 * тут немає: ні області, ні обліку, ні бюджету — це service.ts, один раз на всі.
 */
import type { Conversation, Message } from '../shape.js';

/**
 * Стан входу адаптера.
 *   ok       — вхід живий, інструменти працюють;
 *   expired  — вхід відхилено (пароль змінено, сесія протухла, токен
 *              відкликано): сам не полагодиться, потрібна людина;
 *   down     — інструмент недосяжний (мережа, 5xx);
 *   unknown  — ще жодної проби (лише на старті, до першої відповіді).
 * Стеля частоти платформи (FloodWait, 429) — НЕ стан: це штатна подія, і вона
 * лише додає `limited` до поточного стану (connectors.md §3, «Здоров'я»).
 */
export type LoginState = 'ok' | 'expired' | 'down' | 'unknown';

export interface AccountHealth {
  adapter: string;
  account: string;
  state: LoginState;
  /** Людською мовою: що саме не так і що робити. */
  reason: string | null;
  /** Остання проба впала на стелю частоти — вироку вона не дала. */
  limited: boolean;
  checkedAt: string | null;
}

export type AdapterErrorKind =
  /** Розмови немає або акаунт адаптера її не бачить — невідрізненно, як у переглядачі. */
  | 'not_found'
  /** Вхід адаптера відхилено. */
  | 'expired'
  /** Інструмент недосяжний. */
  | 'down'
  /** Стеля частоти платформи: повторити пізніше. */
  | 'rate_limited'
  /** Аргумент не прийнято (курсор, дата, часовий пояс). */
  | 'bad_request';

export class AdapterError extends Error {
  constructor(
    readonly kind: AdapterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }

  /** Чи має сенс повторити той самий виклик пізніше. */
  get retryable(): boolean {
    return this.kind === 'down' || this.kind === 'rate_limited';
  }
}

export interface ChatList {
  conversations: Conversation[];
  total: number | null;
  hasMore: boolean;
}

export interface MessageBatch {
  messages: Message[];
  /** Прийшла повна сторінка — за нею можуть бути ще. */
  maybeMore: boolean;
}

export interface DayBatch extends MessageBatch {
  /** Часовий пояс, у якому взято день (відлуння аргументу або UTC). */
  timezone: string;
}

/**
 * Один адаптер. Методи приймають `id` розмови В АДАПТЕРІ (третя частина ref
 * шлюзу), а віддають розмови вже з повним ref шлюзу.
 */
export interface Adapter {
  readonly name: string;
  /** Акаунти адаптера, налаштовані в оточенні. */
  readonly accounts: readonly string[];

  /** Подивитись на вхід акаунта. Не кидає: результат — стан. */
  probe(account: string): Promise<AccountHealth>;
  /** Останній відомий стан, без мережі. */
  health(account: string): AccountHealth;

  listConversations(account: string, page: { limit: number; offset: number }): Promise<ChatList>;
  getConversation(account: string, id: string): Promise<Conversation>;
  /** Новіші першими. `cursor` — з `cursorOf` цього ж адаптера. */
  getMessages(account: string, id: string, page: { limit: number; cursor: string | null }): Promise<MessageBatch>;
  searchMessages(account: string, id: string, query: string, limit: number): Promise<MessageBatch>;
  /** Усі повідомлення одного календарного дня, старіші першими, не більше `limit`. */
  getMessagesByDate(account: string, id: string, day: { date: string; timezone: string | null; limit: number }): Promise<DayBatch>;
  /** Курсор на сторінку, старішу за це повідомлення. */
  cursorOf(m: Message): string;

  /** Відпустити вхід на зупинці (вихід із сесії), якщо адаптер це вміє. */
  close?(): Promise<void>;
}

export type AdapterRegistry = ReadonlyMap<string, Adapter>;

export function createRegistry(adapters: Adapter[]): AdapterRegistry {
  const map = new Map<string, Adapter>();
  for (const a of adapters) {
    if (map.has(a.name)) throw new Error(`адаптер «${a.name}» зареєстрований двічі`);
    map.set(a.name, a);
  }
  return map;
}
