import { defineEnv, enumOf, num, str, url, type EnvOf, type EnvSource } from '@exo/kit/env';

/**
 * Налаштування — усе з оточення, і ЛИШЕ тут: жоден інший модуль не читає
 * process.env (правило kit, яке робить решту дерева переносною).
 *
 * Репо публічне (connectors.md §1): у ньому немає ні номерів, ні імен
 * акаунтів, ні `ref` розмов. Усе це — `.env` (адаптери, ключі) і БД (області).
 */
export const schema = {
  // ── дані ──
  DATABASE_URL: url({
    protocols: ['postgresql', 'postgres'],
    describe:
      'Спільний postgres у мережі internal: області ключів (social_scope) і облік (social_call).\n' +
      'Без неї шлюз не стартує: область, яку нема де прочитати, — це відмова, а не «усе».',
    example: 'postgresql://relic:<пароль>@postgres:5432/relic?sslmode=disable',
  }),
  REDIS_URL: url({
    optional: true,
    protocols: ['redis', 'rediss'],
    describe: 'Спільний redis, свій DB-індекс (AGENTS.md §7): денні стелі. Порожньо — стелі не рахуються (fail-open).',
    example: 'redis://:<пароль>@redis:6379/<індекс>',
  }),

  // ── хто ходить ──
  PRODUCT_KEYS: str({
    secret: true,
    describe:
      'Ключі продуктів: "продукт:секрет" через кому. Ключ НАЗИВАЄ продукт — це ім\'я їде\n' +
      'в облік і в область. Новий секрет: echo "relic-<продукт>-$(openssl rand -hex 20)"',
    example: 'claude:relic-claude-<секрет>',
  }),
  STDIO_PRODUCT: str({
    default: 'claude',
    describe:
      'Чий ключ бере stdio-вхід (dist/mcp-stdio.js, `docker exec -i`). Продукт мусить мати\n' +
      'ключ у PRODUCT_KEYS; область і облік — ті самі, що в HTTP /mcp.',
  }),
  DAILY_CAP_PER_PRODUCT: num({
    default: 2000,
    min: 1,
    describe: 'Скільки викликів інструментів на продукт за добу UTC. Рахується ДО виклику.',
  }),

  // ── бюджет відповіді (один на всі адаптери, перенесення internal/budget форку) ──
  MAX_ITEMS: num({ default: 100, min: 1, describe: 'Найбільше елементів (повідомлень, розмов) в одній відповіді.' }),
  MAX_RESPONSE_BYTES: num({
    default: 32_768,
    min: 1024,
    describe: 'Найбільше байтів в одній відповіді (≈ 8–10 тис. токенів на 32 КБ).',
  }),

  // ── адаптер telegram-archive ──
  TELEGRAM_ARCHIVE_URL: url({
    optional: true,
    protocols: ['http', 'https'],
    describe: 'HTTP API переглядача архіву (mikoshi). Порожньо — адаптер вимкнений і не входить у /health/ready.',
    example: 'http://mikoshi-viewer:8000',
  }),
  TELEGRAM_ARCHIVE_ACCOUNT: str({
    optional: true,
    describe: 'Назва акаунта адаптера в ref шлюзу: telegram-archive:<назва>:<ref переглядача>.',
    example: '<назва>',
  }),
  TELEGRAM_ARCHIVE_USER: str({
    optional: true,
    describe: 'Акаунт ПЕРЕГЛЯДАЧА, під яким ходить шлюз. Заводиться з allowed_chat_refs: [] —\nбез цього поля акаунт бачить УСЕ.',
  }),
  TELEGRAM_ARCHIVE_PASS: str({ optional: true, secret: true, describe: 'Пароль акаунта переглядача.' }),

  // ── адаптер youtube ──
  YOUTUBE_API_KEY: str({
    optional: true,
    secret: true,
    describe:
      'Ключ YouTube Data API v3 (Google Cloud → Credentials → API key, обмежений цим API і IP\n' +
      'сервера). Порожньо — коментарі й назви відео вимкнені (checks.youtube = skip), транскрипти лишаються.',
  }),
  YOUTUBE_PROBE_VIDEO: str({
    optional: true,
    describe:
      'id будь-якого публічного відео для проби ключа (videos.list, 1 одиниця квоти). Обов\'язковий разом\n' +
      'із ключем. Тут, а не в коді: репо публічне. Видалене відео пробі не шкодить — порожня відповідь теж 200.',
    example: '<11 символів id>',
  }),
  YOUTUBE_PROBE_INTERVAL_MS: num({
    default: 600_000,
    min: 60_000,
    omitExample: true,
    describe: 'Як часто проба бачить ключ Data API (10 хв = 144 одиниці на добу з 10 000).',
  }),
  YTDLP_PATH: str({
    optional: true,
    omitExample: true,
    describe: 'Бінарник yt-dlp (транскрипти). Задає образ (Dockerfile); порожньо — транскриптів немає.',
  }),
  YTDLP_TIMEOUT_MS: num({
    default: 60_000,
    min: 5_000,
    omitExample: true,
    describe: 'Скільки чекати на один запуск yt-dlp, перш ніж убити процес.',
  }),

  ADAPTER_PROBE_INTERVAL_MS: num({
    default: 60_000,
    min: 5_000,
    omitExample: true,
    describe: 'Як часто проба бачить вхід кожного адаптера. Стеля входів переглядача — 15 за 5 хв на IP.',
  }),

  // ── те, що дає образ і compose, а не файл ──
  PORT: num({ default: 3000, omitExample: true, describe: 'Порт HTTP у контейнері.' }),
  HOST: str({ default: '0.0.0.0', omitExample: true, describe: 'Інтерфейс.' }),
  APP_VERSION: str({ default: 'dev', omitExample: true, describe: 'Короткий хеш коміту з образу — поле version у /health/*.' }),
  NODE_ENV: enumOf(['development', 'test', 'production'], { default: 'development', omitExample: true, describe: 'Режим.' }),
  LOG_LEVEL: str({ default: 'info', omitExample: true, describe: 'Рівень pino.' }),
};

