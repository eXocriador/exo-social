import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createHealth } from '@exo/kit/health';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Env } from './env.js';

/**
 * Складання сервера. Усе, що ходить у мережу чи базу, приходить аргументом —
 * тож server.test.ts ганяється без Постгресу, Redis і провайдерів. Реальні
 * дроти — в index.ts.
 */

/** Перевірка готовності: `true` — живе. Кидати можна: kit рахує це як провал. */
export type Check = () => Promise<boolean>;

export interface BuildServerOptions {
  env: Env;
  /** Ім'я → перевірка. Усі обов'язкові: продукт без жодної з них непридатний. */
  checks: Record<string, Check>;
  logger?: boolean;
}

/** Web-standard `Response` від kit → відповідь Fastify. */
async function send(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  for (const [name, value] of response.headers) reply.header(name, value);
  return reply.code(response.status).send(await response.json());
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { env, checks, logger = true } = options;
  const app = Fastify({
    logger: logger ? { level: 'info' } : false,
    // За Traefik: request.ip з X-Forwarded-For лише від нього, він єдиний сусід.
    trustProxy: true,
  });

  // Здоров'я — першим і поза всім: без куки, без бази, без SPA-fallback.
  // `{status, version, checks}` (AGENTS.md §6); version = APP_VERSION з образу —
  // саме за нею exo-deploy судить, що в проді щойно зібраний коміт.
  const health = createHealth({ version: env.version, checks, required: Object.keys(checks) });
  app.get('/health/live', async (_request, reply) => send(reply, health.live()));
  app.get('/health/ready', async (_request, reply) => send(reply, await health.ready()));


  // SPA: статика з dist, а все, що не /api і не /health, — index.html.
  // Тека може бути відсутня (тести, dev через vite) — тоді лише API.
  const index = env.webDist ? join(env.webDist, 'index.html') : '';
  if (index && existsSync(index)) {
    void app.register(fastifyStatic, { root: env.webDist, wildcard: false, index: false });
  }
  app.setNotFoundHandler(async (request, reply) => {
    const spa =
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/health');
    if (spa && index && existsSync(index)) return reply.sendFile('index.html', env.webDist);
    return reply.code(404).send({ detail: { code: 'not-found', params: {}, source: 'exo-social' } });
  });

  return app;
}
