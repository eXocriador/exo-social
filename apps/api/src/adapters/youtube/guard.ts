/**
 * Запобіжник адаптера youtube: шлюз ходить у YouTube рідко, розмірено і сам
 * замовкає, щойно платформа починає хмуритись (рішення власника 2026-09-25:
 * «мені не потрібні бани, мені потрібно, щоб інструмент працював»).
 *
 * Що він тримає (усе — на весь шлюз, а не на продукт):
 *   • yt-dlp: не більше N запусків на годину і M на добу, не частіше за раз
 *     на `minGapMs`; процес один за раз (семафор у ytdlp.ts);
 *   • пауза: 429 від YouTube — одразу пауза; бот-перевірки поспіль — пауза
 *     після `tripAfter`. На паузі шлюз відповідає сам, YouTube не питає;
 *   • пам'ять відмов: відео з бот-перевіркою не пробується добу;
 *   • кеш транскрипту — доба, у Redis, переживає перезапуск;
 *   • Data API: власна добова стеля одиниць, нижча за квоту Google, — щоб
 *     квота ніколи не вичерпувалась до кінця.
 *
 * Стан — у Redis (спільний, переживає деплой). Redis недосяжний — той самий
 * стан у пам'яті процесу: обмеження лишаються, лише скидаються з перезапуском.
 * Тут fail-open неприйнятний — він означав би «без стель».
 */
import type { Redis } from 'ioredis';

export interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** +1 і TTL на першому інкременті; повертає нове значення. */
  incr(key: string, ttlSec: number): Promise<number>;
  del(key: string): Promise<void>;
}

export function memoryKv(now: () => number = Date.now): Kv {
  const map = new Map<string, { v: string; until: number }>();
  const live = (k: string) => {
    const e = map.get(k);
    if (e && e.until <= now()) map.delete(k);
    return map.get(k) ?? null;
  };
  return {
    async get(k) {
      return live(k)?.v ?? null;
    },
    async set(k, v, ttl) {
      map.set(k, { v, until: now() + ttl * 1000 });
    },
    async incr(k, ttl) {
      const e = live(k);
      const n = (e ? Number(e.v) : 0) + 1;
      map.set(k, { v: String(n), until: e?.until ?? now() + ttl * 1000 });
      return n;
    },
    async del(k) {
      map.delete(k);
    },
  };
}

/** Redis з запасним станом у пам'яті: відмова Redis не знімає жодної стелі. */
export function redisKv(client: Redis, prefix: string, onError?: (err: unknown) => void): Kv {
  const fallback = memoryKv();
  const guarded =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>, alt: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      try {
        return await fn(...a);
      } catch (err) {
        onError?.(err);
        return alt(...a);
      }
    };
  return {
    get: guarded((k: string) => client.get(prefix + k), fallback.get),
    set: guarded(async (k: string, v: string, ttl: number) => void (await client.set(prefix + k, v, 'EX', ttl)), fallback.set),
    incr: guarded(async (k: string, ttl: number) => {
      const n = await client.incr(prefix + k);
      if (n === 1) await client.expire(prefix + k, ttl);
      return n;
    }, fallback.incr),
    del: guarded(async (k: string) => void (await client.del(prefix + k)), fallback.del),
  };
}

export interface GuardLimits {
  ytdlpPerHour: number;
  ytdlpPerDay: number;
  /** Найменший проміжок між запусками yt-dlp. */
  minGapMs: number;
  /** Скільки бот-перевірок поспіль — і пауза. */
  tripAfter: number;
  /** Пауза після бот-перевірок поспіль. */
  pauseMs: number;
  /** Пауза після 429 — довша: це пряме «пригальмуй». */
  pause429Ms: number;
  /** Скільки пам'ятати відео з бот-перевіркою. */
  blockedTtlSec: number;
  /** Власна добова стеля одиниць Data API (квота Google — 10 000). */
  unitsPerDay: number;
}

export const DEFAULT_GUARD: GuardLimits = {
  ytdlpPerHour: 20,
  ytdlpPerDay: 100,
  minGapMs: 10_000,
  tripAfter: 5,
  pauseMs: 30 * 60_000,
  pause429Ms: 60 * 60_000,
  blockedTtlSec: 24 * 3600,
  unitsPerDay: 5_000,
};

