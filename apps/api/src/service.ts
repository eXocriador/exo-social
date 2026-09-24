/**
 * Сервісний шар — ОДИН на обидва входи (REST `/v1/…`, MCP `/mcp` і його stdio).
 *
 * Порядок кожного виклику незмінний і стоїть тут, а не в транспортах:
 *   1. стеля продукту (до виклику, fail-open);
 *   2. область ключа (fail-closed);
 *   3. адаптер;
 *   4. бюджет відповіді;
 *   5. рядок обліку — і на успіх, і на відмову.
 * Транспорт лише розбирає аргументи й віддає результат.
 */
import {
  byteLength,
  clampLimit,
  fitChats,
  fitMessages,
  type ChatPage,
  type Limits,
  type Page,
} from './budget.js';
import { AdapterError, type Adapter, type AdapterRegistry } from './adapters/types.js';
import type { CallRecord, Ledger, Outcome } from './ledger.js';
import type { Quota } from './quota.js';
import { grantFor, isWildcard, ScopeUnavailable, type Grant, type ScopeStore } from './scope.js';
import { parseRef, type Conversation, type ConversationRef } from './shape.js';

export interface CallContext {
  product: string;
  transport: 'rest' | 'mcp';
}

export type ServiceErrorCode =
  | 'not_found'
  | 'bad_request'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'adapter_expired'
  | 'adapter_down'
  | 'scope_unavailable';

const STATUS: Record<ServiceErrorCode, number> = {
  not_found: 404,
  bad_request: 400,
  budget_exhausted: 429,
  rate_limited: 429,
  adapter_expired: 503,
  adapter_down: 503,
  scope_unavailable: 503,
};

export class ServiceError extends Error {
  readonly status: number;
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.status = STATUS[code];
  }
}

/** Та сама відповідь і на «немає», і на «поза областю»: різниця — підказка тому, хто перебирає. */
const NOT_FOUND = 'conversation not found or outside this key\'s scope — take refs from list_chats';

