/**
 * HTTP: проби (вхід адаптера валить ready), ключ на REST і MCP, MCP через
 * справжній SDK-транспорт.
 */
import { describe, expect, it } from 'vitest';
import { createRegistry, type AccountHealth, type Adapter, type LoginState } from './adapters/types.js';
import { createAdapterHealth } from './health.js';
import { parseProductKeys } from './keys.js';
import { buildServer } from './server.js';
import { createService } from './service.js';
import type { Grant } from './scope.js';

const A = 'telegram-archive';
const KEY = 'relic-claude-0123456789abcdef';

function adapterIn(state: { value: LoginState }): Adapter {
  const h = (): AccountHealth => ({
    adapter: A,
    account: 'acc',
    state: state.value,
    reason: state.value === 'expired' ? 'переглядач відхилив вхід' : null,
    limited: false,
    checkedAt: '2026-09-24T00:00:00.000Z',
  });
  return {
    name: A,
    accounts: ['acc'],
    health: h,
    probe: async () => h(),
    listConversations: async () => ({
      conversations: [{ ref: `${A}:acc:R1`, name: 'one', type: 'group', platform: 'telegram' }],
      total: 1,
      hasMore: false,
    }),
    getConversation: async () => ({ ref: `${A}:acc:R1`, name: 'one', type: 'group', platform: 'telegram' }),
    getMessages: async () => ({ messages: [{ id: 1, date: '2026-09-01T00:00:00Z', text: 'hi' }], maybeMore: false }),
    searchMessages: async () => ({ messages: [], maybeMore: false }),
    getMessagesByDate: async () => ({ messages: [], maybeMore: false, timezone: 'UTC' }),
    cursorOf: () => 'c',
  };
}

function app(state: { value: LoginState }, grants: Grant[] = [], pg = true) {
  const adapters = createRegistry([adapterIn(state)]);
  const service = createService({
    adapters,
    scope: { grants: async (_p, access) => grants.filter((g) => g.access === access) },
    ledger: { record: async () => {} },
    quota: { cap: 10, consume: async () => ({ allowed: true, used: 1, cap: 10 }), used: async () => 1 },
    limits: { maxItems: 100, maxBytes: 32 << 10 },
  });
  return buildServer({
    version: 'abc1234',
    keys: parseProductKeys(`claude:${KEY}`),
    service,
    adapterHealth: createAdapterHealth({ adapters, intervalMs: 60_000 }),
    checks: { postgres: async () => pg, redis: async () => 'skip' as const },
    required: ['postgres'],
    logger: false,
  });
}

const auth = { authorization: `Bearer ${KEY}` };
const all: Grant = { adapter: A, account: 'acc', conversations: ['*'], access: 'read' };

describe('проби', () => {
  it('/health/live — 200 і version з образу, без жодної залежності', async () => {
    const r = await app({ value: 'expired' }, [], false).inject({ url: '/health/live' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: 'abc1234' });
  });

  it('/health/ready — 200 і checks.telegram-archive = ok', async () => {
    const r = await app({ value: 'ok' }).inject({ url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', version: 'abc1234', checks: { postgres: 'ok', redis: 'skip', [A]: 'ok' } });
  });

  // Вада exo-ai, яку не копіюємо: протухлий вхід там лишав монітор зеленим.
  it('вхід адаптера відхилено — 503, і монітор це бачить', async () => {
    const r = await app({ value: 'expired' }).inject({ url: '/health/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: 'fail', checks: { [A]: 'expired' } });
  });

  it('переглядач лежить — 503 з down', async () => {
    const r = await app({ value: 'down' }).inject({ url: '/health/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json().checks[A]).toBe('down');
  });

  it('перемикання наживо: ok → expired → ok без рестарту', async () => {
    const state = { value: 'ok' as LoginState };
    const a = app(state);
    expect((await a.inject({ url: '/health/ready' })).statusCode).toBe(200);
    state.value = 'expired';
    expect((await a.inject({ url: '/health/ready' })).statusCode).toBe(503);
    state.value = 'ok';
    expect((await a.inject({ url: '/health/ready' })).statusCode).toBe(200);
  });

  it('Postgres лежить — 503 (без області шлюз лише відмовляє)', async () => {
    const r = await app({ value: 'ok' }, [], false).inject({ url: '/health/ready' });
    expect(r.statusCode).toBe(503);
  });

  it('/v1/adapters — стан з причиною', async () => {
    const r = await app({ value: 'expired' }).inject({ url: '/v1/adapters', headers: auth });
    expect(r.json().adapters[0]).toMatchObject({ adapter: A, account: 'acc', state: 'expired', reason: 'переглядач відхилив вхід' });
  });
});

describe('ключ', () => {
  it('без ключа і з чужим — 401 з одним текстом, і на REST, і на /mcp', async () => {
    const a = app({ value: 'ok' });
    for (const url of ['/v1/conversations', '/mcp']) {
      const none = await a.inject({ method: url === '/mcp' ? 'POST' : 'GET', url });
      const wrong = await a.inject({ method: url === '/mcp' ? 'POST' : 'GET', url, headers: { authorization: 'Bearer nope' } });
      expect(none.statusCode).toBe(401);
      expect(wrong.json()).toEqual(none.json());
    }
  });

  it('REST: область застосовується так само, як у MCP', async () => {
    const empty = await app({ value: 'ok' }).inject({ url: '/v1/conversations', headers: auth });
    expect(empty.json().conversations).toEqual([]);
    const open = await app({ value: 'ok' }, [all]).inject({ url: '/v1/conversations', headers: auth });
    expect(open.json().conversations).toHaveLength(1);
    const msgs = await app({ value: 'ok' }, [all]).inject({ url: `/v1/conversations/${A}:acc:R1/messages`, headers: auth });
    expect(msgs.json()).toMatchObject({ conversation: `${A}:acc:R1`, count: 1 });
    const denied = await app({ value: 'ok' }).inject({ url: `/v1/conversations/${A}:acc:R1/messages`, headers: auth });
    expect(denied.statusCode).toBe(404);
  });
});

describe('MCP (Streamable HTTP, stateless)', () => {
  const rpc = (a: ReturnType<typeof app>, body: unknown) =>
    a.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: body as Record<string, unknown>,
    });

  it('initialize → tools/list: чотири інструменти читання, запису немає', async () => {
    const a = app({ value: 'ok' }, [all]);
    const init = await rpc(a, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('relic');
    const list = await rpc(a, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.json().result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['get_messages', 'get_messages_by_date', 'list_chats', 'search_messages']);
  });

  it('tools/call list_chats — область ключа', async () => {
    const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_chats', arguments: {} } };
    const open = await rpc(app({ value: 'ok' }, [all]), call);
    expect(JSON.parse(open.json().result.content[0].text).conversations).toHaveLength(1);
    const empty = await rpc(app({ value: 'ok' }), call);
    expect(JSON.parse(empty.json().result.content[0].text).conversations).toEqual([]);
  });

  it('tools/call поза областю — isError з not_found', async () => {
    const r = await rpc(app({ value: 'ok' }), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_messages', arguments: { conversation: `${A}:acc:R1` } },
    });
    expect(r.json().result.isError).toBe(true);
    expect(JSON.parse(r.json().result.content[0].text).error).toBe('not_found');
  });
});