export type Admission = { ok: true } | { ok: false; reason: string };

const hourKey = (t: number) => `ytdlp:h:${new Date(t).toISOString().slice(0, 13)}`;
const dayKey = (t: number) => `ytdlp:d:${new Date(t).toISOString().slice(0, 10)}`;
const unitsKey = (t: number) => `units:${new Date(t).toISOString().slice(0, 10)}`;
const hhmm = (t: number) => `${new Date(t).toISOString().slice(11, 16)}Z`;

export class Guard {
  /** Дзеркало паузи для синхронного health() — істина в kv. */
  pausedUntil = 0;
  pauseReason: string | null = null;
  private nextStart = 0;

  constructor(
    private readonly kv: Kv,
    readonly limits: GuardLimits,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async paused(): Promise<number> {
    const until = Number((await this.kv.get('pause')) ?? 0);
    this.pausedUntil = until > this.now() ? until : 0;
    if (!this.pausedUntil) this.pauseReason = null;
    return this.pausedUntil;
  }

  /**
   * Чи можна зараз запустити yt-dlp. Так — слот уже зайнятий (лічильники
   * годин/доби +1) і дотримано проміжок після попереднього запуску.
   */
  async admitYtDlp(): Promise<Admission> {
    const until = await this.paused();
    if (until) {
      return { ok: false, reason: `yt-dlp на паузі до ${hhmm(until)} (${this.pauseReason ?? 'YouTube відмовляв'}) — шлюз YouTube не питав` };
    }
    const t = this.now();
    const [h, d] = await Promise.all([this.kv.get(hourKey(t)), this.kv.get(dayKey(t))]);
    if (Number(h ?? 0) >= this.limits.ytdlpPerHour) {
      return { ok: false, reason: `стеля шлюзу: ${this.limits.ytdlpPerHour} запусків yt-dlp на годину — наступна година` };
    }
    if (Number(d ?? 0) >= this.limits.ytdlpPerDay) {
      return { ok: false, reason: `стеля шлюзу: ${this.limits.ytdlpPerDay} запусків yt-dlp на добу UTC — завтра` };
    }
    await Promise.all([this.kv.incr(hourKey(t), 3600), this.kv.incr(dayKey(t), 86_400)]);
    // Проміжок: виклики вже йдуть по одному (семафор), тож досить чекати тут.
    const start = Math.max(this.nextStart, t);
    this.nextStart = start + this.limits.minGapMs;
    if (start > t) await this.sleep(start - t);
    return { ok: true };
  }

  /** Відповідь YouTube на запуск: успіх скидає лічильник відмов, відмови ведуть до паузи. */
  async record(outcome: 'ok' | 'bot' | '429'): Promise<void> {
    if (outcome === 'ok') {
      await this.kv.del('fails');
      return;
    }
    if (outcome === '429') {
      await this.pause(this.limits.pause429Ms, 'YouTube відповів 429');
      return;
    }
    const n = await this.kv.incr('fails', 6 * 3600);
    if (n >= this.limits.tripAfter) {
      await this.kv.del('fails');
      await this.pause(this.limits.pauseMs, `${n} бот-перевірок поспіль`);
    }
  }

  private async pause(ms: number, why: string): Promise<void> {
    const until = this.now() + ms;
    await this.kv.set('pause', String(until), Math.ceil(ms / 1000));
    this.pausedUntil = until;
    this.pauseReason = why;
  }

  async isBlocked(videoId: string): Promise<boolean> {
    return (await this.kv.get(`blocked:${videoId}`)) !== null;
  }

  async markBlocked(videoId: string): Promise<void> {
    await this.kv.set(`blocked:${videoId}`, '1', this.limits.blockedTtlSec);
  }

  /** Одна одиниця Data API: false — власна добова стеля вичерпана, запиту не буде. */
  async takeUnit(): Promise<boolean> {
    const n = await this.kv.incr(unitsKey(this.now()), 86_400);
    return n <= this.limits.unitsPerDay;
  }

  /** Кеш (транскрипти): JSON із TTL. */
  async cacheGet<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(`cache:${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
    await this.kv.set(`cache:${key}`, JSON.stringify(value), ttlSec);
  }
}