export interface TelegramArchiveEnv {
  url: string;
  account: string;
  user: string;
  pass: string;
}

export interface YoutubeEnv {
  apiKey: string | null;
  probeVideo: string | null;
  probeIntervalMs: number;
  ytdlpPath: string | null;
  ytdlpTimeoutMs: number;
}

export interface Env {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string | null;
  productKeys: string;
  stdioProduct: string;
  dailyCapPerProduct: number;
  limits: { maxItems: number; maxBytes: number };
  telegramArchive: TelegramArchiveEnv | null;
  youtube: YoutubeEnv | null;
  probeIntervalMs: number;
  version: string;
  logLevel: string;
  production: boolean;
}

/** Адаптер або налаштований цілком, або вимкнений: половина — помилка, а не «вимкнено». */
function telegramArchive(raw: EnvOf<typeof schema>): TelegramArchiveEnv | null {
  const parts = {
    TELEGRAM_ARCHIVE_URL: raw.TELEGRAM_ARCHIVE_URL,
    TELEGRAM_ARCHIVE_ACCOUNT: raw.TELEGRAM_ARCHIVE_ACCOUNT,
    TELEGRAM_ARCHIVE_USER: raw.TELEGRAM_ARCHIVE_USER,
    TELEGRAM_ARCHIVE_PASS: raw.TELEGRAM_ARCHIVE_PASS,
  };
  const set = Object.entries(parts).filter(([, v]) => v);
  if (set.length === 0) return null;
  if (set.length !== 4) {
    const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => k);
    throw new Error(`адаптер telegram-archive налаштований наполовину: бракує ${missing.join(', ')}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts.TELEGRAM_ARCHIVE_ACCOUNT!)) {
    throw new Error('TELEGRAM_ARCHIVE_ACCOUNT — малі латинські літери, цифри й дефіс (до 32): вона стає частиною ref');
  }
  return {
    url: parts.TELEGRAM_ARCHIVE_URL!.replace(/\/+$/, ''),
    account: parts.TELEGRAM_ARCHIVE_ACCOUNT!,
    user: parts.TELEGRAM_ARCHIVE_USER!,
    pass: parts.TELEGRAM_ARCHIVE_PASS!,
  };
}

/**
 * youtube увімкнений, щойно є хоч одна половина — ключ Data API або yt-dlp:
 * у проді образ завжди дає YTDLP_PATH, тож адаптер є завжди, а без ключа він
 * `skip` (коментарів немає, транскрипти є). Ключ без відео для проби —
 * помилка, а не «проба вимкнена».
 */
function youtube(raw: EnvOf<typeof schema>): YoutubeEnv | null {
  const key = raw.YOUTUBE_API_KEY || null;
  const probe = raw.YOUTUBE_PROBE_VIDEO || null;
  const ytdlp = raw.YTDLP_PATH || null;
  if (!key && !ytdlp) return null;
  if (key && !probe) throw new Error('YOUTUBE_API_KEY без YOUTUBE_PROBE_VIDEO: пробі ключа потрібне id публічного відео');
  if (probe && !/^[A-Za-z0-9_-]{11}$/.test(probe)) throw new Error('YOUTUBE_PROBE_VIDEO — 11 символів id відео');
  return {
    apiKey: key,
    probeVideo: probe,
    probeIntervalMs: raw.YOUTUBE_PROBE_INTERVAL_MS,
    ytdlpPath: ytdlp,
    ytdlpTimeoutMs: raw.YTDLP_TIMEOUT_MS,
  };
}

export function readEnv(source: EnvSource = process.env): Env {
  const raw = defineEnv(schema, source);
  return {
    port: raw.PORT,
    host: raw.HOST,
    databaseUrl: raw.DATABASE_URL,
    redisUrl: raw.REDIS_URL,
    productKeys: raw.PRODUCT_KEYS,
    stdioProduct: raw.STDIO_PRODUCT,
    dailyCapPerProduct: raw.DAILY_CAP_PER_PRODUCT,
    limits: { maxItems: raw.MAX_ITEMS, maxBytes: raw.MAX_RESPONSE_BYTES },
    telegramArchive: telegramArchive(raw),
    youtube: youtube(raw),
    probeIntervalMs: raw.ADAPTER_PROBE_INTERVAL_MS,
    version: raw.APP_VERSION,
    logLevel: raw.LOG_LEVEL,
    production: raw.NODE_ENV === 'production',
  };
}
