import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';
import { buildServer, type BuildServerOptions } from './server.js';

/**
 * Перший тест продукту — проби здоров'я, бо саме за ними судять деплой
 * (`version` = зібраний коміт), compose і Kuma. Ворота образу ганяють його до
 * збірки (Dockerfile, стадія build).
 */

const env = readEnv({ APP_VERSION: 'abc1234', NODE_ENV: 'test' });
const server = (checks: BuildServerOptions['checks']) => buildServer({ env, checks, logger: false });

describe('health', () => {
  it('/health/live — 200 і version з образу, без жодної залежності', async () => {
    const response = await server({ postgres: async () => false }).inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 'abc1234' });
  });

  it('/health/ready — 200, коли всі перевірки живі', async () => {
    const response = await server({ postgres: async () => true, redis: async () => true }).inject({
      method: 'GET',
      url: '/health/ready',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 'abc1234' });
  });

  it('/health/ready — 503, коли обов\'язкова перевірка впала або кинула', async () => {
    const dead = await server({ postgres: async () => false }).inject({ method: 'GET', url: '/health/ready' });
    expect(dead.statusCode).toBe(503);
    const threw = await server({
      redis: async () => {
        throw new Error('ECONNREFUSED');
      },
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(threw.statusCode).toBe(503);
  });
});

