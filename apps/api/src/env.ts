import { defineEnv, enumOf, num, str, url, type EnvSource } from '@exo/kit/env';

/**
 * Налаштування — усе з оточення, і ЛИШЕ тут: жоден інший модуль не читає
 * process.env (правило kit, яке робить решту дерева переносною).
 *
 * Схема — `@exo/kit/env`: імена, типи й обов'язковість в одному місці,
 * перевірка на старті, помилка називає ЗМІННУ і ніколи не показує значення.
 * Імена канонічні й без префікса продукту (план §5 C3, docs/standards/auth.md):
 * `.env` у кожного продукту свій.
 *
 * Згенеровано `exo new --kind api` (план модульності §5 D2) за зразком filebrowser.
 */


export const schema = {
  // ── що бачить світ ──
  DOMAIN: str({
    optional: true,
    describe: 'Публічний хост. У compose ним підставляється Host у Traefik.',
    example: 'exo-social.exocriador.dev',
  }),
  SITE_URL: url({
    optional: true,
    describe: 'Походження сайту. Порожньо — https://DOMAIN, а без DOMAIN — http://localhost:3000.',
    example: 'https://exo-social.exocriador.dev',
  }),

  // ── дані ──
  DATABASE_URL: url({
    optional: true,
    protocols: ['postgresql', 'postgres'],
    describe:
      'Спільний postgres у мережі internal. Те саме ім\'я без перекладу читає dbmate\n(MIGRATE=dbmate у deploy.conf), тому ?sslmode=disable — у самому рядку.',
    example: 'postgresql://exo_social:<пароль>@postgres:5432/exo_social?sslmode=disable',
  }),
  REDIS_URL: url({
    optional: true,
    protocols: ['redis', 'rediss'],
    describe: 'Спільний redis, свій DB-індекс (AGENTS.md §7).',
    example: 'redis://:<пароль>@redis:6379/<індекс>',
  }),


  // ── те, що дає образ і compose, а не файл ──
  PORT: num({ default: 3000, omitExample: true, describe: 'Порт HTTP у контейнері.' }),
  HOST: str({ default: '0.0.0.0', omitExample: true, describe: 'Інтерфейс.' }),
  APP_VERSION: str({ default: 'dev', omitExample: true, describe: 'Короткий хеш коміту з образу — поле version у /health/*.' }),
  WEB_DIST: str({ optional: true, omitExample: true, describe: 'Звідки роздавати SPA. Порожньо — apps/web/dist поруч.' }),
  NODE_ENV: enumOf(['development', 'test', 'production'], { default: 'development', omitExample: true, describe: 'Режим.' }),
};


export interface Env {
  port: number;
  host: string;
  siteUrl: string;
  databaseUrl: string | null;
  redisUrl: string | null;
  version: string;
  webDist: string;
  production: boolean;
}


export function readEnv(source: EnvSource = process.env): Env {
  const raw = defineEnv(schema, source);
  const siteUrl = raw.SITE_URL ?? (raw.DOMAIN ? `https://${raw.DOMAIN}` : 'http://localhost:3000');
  return {
    port: raw.PORT,
    host: raw.HOST,
    siteUrl: siteUrl.replace(/\/+$/, ''),
    databaseUrl: raw.DATABASE_URL,
    redisUrl: raw.REDIS_URL,
    version: raw.APP_VERSION,
    webDist: raw.WEB_DIST ?? '',
    production: raw.NODE_ENV === 'production',
  };
}

