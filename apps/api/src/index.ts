/**
 * relic — шлюз від продуктів до соцмереж і месенджерів.
 *
 * Точка входу — єдине місце, де конфіг (env.ts) стає екземплярами. Міграції
 * тут НЕ котяться: це робить exo-deploy (`MIGRATE=dbmate`) одноразовим
 * контейнером з цього ж образу до підняття нового сервера.
 */
import { createDb, createRedis } from '@exo/kit/infra';
import { createLogger } from '@exo/kit/log';
import { createTelegramArchive } from './adapters/telegram-archive/index.js';
import { DEFAULT_GUARD, Guard, memoryKv, redisKv } from './adapters/youtube/guard.js';
import { createYoutube } from './adapters/youtube/index.js';
import { createRegistry, type Adapter } from './adapters/types.js';
import { readEnv, type Env } from './env.js';
import { createAdapterHealth } from './health.js';
import { KeyConfigError, parseProductKeys } from './keys.js';
import { createLedger } from './ledger.js';
import { createQuota } from './quota.js';
import { createScopeRefs, createScopeStore } from './scope.js';
import { buildServer } from './server.js';
import { createService } from './service.js';

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
const { logInfo, logWarn, logError } = createLogger({ service: 'relic', level: env.logLevel, openobserve: null });

let keys;
try {
  keys = parseProductKeys(env.productKeys);
} catch (error) {
  if (error instanceof KeyConfigError) {
    process.stderr.write(`relic: ${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
logInfo('boot.keys', { products: keys.products });

const db = createDb({ url: env.databaseUrl, reportError: (err, c) => logError('db.error', err, { ...c }) });
const redis = createRedis({ url: env.redisUrl, reportError: (err, c) => logError('redis.error', err, { ...c }) });

const adapterList: Adapter[] = [];
if (env.telegramArchive) {
  adapterList.push(
    createTelegramArchive({
      baseUrl: env.telegramArchive.url,
      account: env.telegramArchive.account,
      user: env.telegramArchive.user,
      pass: env.telegramArchive.pass,
      loginBackoffMs: env.probeIntervalMs,
    }),
  );
}
if (env.youtube) {
  adapterList.push(
    createYoutube({
      apiKey: env.youtube.apiKey,
      probeVideo: env.youtube.probeVideo,
      probeIntervalMs: env.youtube.probeIntervalMs,
      ytdlpPath: env.youtube.ytdlpPath,
      ytdlpTimeoutMs: env.youtube.ytdlpTimeoutMs,
      // Стан запобіжника — у Redis (переживає деплой); без Redis — у пам'яті, але стелі лишаються.
      guard: new Guard(
        redis.client
          ? redisKv(redis.client, 'relic:youtube:', (err) => logWarn('youtube.guard_redis', { error: (err as Error)?.message }))
          : memoryKv(),
        { ...DEFAULT_GUARD, ...env.youtube.guard },
      ),
    }),
  );
}
const adapters = createRegistry(adapterList);
logInfo('boot.adapters', { adapters: [...adapters.keys()] });

const adapterHealth = createAdapterHealth({
  adapters,
  intervalMs: env.probeIntervalMs,
  scopeRefs: createScopeRefs(db),
  logInfo,
  logWarn,
});
const service = createService({
  adapters,
  scope: createScopeStore(db),
  ledger: createLedger(db, logWarn),
  quota: createQuota(redis, env.dailyCapPerProduct, logWarn),
  limits: env.limits,
  logWarn,
});

const app = buildServer({
  version: env.version,
  keys,
  service,
  adapterHealth,
  checks: {
    postgres: async () => (await db.query((sql) => sql`SELECT 1`)) !== null,
    redis: async () => {
      if (!redis.client) return 'skip';
      try {
        return (await redis.client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
  },
  // Postgres — обов'язковий: без області шлюз лише відмовляє. Redis — ні:
  // стелі fail-open, і шлюз без них працює.
  required: ['postgres'],
  logLevel: env.logLevel,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    adapterHealth.stop();
    void app
      .close()
      .then(() => Promise.all(adapterList.map((a) => a.close?.())))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

// Перша проба входу — ДО listen: /health/ready з першої секунди каже правду,
// а не `unknown`.
await adapterHealth.sweep();
adapterHealth.start();

try {
  await app.listen({ port: env.port, host: env.host });
  logInfo('boot.listening', { port: env.port, version: env.version, adapters: adapterHealth.states() });
} catch (error) {
  logError('listen_failed', error);
  process.exit(1);
}
