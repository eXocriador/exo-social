import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedis } from '@exo/kit/infra';
import { createLogger } from '@exo/kit/log';
import { createTelemetry } from '@exo/kit/telemetry';
import pg from 'pg';
import { readEnv, type Env } from './env.js';
import { buildServer, type Check } from './server.js';

/**
 * Точка входу — єдине місце, де конфіг (env.ts) стає екземплярами фабрик.
 * Міграції тут НЕ котяться: це робить exo-deploy (`MIGRATE=dbmate`)
 * одноразовим контейнером з цього ж образу до підняття нового сервера.
 */

function loadEnv(): Env {
  try {
    return readEnv();
  } catch (error) {
    // Повідомлення kit називає змінні й не містить значень.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

const env = loadEnv();
if (!env.webDist) env.webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const { logger, logWarn, logError } = createLogger({ service: 'exo-social-api', openobserve: null });

// Один шов на весь продукт: з'явиться DSN — telemetry.setReporter(...) тут, без правок у дротах.
const telemetry = createTelemetry({
  logError: (event, error, fields) =>
    logWarn(event, { ...fields, err: error instanceof Error ? error.message : String(error) }),
  logWarn: (event, fields) => logWarn(event, fields),
});

const redis = createRedis({ url: env.redisUrl, globalKey: '__redis', reportError: telemetry.reportError });
const pool = env.databaseUrl ? new pg.Pool({ connectionString: env.databaseUrl, max: 5 }) : null;

// Готовність = те, що налаштовано. Незадана змінна — не перевірка, що завжди червона.
const checks: Record<string, Check> = {};
if (pool) checks.postgres = async () => (await pool.query('SELECT 1')).rowCount === 1;
const redisClient = redis.client;
if (redisClient) checks.redis = async () => (await redisClient.ping()) === 'PONG';

const app = buildServer({ env, checks });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => pool?.end())
      .then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: env.port, host: env.host });
  logger.info({ version: env.version, checks: Object.keys(checks) }, 'exo-social api');
} catch (error) {
  logError('listen_failed', error);
  process.exit(1);
}