export interface ServiceDeps {
  adapters: AdapterRegistry;
  scope: ScopeStore;
  ledger: Ledger;
  quota: Quota;
  limits: Limits;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface ListChatsArgs {
  limit?: number | undefined;
  offset?: number | undefined;
}
export interface GetMessagesArgs {
  conversation: string;
  limit?: number | undefined;
  cursor?: string | undefined;
}
export interface SearchArgs {
  conversation: string;
  query: string;
  limit?: number | undefined;
}
export interface ByDateArgs {
  conversation: string;
  date: string;
  timezone?: string | undefined;
  limit?: number | undefined;
}

/** Розмов, які явний рядок області може назвати. Більше — вже не «список», а `*`. */
const MAX_EXPLICIT = 200;

export function createService(deps: ServiceDeps) {
  const { adapters, scope, ledger, quota, limits } = deps;

  interface Target {
    ref: ConversationRef;
    adapter: Adapter;
  }

  type Result<T> = { value: T; items: number; truncated: boolean };

  /**
   * Обгортка кожного інструмента: стеля, облік, переклад помилок. `body`
   * отримує вже прочитану область; `conversation` — лише для рядка обліку.
   */
  async function run<T>(
    ctx: CallContext,
    tool: string,
    conversation: string | null,
    body: (grants: Grant[]) => Promise<Result<T>>,
  ): Promise<T> {
    const started = Date.now();
    const parsed = conversation ? parseRef(conversation) : null;
    const base: Omit<CallRecord, 'outcome' | 'items' | 'bytes' | 'truncated' | 'latencyMs' | 'detail'> = {
      product: ctx.product,
      transport: ctx.transport,
      tool,
      adapter: parsed?.adapter ?? null,
      account: parsed?.account ?? null,
      conversation: conversation ? conversation.slice(0, 300) : null,
    };
    const finish = (outcome: Outcome, extra: Partial<CallRecord> = {}) =>
      void ledger.record({
        ...base,
        outcome,
        items: 0,
        bytes: 0,
        truncated: false,
        latencyMs: Date.now() - started,
        detail: null,
        ...extra,
      });

    const verdict = await quota.consume(ctx.product);
    if (!verdict.allowed) {
      finish('quota', { detail: `${verdict.used}/${verdict.cap}` });
      throw new ServiceError('budget_exhausted', `daily cap of ${verdict.cap} calls for this product is spent — degrade, do not retry today`);
    }

    try {
      const grants = await scope.grants(ctx.product, 'read');
      const out = await body(grants);
      finish('ok', { items: out.items, bytes: byteLength(out.value), truncated: out.truncated });
      return out.value;
    } catch (err) {
      const e = toServiceError(err);
      const outcome: Outcome =
        e.code === 'not_found'
          ? 'not_found'
          : e.code === 'bad_request'
            ? 'bad_request'
            : e.code === 'rate_limited'
              ? 'rate_limited'
              : e.code === 'adapter_expired'
                ? 'expired'
                : e.code === 'adapter_down' || e.code === 'scope_unavailable'
                  ? 'unavailable'
                  : 'error';
      finish(outcome, { detail: e.message });
      throw e;
    }
  }

  function toServiceError(err: unknown): ServiceError {
    if (err instanceof ServiceError) return err;
    if (err instanceof ScopeUnavailable) return new ServiceError('scope_unavailable', err.message);
    if (err instanceof AdapterError) {
      switch (err.kind) {
        case 'not_found':
          return new ServiceError('not_found', NOT_FOUND);
        case 'bad_request':
          return new ServiceError('bad_request', err.message);
        case 'rate_limited':
          return new ServiceError('rate_limited', `${err.message} — retry later`);
        case 'expired':
          return new ServiceError('adapter_expired', `adapter login rejected: ${err.message}`);
        case 'down':
          return new ServiceError('adapter_down', err.message);
      }
    }
    deps.logWarn?.('service.unexpected', { error: (err as Error)?.message });
    return new ServiceError('adapter_down', 'unexpected error');
  }

  /** ref → адаптер, якщо область його відкриває; інакше not_found. */
  function target(grants: Grant[], conversation: string): Target {
    const ref = parseRef(conversation);
    if (!ref) throw new ServiceError('bad_request', 'conversation must be a ref from list_chats (adapter:account:id)');
    const adapter = adapters.get(ref.adapter);
    if (!adapter || !grantFor(grants, ref)) throw new ServiceError('not_found', NOT_FOUND);
    return { ref, adapter };
  }

  function offsetOf(v: number | undefined): number {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.trunc(v), 100_000) : 0;
  }

  async function listChats(ctx: CallContext, args: ListChatsArgs): Promise<ChatPage> {
    return run(ctx, 'list_chats', null, async (grants) => {
      const limit = clampLimit(limits, args.limit, limits.maxItems);
      const offset = offsetOf(args.offset);
      const usable = grants.filter((g) => {
        const a = adapters.get(g.adapter);
        return a !== undefined && a.accounts.includes(g.account);
      });

      // Найчастіший випадок — один рядок `*`: сторінки йдуть прямо з адаптера.
      if (usable.length === 1 && isWildcard(usable[0]!)) {
        const g = usable[0]!;
        const batch = await adapters.get(g.adapter)!.listConversations(g.account, { limit, offset });
        const page = fitChats(limits, batch.conversations, {
          ...(batch.total !== null ? { total: batch.total } : {}),
          hasMore: batch.hasMore,
        });
        return { value: page, items: page.count, truncated: page.truncated };
      }

      // Кілька рядків: зібрати по порядку до offset+limit+1, без повторів.
      const need = offset + limit + 1;
      const seen = new Set<string>();
      const all: Conversation[] = [];
      let total = 0;
      const push = (c: Conversation) => {
        if (!seen.has(c.ref)) {
          seen.add(c.ref);
          all.push(c);
        }
      };
      for (const g of usable) {
        const adapter = adapters.get(g.adapter)!;
        if (isWildcard(g)) {
          let o = 0;
          for (;;) {
            const batch = await adapter.listConversations(g.account, { limit: limits.maxItems, offset: o });
            if (o === 0) total += batch.total ?? 0;
            batch.conversations.forEach(push);
            o += batch.conversations.length;
            if (!batch.hasMore || batch.conversations.length === 0 || all.length >= need) break;
          }
        } else {
          for (const full of g.conversations.slice(0, MAX_EXPLICIT)) {
            const ref = parseRef(full);
            if (!ref || ref.adapter !== g.adapter || ref.account !== g.account) continue;
            try {
              push(await adapter.getConversation(g.account, ref.id));
              total += 1;
            } catch (err) {
              // Розмова з області, якої акаунт адаптера вже не бачить, — не
              // помилка списку: її просто немає.
              if (!(err instanceof AdapterError && err.kind === 'not_found')) throw err;
            }
          }
        }
      }
      const slice = all.slice(offset, offset + limit);
      const page = fitChats(limits, slice, { total: Math.max(total, all.length), hasMore: all.length > offset + limit });
      return { value: page, items: page.count, truncated: page.truncated };
    });
  }

