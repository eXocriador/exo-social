/**
 * Денна стеля викликів на продукт — механіка exo-ai (`src/accounting/budget.ts`),
 * перенесена, а не імпортована. Кожна властивість — свідомо:
 *
 *   • INCR + EXPIRE NX: TTL прикріплюється до першого за день виклику, а не
 *     зсувається кожним наступним (інакше лічильник не скидався б ніколи);
 *   • ключ із датою UTC і TTL 48 год: день доживає далеко за північ і
 *     обертається сам, точку скидання не рухає пояс сервера;
 *   • рахується ПЕРЕД викликом: сторож, що рахує лише успіхи, накручується
 *     невдалими викликами довільно високо;
 *   • fail-OPEN: недоступний Redis не гасить читання. Вимкнути НАШ Redis, щоб
 *     підняти собі стелю, продукт не може.
 *
 * Стеля — не білінг: 429 `budget_exhausted` каже продуктові деградувати
 * (менше читати, передати людині), а не показувати помилку.
 */
import type { RedisCache } from '@exo/kit/infra';

const KEY_TTL_SECONDS = 172_800;

export function quotaKey(product: string, now: Date = new Date()): string {
  return `exosocial:product:${product}:${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** `null` — порахувати не вдалось (Redis немає або моргнув), пропущено. */
  used: number | null;
  cap: number;
}

export interface Quota {
  consume(product: string, now?: Date): Promise<QuotaVerdict>;
  used(product: string, now?: Date): Promise<number | null>;
  readonly cap: number;
}

export function createQuota(
  redis: RedisCache,
  cap: number,
  logWarn?: (event: string, fields?: Record<string, unknown>) => void,
): Quota {
  return {
    cap,
    async consume(product, now = new Date()) {
      const client = redis.client;
      if (!client || redis.breakerOpen()) return { allowed: true, used: null, cap };
      const key = quotaKey(product, now);
      try {
        // `EXPIRE … NX` потребує Redis ≥ 7.0; у нас 8.
        const res = await client.multi().incr(key).expire(key, KEY_TTL_SECONDS, 'NX').exec();
        const used = Number(res?.[0]?.[1] ?? 0);
        if (!Number.isFinite(used) || used <= 0) return { allowed: true, used: null, cap };
        return { allowed: used <= cap, used, cap };
      } catch {
        redis.reportFailure();
        logWarn?.('quota.counter_unavailable', { product });
        return { allowed: true, used: null, cap };
      }
    },
    async used(product, now = new Date()) {
      const client = redis.client;
      if (!client || redis.breakerOpen()) return null;
      try {
        const n = Number(await client.get(quotaKey(product, now)));
        return Number.isFinite(n) ? n : 0;
      } catch {
        return null;
      }
    },
  };
}
