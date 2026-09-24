/**
 * Облік — рядок на виклик інструмента (connectors.md §3): продукт, адаптер,
 * акаунт, розмова, інструмент, скільки елементів і байтів віддано, чи обрізано.
 *
 * Як в exo-ai (`src/accounting/ledger.ts`): запис НЕ тримає відповідь і не
 * валить її. Облік — звітність; моргнув Постгрес — день недорахується, а
 * продукт відповідь отримає. (Область, навпаки, fail-closed — scope.ts.)
 */
import type { Db } from '@exo/kit/infra';

export type Outcome =
  | 'ok'
  /** Розмови немає або вона поза областю — невідрізненно для викликача, але тут видно. */
  | 'not_found'
  | 'bad_request'
  /** Денна стеля продукту. */
  | 'quota'
  /** Стеля частоти платформи. */
  | 'rate_limited'
  /** Вхід адаптера відхилено. */
  | 'expired'
  /** Інструмент недосяжний або область не прочиталась. */
  | 'unavailable'
  | 'error';

export interface CallRecord {
  product: string;
  transport: 'rest' | 'mcp';
  tool: string;
  adapter: string | null;
  account: string | null;
  conversation: string | null;
  outcome: Outcome;
  items: number;
  bytes: number;
  truncated: boolean;
  latencyMs: number;
  detail: string | null;
}

export interface Ledger {
  record(row: CallRecord): Promise<void>;
}

export function createLedger(db: Db, logWarn?: (event: string, fields?: Record<string, unknown>) => void): Ledger {
  return {
    async record(row) {
      const out = await db.tryQuery(
        (sql) => sql`
          INSERT INTO social_call
            (product, transport, tool, adapter, account, conversation, outcome, items, bytes, truncated, latency_ms, detail)
          VALUES
            (${row.product}, ${row.transport}, ${row.tool}, ${row.adapter}, ${row.account}, ${row.conversation},
             ${row.outcome}, ${row.items}, ${row.bytes}, ${row.truncated}, ${row.latencyMs},
             ${row.detail ? row.detail.slice(0, 500) : null})`,
      );
      if (!out.ok) logWarn?.('ledger.write_failed', { reason: out.reason, tool: row.tool, product: row.product });
    },
  };
}
