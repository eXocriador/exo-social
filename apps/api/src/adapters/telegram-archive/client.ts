/**
 * HTTP-клієнт переглядача Telegram-Archive (tg-archive-viewer).
 *
 * Вхід — `POST /api/login` під акаунтом переглядача, далі кука `viewer_auth`.
 *
 * **Капкан, заради якого клієнт написаний руками:** кука ставиться з
 * прапорцем `Secure` (у compose tg-archive `SECURE_COOKIES=true`, бо переглядач
 * живе в інтернеті). Шлюз ходить у нього по HTTP усередині мережі `internal`,
 * і будь-яка cookie-jar таку куку назад не віддасть — запити йшли б
 * анонімними й отримували 401. Тому кука береться з `Set-Cookie` і шлеться
 * заголовком `Cookie` сама, а на 401 — перелогін один раз (так само робить
 * Go-клієнт форку, `client/telegram_archive.go`).
 *
 * **Стеля входів переглядача — 15 спроб за 5 хв на IP**, і відхилений вхід
 * теж спроба. Тому після відмови (`expired`) клієнт не пробує знову на кожен
 * виклик інструмента: наступну спробу робить проба здоров'я за розкладом, а
 * виклики до того отримують `expired` без мережі.
 */
import { AdapterError } from '../types.js';

const COOKIE = 'viewer_auth';
const MAX_BODY_BYTES = 10 << 20;

export interface ViewerClientOptions {
  baseUrl: string;
  user: string;
  pass: string;
  timeoutMs?: number;
  /** Після відхиленого входу — стільки не пробувати знову з викликів інструментів. */
  loginBackoffMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

type Query = Record<string, string | number | undefined | null>;

export class ViewerClient {
  private cookie: string | null = null;
  private rejectedAt: number | null = null;
  private rejection: AdapterError | null = null;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;

  constructor(private readonly opts: ViewerClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.backoffMs = opts.loginBackoffMs ?? 60_000;
  }

  /** Чи тримає клієнт куку (для проби: спершу перевірити її, а не входити). */
  get hasSession(): boolean {
    return this.cookie !== null;
  }

  /**
   * Увійти. `force` — проба здоров'я: вона ходить за розкладом і саме вона
   * повертає адаптер до життя після відмови. Виклики інструментів у вікні
   * після відмови отримують ту саму відмову без спроби.
   */
  async login(force = false): Promise<void> {
    if (!force && this.rejection && this.rejectedAt !== null && this.now() - this.rejectedAt < this.backoffMs) {
      throw this.rejection;
    }
    // Одна спроба на всіх, хто прийшов одночасно: п'ять паралельних викликів
    // після рестарту не мають спалити третину стелі входів.
    this.inflight ??= this.doLogin().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doLogin(): Promise<void> {
    const res = await this.send('POST', '/api/login', undefined, JSON.stringify({ username: this.opts.user, password: this.opts.pass }), null);
    if (res.status === 200) {
      const cookie = readCookie(res.headers);
      if (!cookie) throw new AdapterError('down', 'переглядач прийняв вхід, але не поставив куку viewer_auth');
      this.cookie = cookie;
      this.rejection = null;
      this.rejectedAt = null;
      return;
    }
    await res.body?.cancel();
    if (res.status === 429) throw new AdapterError('rate_limited', 'стеля входів переглядача (15 за 5 хв) — вхід не пробувався');
    if (res.status >= 500) throw new AdapterError('down', `переглядач відповів ${res.status} на вхід`);
    // 401 — невірний пароль, акаунт вимкнений (is_active 0) або видалений:
    // для шлюзу це одне й те саме — вхід відхилено, і сам він не полагодиться.
    this.cookie = null;
    this.rejectedAt = this.now();
    this.rejection = new AdapterError(
      'expired',
      `переглядач відхилив вхід акаунта (${res.status}): пароль змінено, акаунт вимкнено або видалено`,
    );
    throw this.rejection;
  }

  /** Чи жива поточна кука. Мережеві збої — кидає `down`. */
  async sessionAlive(): Promise<boolean> {
    if (!this.cookie) return false;
    const res = await this.send('GET', '/api/auth/check', undefined, undefined, this.cookie);
    if (res.status !== 200) {
      await res.body?.cancel();
      if (res.status >= 500) throw new AdapterError('down', `переглядач відповів ${res.status} на /api/auth/check`);
      return false;
    }
    const body = (await res.json()) as { authenticated?: unknown };
    if (body.authenticated !== true) this.cookie = null;
    return body.authenticated === true;
  }

  /** GET з автентифікацією; на 401 — перелогін один раз. */
  async get(path: string, query?: Query): Promise<unknown> {
    return this.authed(path, query, true);
  }

  private async authed(path: string, query: Query | undefined, retry: boolean): Promise<unknown> {
    if (!this.cookie) await this.login();
    const res = await this.send('GET', path, query, undefined, this.cookie);
    if (res.status === 401 && retry) {
      await res.body?.cancel();
      this.cookie = null;
      return this.authed(path, query, false);
    }
    if (res.status === 200) return readJson(res);
    const detail = await readDetail(res);
    if (res.status === 404) throw new AdapterError('not_found', 'розмови немає або вона поза областю');
    if (res.status === 401 || res.status === 403) {
      this.cookie = null;
      throw new AdapterError('expired', `переглядач не пускає акаунт (${res.status})`);
    }
    if (res.status === 429) throw new AdapterError('rate_limited', 'стеля частоти переглядача');
    if (res.status === 400 || res.status === 422) throw new AdapterError('bad_request', detail || `аргумент не прийнято (${res.status})`);
    throw new AdapterError('down', `переглядач відповів ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  /** Вийти (на зупинці шлюзу), щоб сесії в переглядачі не накопичувались. */
  async logout(): Promise<void> {
    if (!this.cookie) return;
    try {
      const res = await this.send('POST', '/api/logout', undefined, '{}', this.cookie);
      await res.body?.cancel();
    } catch {
      // Найкраще, що можна: сесія все одно спливе сама (AUTH_SESSION_DAYS).
    }
    this.cookie = null;
  }

  private async send(method: string, path: string, query: Query | undefined, body: string | undefined, cookie: string | null): Promise<Response> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = `${COOKIE}=${cookie}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AdapterError('down', `переглядач недосяжний: ${(err as Error).message}`);
    }
  }
}

/** `Set-Cookie: viewer_auth=…; HttpOnly; Secure; …` → значення. */
export function readCookie(headers: Headers): string | null {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  for (const line of all) {
    const m = new RegExp(`(?:^|,\\s*)${COOKIE}=([^;]+)`).exec(line);
    if (m && m[1] && m[1] !== '""') return m[1];
  }
  return null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new AdapterError('down', `відповідь переглядача більша за ${MAX_BODY_BYTES} байтів`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterError('down', 'переглядач віддав не JSON');
  }
}

async function readDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    const parsed = JSON.parse(text) as { detail?: unknown };
    return typeof parsed.detail === 'string' ? parsed.detail.slice(0, 200) : '';
  } catch {
    return '';
  }
}
