/**
 * YouTube Data API v3 — лише читання публічного, ключем API (без OAuth).
 *
 * Ключ іде заголовком `X-Goog-Api-Key`, а не `?key=`: URL потрапляє в логи й у
 * повідомлення помилок, заголовок — ні.
 *
 * Кожен запит — одиниця квоти (`charge('units')`), і та, що впала, теж:
 * Google списує й за невдалий запит. Добова квота проєкту — 10 000.
 *
 * Помилки розкладаються на те, що з ними робити (README репо, коди):
 *   • ключ відхилено (400 API_KEY_INVALID, 403 accessNotConfigured, ключ
 *     обмежений іншим API чи іншою IP) — `expired`: сам не полагодиться;
 *   • квота вичерпана, стеля частоти — `rate_limited`: НЕ вирок здоров'ю;
 *   • відео немає — `not_found`; коментарі вимкнені — `bad_request` з поясненням;
 *   • 5xx, мережа, таймаут — `down`.
 */
import { charge } from '../../meter.js';
import { AdapterError } from '../types.js';

export const DATA_API = 'https://www.googleapis.com/youtube/v3';

export interface DataApiOptions {
  key: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

interface GoogleError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string }[];
    details?: { reason?: string }[];
  };
}

/** Причини, з якими ключ не працюватиме, доки людина не змінить ключ або консоль. */
const KEY_REJECTED = new Set([
  'API_KEY_INVALID',
  'keyInvalid',
  'keyExpired',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'accessNotConfigured',
  'SERVICE_DISABLED',
  'ipRefererBlocked',
]);

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);

/** Усі `reason` з тіла помилки Google — і старі (`errors`), і нові (`details`). */
export function reasonsOf(body: unknown): string[] {
  const e = (body as GoogleError | null)?.error;
  if (!e) return [];
  return [...(e.errors ?? []), ...(e.details ?? [])].map((r) => r.reason ?? '').filter(Boolean);
}

/** Відповідь Google, що не 2xx, → помилка адаптера. Ключа в повідомленні немає. */
export function classify(status: number, body: unknown): AdapterError {
  const reasons = reasonsOf(body);
  const has = (set: Set<string>) => reasons.some((r) => set.has(r));
  const said = reasons.length ? ` (${reasons.join(', ')})` : '';
  if (has(KEY_REJECTED)) {
    return new AdapterError(
      'expired',
      `Data API відхилив ключ${said}: ключ невірний, API не ввімкнено в проєкті або ключ обмежений іншою IP чи іншим API — перевірити YOUTUBE_API_KEY і консоль Google Cloud`,
    );
  }
  if (status === 429 || has(QUOTA)) {
    return new AdapterError('rate_limited', `квоту або стелю частоти Data API вичерпано${said} — добова квота оновлюється опівночі за тихоокеанським часом`);
  }
  if (reasons.includes('commentsDisabled')) return new AdapterError('bad_request', 'коментарі під цим відео вимкнені');
  if (status === 404 || reasons.includes('videoNotFound')) return new AdapterError('not_found', 'відео немає');
  if (status === 400) {
    if (reasons.includes('invalidPageToken')) return new AdapterError('bad_request', 'cursor застарів або не з цього відео — почніть без cursor');
    return new AdapterError('bad_request', `Data API не прийняв запит${said}`);
  }
  if (status === 403) return new AdapterError('not_found', `Data API не віддає це відео${said}`);
  return new AdapterError('down', `Data API відповів ${status}${said}`);
}

export class DataApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DataApiOptions) {
    this.base = (opts.baseUrl ?? DATA_API).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async get<T>(resource: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${this.base}/${resource}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    charge('units');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'x-goog-api-key': this.opts.key, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const why = (err as Error)?.name === 'TimeoutError' ? `не відповів за ${this.timeoutMs / 1000} с` : 'недосяжний';
      throw new AdapterError('down', `Data API ${why}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // тіло не JSON — рішення лише за кодом
    }
    if (!res.ok) throw classify(res.status, body);
    if (body === null || typeof body !== 'object') throw new AdapterError('down', 'Data API віддав не JSON');
    return body as T;
  }
}
