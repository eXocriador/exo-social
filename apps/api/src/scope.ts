/**
 * Область дії ключа — рядки `social_scope` (connectors.md §3).
 *
 * Рядок: (продукт, адаптер, акаунт, розмови, read|write). Розмови — список ref
 * шлюзу або `{*}` = «усе, що бачить акаунт адаптера». Продукт без рядків —
 * ПОРОЖНЯ область, а не «усе»: новий ключ нічого не читає, доки власник не
 * видав рядок.
 *
 * Політика живе лише тут, на боці сервера (§1.2): бібліотека в продукті обійшла
 * б себе сама. Тому недоступна БД — це відмова (fail-CLOSED), на відміну від
 * обліку й стель, які fail-open: не знати, що дозволено, не можна вирішити на
 * користь викликача.
 */
import type { Db } from '@exo/kit/infra';
import type { ScopeRef } from './health.js';
import { formatRef, parseRef, type ConversationRef } from './shape.js';

export type Access = 'read' | 'write';

export interface Grant {
  adapter: string;
  account: string;
  /** `['*']` або список ref шлюзу. */
  conversations: string[];
  access: Access;
}

export class ScopeUnavailable extends Error {
  constructor(reason: string) {
    super(`область ключа не прочиталась (${reason}) — шлюз відмовляє, а не вгадує`);
    this.name = 'ScopeUnavailable';
  }
}

export interface ScopeStore {
  /** Рядки продукту з цим доступом. Кидає ScopeUnavailable, якщо БД не відповіла. */
  grants(product: string, access: Access): Promise<Grant[]>;
}

export function isWildcard(g: Grant): boolean {
  return g.conversations.length === 1 && g.conversations[0] === '*';
}

/** Рядок, що відкриває цю розмову, або null. */
export function grantFor(grants: Grant[], ref: ConversationRef): Grant | null {
  const full = formatRef(ref);
  return (
    grants.find(
      (g) => g.adapter === ref.adapter && g.account === ref.account && (isWildcard(g) || g.conversations.includes(full)),
    ) ?? null
  );
}

export function createScopeStore(db: Db): ScopeStore {
  return {
    async grants(product, access) {
      const out = await db.tryQuery(
        (sql) => sql<Grant[]>`
          SELECT adapter, account, conversations, access
          FROM social_scope
          WHERE product = ${product} AND access = ${access}
          ORDER BY id`,
      );
      if (!out.ok) throw new ScopeUnavailable(out.reason);
      return out.rows.map((r) => ({ ...r, conversations: [...r.conversations] }));
    },
  };
}

/**
 * Явні ref усіх областей (не `*`) — для здоров'я доступу: ref, якого акаунт
 * адаптера не бачить, — мертвий рядок області. Кидає, якщо БД не відповіла:
 * тоді здоров'я судить лише кількість видимих розмов.
 */
export function createScopeRefs(db: Db): () => Promise<ScopeRef[]> {
  return async () => {
    const out = await db.tryQuery(
      (sql) => sql<{ ref: string }[]>`
        SELECT DISTINCT unnest(conversations) AS ref
        FROM social_scope
        WHERE conversations <> ARRAY['*']::text[]`,
    );
    if (!out.ok) throw new ScopeUnavailable(out.reason);
    return out.rows.flatMap((r) => {
      const p = r.ref === '*' ? null : parseRef(r.ref);
      return p ? [{ adapter: p.adapter, account: p.account, ref: formatRef(p) }] : [];
    });
  };
}