  async function getMessages(ctx: CallContext, args: GetMessagesArgs): Promise<Page & { conversation: string }> {
    return run(ctx, 'get_messages', args.conversation, async (grants) => {
      const t = target(grants, args.conversation);
      const limit = clampLimit(limits, args.limit, 30);
      const batch = await t.adapter.getMessages(t.ref.account, t.ref.id, { limit, cursor: args.cursor || null });
      const page = fitMessages(limits, batch.messages, {
        maybeMore: batch.maybeMore,
        cursorOf: (m) => t.adapter.cursorOf(m),
        extra: { conversation: args.conversation },
      });
      return { value: page, items: page.count, truncated: page.truncated };
    });
  }

  async function searchMessages(ctx: CallContext, args: SearchArgs): Promise<Page & { conversation: string; query: string }> {
    return run(ctx, 'search_messages', args.conversation, async (grants) => {
      const query = args.query.trim();
      if (!query) throw new ServiceError('bad_request', 'query is empty');
      const t = target(grants, args.conversation);
      const limit = clampLimit(limits, args.limit, 20);
      const batch = await t.adapter.searchMessages(t.ref.account, t.ref.id, query.slice(0, 200), limit);
      const page = fitMessages(limits, batch.messages, {
        maybeMore: batch.maybeMore,
        extra: { conversation: args.conversation, query: query.slice(0, 200) },
      });
      return { value: page, items: page.count, truncated: page.truncated };
    });
  }

  async function getMessagesByDate(
    ctx: CallContext,
    args: ByDateArgs,
  ): Promise<Page & { conversation: string; date: string; timezone: string }> {
    return run(ctx, 'get_messages_by_date', args.conversation, async (grants) => {
      const t = target(grants, args.conversation);
      const limit = clampLimit(limits, args.limit, limits.maxItems);
      const batch = await t.adapter.getMessagesByDate(t.ref.account, t.ref.id, {
        date: args.date,
        timezone: args.timezone ?? null,
        limit,
      });
      const page = fitMessages(limits, batch.messages, {
        maybeMore: batch.maybeMore,
        note: 'The day holds more messages than fit in one answer; the newest were dropped. Use get_messages with a cursor, or search_messages, for the rest.',
        extra: { conversation: args.conversation, date: args.date, timezone: batch.timezone },
      });
      return { value: page, items: page.count, truncated: page.truncated };
    });
  }

  /** Своя область — щоб продукт бачив, що йому відкрито, не питаючи людину. */
  async function ownScope(ctx: CallContext): Promise<{ product: string; read: Grant[]; write: Grant[] }> {
    try {
      const [read, write] = await Promise.all([scope.grants(ctx.product, 'read'), scope.grants(ctx.product, 'write')]);
      return { product: ctx.product, read, write };
    } catch (err) {
      throw toServiceError(err);
    }
  }

  async function usage(ctx: CallContext): Promise<{ product: string; usedToday: number | null; cap: number }> {
    return { product: ctx.product, usedToday: await quota.used(ctx.product), cap: quota.cap };
  }

  return { listChats, getMessages, searchMessages, getMessagesByDate, ownScope, usage };
}

export type Service = ReturnType<typeof createService>;
