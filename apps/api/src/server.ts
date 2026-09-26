/**
 * HTTP: REST `/v1/…` для продуктів і `/mcp` (Streamable HTTP) для моделей —
 * на одному порту, з одними ключами (connectors.md §3).
 *
 * Усе, що ходить у мережу чи базу, приходить аргументом — тож server.test.ts
 * ганяється без Постгресу, Redis і переглядача. Справжні дроти — в index.ts.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createHealth, type HealthCheck } from '@exo/kit/health';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AdapterHealth } from './health.js';
import { failsReady } from './health.js';
import { readKey, type ProductKeys } from './keys.js';
import { buildMcpServer } from './mcp.js';
import { ServiceError, type CallContext, type Service } from './service.js';

export interface BuildServerOptions {
  version: string;
  keys: ProductKeys;
  service: Service;
  adapterHealth: AdapterHealth;
  /** Ім'я → перевірка інфраструктури (postgres, redis). */
  checks: Record<string, HealthCheck>;
  /** Які з них валять пробу. Postgres — так: без області шлюз лише відмовляє. */
  required: string[];
  logger?: boolean;
  logLevel?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    product: string | null;
  }
}

function int(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { version, keys, service, adapterHealth, checks, required, logger = true } = options;
  const app = Fastify({
    logger: logger ? { level: options.logLevel ?? 'info' } : false,
    bodyLimit: 1_000_000,
  });

  // ── здоров'я: першим і поза ключами ──────────────────────────────────────
  const infra = createHealth({ version, checks, required });
  app.get('/health/live', async (_request, reply) => {
    const res = infra.live();
    return reply.code(res.status).header('cache-control', 'no-store').send(await res.json());
  });
  app.get('/health/ready', async (_request, reply) => {
    const res = await infra.ready();
    const body = (await res.json()) as { status: string; version: string; checks: Record<string, string> };
    // Вхід адаптера — поруч з інфраструктурою, своїми словами: ok / expired / down.
    const adapters = adapterHealth.states();
    let ok = res.status === 200;
    for (const [name, state] of Object.entries(adapters)) {
      body.checks[name] = state;
      if (failsReady(state)) ok = false;
    }
    // Доступ — поруч, але не вирок готовності: порожній доступ законний до
    // рішення власника. Видно `status: "degraded"` при 200.
    let degraded = false;
    for (const [name, state] of Object.entries(adapterHealth.accessStates())) {
      body.checks[name] = state;
      if (state === 'degraded') degraded = true;
    }
    body.status = !ok ? 'fail' : degraded ? 'degraded' : 'ok';
    return reply
      .code(ok ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(body);
  });

  // ── ключ: той самий на REST і MCP ───────────────────────────────────────
  app.decorateRequest('product', null);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/') && request.url !== '/mcp' && !request.url.startsWith('/mcp?')) return;
    const product = keys.resolve(readKey(request.headers));
    // Той самий текст і на відсутній, і на невірний ключ.
    if (!product) return reply.code(401).send({ error: 'unauthorized' });
    request.product = product;
  });

  const ctx = (request: FastifyRequest, transport: CallContext['transport']): CallContext => ({
    product: request.product!,
    transport,
  });

  async function rest<T>(reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return reply.header('cache-control', 'no-store').send(await fn());
    } catch (err) {
      if (err instanceof ServiceError) return reply.code(err.status).send({ error: err.code, detail: err.message });
      throw err;
    }
  }

  // ── REST-двійники інструментів ──────────────────────────────────────────
  app.get('/v1/adapters', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      adapters: adapterHealth.snapshot().map((h) => ({
        adapter: h.adapter,
        account: h.account,
        state: h.state,
        reason: h.reason,
        limited: h.limited,
        checked_at: h.checkedAt,
      })),
      access: adapterHealth.accessSnapshot().map((h) => ({
        adapter: h.adapter,
        account: h.account,
        state: h.state,
        visible: h.visible,
        missing: h.missing,
        reason: h.reason,
        checked_at: h.checkedAt,
      })),
    }),
  );

  app.get('/v1/scope', async (request, reply) => rest(reply, () => service.ownScope(ctx(request, 'rest'))));
  app.get('/v1/usage', async (request, reply) => rest(reply, () => service.usage(ctx(request, 'rest'))));

  app.get('/v1/conversations', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    return rest(reply, () => service.listChats(ctx(request, 'rest'), { limit: int(q.limit), offset: int(q.offset) }));
  });

  app.get('/v1/conversations/:ref/messages', async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const q = request.query as Record<string, unknown>;
    return rest(reply, () =>
      service.getMessages(ctx(request, 'rest'), { conversation: ref, limit: int(q.limit), cursor: text(q.cursor) }),
    );
  });

  app.get('/v1/conversations/:ref/search', async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const q = request.query as Record<string, unknown>;
    return rest(reply, () =>
      service.searchMessages(ctx(request, 'rest'), { conversation: ref, query: text(q.q) ?? '', limit: int(q.limit) }),
    );
  });

  app.get('/v1/conversations/:ref/by-date', async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const q = request.query as Record<string, unknown>;
    return rest(reply, () =>
      service.getMessagesByDate(ctx(request, 'rest'), {
        conversation: ref,
        date: text(q.date) ?? '',
        timezone: text(q.timezone),
        limit: int(q.limit),
      }),
    );
  });

  app.get('/v1/conversations/:ref/transcript', async (request, reply) => {
    const { ref } = request.params as { ref: string };
    const q = request.query as Record<string, unknown>;
    return rest(reply, () =>
      service.getTranscript(ctx(request, 'rest'), { conversation: ref, language: text(q.language), cursor: text(q.cursor) }),
    );
  });

  // ── MCP, Streamable HTTP, stateless ─────────────────────────────────────
  app.all('/mcp', async (request, reply) => {
    const server = buildMcpServer(service, ctx(request, 'mcp'), version);
    // Без sessionIdGenerator — stateless: жодної сесії в пам'яті, транспорт на
    // один запит. Відповідь JSON, а не SSE: інструменти не стрімлять, а
    // stateless-сервер не шле сповіщень поза відповіддю.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      // Приведення — лише через exactOptionalPropertyTypes: типи SDK пишуть
      // `onclose?: () => void`, а клас віддає `(() => void) | undefined`.
      await server.connect(transport as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'mcp.request_failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
      }
    }
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'not_found' }));

  return app;
}
