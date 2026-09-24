/**
 * Сервісний шар: область (порожня за замовчуванням, `*`, список, fail-closed),
 * стеля (до виклику), облік (рядок і на відмову).
 */
import { describe, expect, it } from 'vitest';
import { AdapterError, createRegistry, type AccountHealth, type Adapter } from './adapters/types.js';
import type { CallRecord, Ledger } from './ledger.js';
import type { Quota } from './quota.js';
import { ScopeUnavailable, type Access, type Grant, type ScopeStore } from './scope.js';
import { createService, ServiceError } from './service.js';
import type { Conversation, Message } from './shape.js';

const A = 'telegram-archive';
const ref = (id: string) => `${A}:acc:${id}`;

function fakeAdapter(convs: string[], messagesPer = 3): Adapter {
  const health: AccountHealth = { adapter: A, account: 'acc', state: 'ok', reason: null, limited: false, checkedAt: null };
  const conv = (id: string): Conversation => ({ ref: ref(id), name: `chat ${id}`, type: 'group', platform: 'telegram' });
  const msgs = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({ id: n - i, date: `2026-09-01T10:00:0${i}Z`, text: `m${n - i}` }));
  const known = (id: string) => {
    if (!convs.includes(id)) throw new AdapterError('not_found', 'x');
  };
  return {
    name: A,
    accounts: ['acc'],
    health: () => health,
    probe: async () => health,
    listConversations: async (_acc, p) => ({
      conversations: convs.slice(p.offset, p.offset + p.limit).map(conv),
      total: convs.length,
      hasMore: p.offset + p.limit < convs.length,
    }),
    getConversation: async (_acc, id) => (known(id), conv(id)),
    getMessages: async (_acc, id, p) => (known(id), { messages: msgs(Math.min(p.limit, messagesPer)), maybeMore: p.limit <= messagesPer }),
    searchMessages: async (_acc, id) => (known(id), { messages: msgs(1), maybeMore: false }),
    getMessagesByDate: async (_acc, id) => (known(id), { messages: msgs(2), maybeMore: false, timezone: 'UTC' }),
    cursorOf: (m) => `c${m.id}`,
  };
}

function setup(opts: { grants?: Record<string, Grant[]>; scopeDown?: boolean; capLeft?: number; convs?: string[] } = {}) {
  const rows: CallRecord[] = [];
  const ledger: Ledger = { record: async (r) => void rows.push(r) };
  let used = 0;
  const quota: Quota = {
    cap: 10,
    consume: async () => ({ allowed: ++used <= (opts.capLeft ?? 10), used, cap: 10 }),
    used: async () => used,
  };
  const scope: ScopeStore = {
    grants: async (product: string, access: Access) => {
      if (opts.scopeDown) throw new ScopeUnavailable('error');
      return (opts.grants?.[product] ?? []).filter((g) => g.access === access);
    },
  };
  const service = createService({
    adapters: createRegistry([fakeAdapter(opts.convs ?? ['c1', 'c2', 'c3'])]),
    scope,
    ledger,
    quota,
    limits: { maxItems: 100, maxBytes: 32 << 10 },
  });
  return { service, rows };
}

const ctx = { product: 'claude', transport: 'mcp' as const };
const all: Grant = { adapter: A, account: 'acc', conversations: ['*'], access: 'read' };

// Облік пишеться fire-and-forget — дати мікрозадачам доїхати.
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('область', () => {
  it('новий продукт — порожня область, а не «усе»', async () => {
    const { service } = setup();
    const page = await service.listChats(ctx, {});
    expect(page.conversations).toEqual([]);
    await expect(service.getMessages(ctx, { conversation: ref('c1') })).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('`*` — усе, що бачить акаунт адаптера', async () => {
    const { service } = setup({ grants: { claude: [all] } });
    const page = await service.listChats(ctx, {});
    expect(page.conversations.map((c) => c.ref)).toEqual([ref('c1'), ref('c2'), ref('c3')]);
    expect(page.total).toBe(3);
    const msgs = await service.getMessages(ctx, { conversation: ref('c2') });
    expect(msgs.conversation).toBe(ref('c2'));
    expect(msgs.count).toBe(3);
  });

  it('список ref — рівно ці, решта «не знайдено» з тим самим текстом', async () => {
    const { service } = setup({ grants: { claude: [{ ...all, conversations: [ref('c2')] }] } });
    const page = await service.listChats(ctx, {});
    expect(page.conversations.map((c) => c.ref)).toEqual([ref('c2')]);
    const outside = await service.getMessages(ctx, { conversation: ref('c1') }).catch((e: ServiceError) => e.message);
    const missing = await service.getMessages(ctx, { conversation: ref('zz') }).catch((e: ServiceError) => e.message);
    expect(outside).toBe(missing);
  });

  it('область одного продукту не відкриває нічого іншому', async () => {
    const { service } = setup({ grants: { other: [all] } });
    expect((await service.listChats(ctx, {})).count).toBe(0);
  });

  it('write-рядок не дає читати', async () => {
    const { service } = setup({ grants: { claude: [{ ...all, access: 'write' }] } });
    await expect(service.getMessages(ctx, { conversation: ref('c1') })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('БД не відповіла — відмова 503, а не «усе» і не «нічого»', async () => {
    const { service, rows } = setup({ scopeDown: true });
    await expect(service.listChats(ctx, {})).rejects.toMatchObject({ code: 'scope_unavailable', status: 503 });
    await settle();
    expect(rows[0]!.outcome).toBe('unavailable');
  });

  it('не-ref — bad_request', async () => {
    const { service } = setup({ grants: { claude: [all] } });
    await expect(service.getMessages(ctx, { conversation: '12345' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('стеля і облік', () => {
  it('рядок обліку на успіх: продукт, адаптер, акаунт, розмова, інструмент, елементи, байти, обрізано', async () => {
    const { service, rows } = setup({ grants: { claude: [all] } });
    const page = await service.getMessages(ctx, { conversation: ref('c1'), limit: 2 });
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      product: 'claude',
      transport: 'mcp',
      tool: 'get_messages',
      adapter: A,
      account: 'acc',
      conversation: ref('c1'),
      outcome: 'ok',
      items: 2,
      truncated: true,
    });
    expect(rows[0]!.bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
  });

  it('рядок і на відмову області', async () => {
    const { service, rows } = setup();
    await service.getMessages(ctx, { conversation: ref('c1') }).catch(() => {});
    await settle();
    expect(rows[0]).toMatchObject({ outcome: 'not_found', items: 0, conversation: ref('c1') });
  });

  it('стеля рахується ДО виклику: вичерпана — 429 і рядок quota, адаптер не кликаний', async () => {
    const { service, rows } = setup({ grants: { claude: [all] }, capLeft: 1 });
    await service.listChats(ctx, {});
    await expect(service.listChats(ctx, {})).rejects.toMatchObject({ code: 'budget_exhausted', status: 429 });
    await settle();
    expect(rows.map((r) => r.outcome)).toEqual(['ok', 'quota']);
  });

  it('get_messages_by_date і search_messages проходять ту саму область', async () => {
    const { service } = setup({ grants: { claude: [all] } });
    const day = await service.getMessagesByDate(ctx, { conversation: ref('c1'), date: '2026-09-01' });
    expect(day).toMatchObject({ date: '2026-09-01', timezone: 'UTC', count: 2 });
    const found = await service.searchMessages(ctx, { conversation: ref('c1'), query: 'm1' });
    expect(found.count).toBe(1);
    await expect(service.searchMessages(ctx, { conversation: ref('c1'), query: '  ' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
