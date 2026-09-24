/**
 * Спільна форма даних (connectors.md §3) — одна на всі адаптери.
 *
 * Продукт і модель бачать ЛИШЕ її: ні `raw_data` Telethon, ні шляхів до
 * медіа, ні числових id платформи. Адаптер перекладає свою відповідь сюди, а
 * бюджет відповіді рахує байти вже цієї форми.
 */

/** Розмова. `ref` — `<адаптер>:<акаунт>:<id адаптера>`, стабільний. */
export interface Conversation {
  ref: string;
  name: string;
  type: string;
  platform: string;
  last_message?: string;
  participants?: number;
}

/**
 * Повідомлення. Порожні поля пропускаються (як `omitempty` у форку): на 100
 * повідомленнях `"fwd":false` одинадцяти полів — це кілобайти бюджету.
 */
export interface Message {
  id: number | string;
  /** ISO 8601, UTC, із `Z`. */
  date: string;
  from?: string;
  out?: boolean;
  text?: string;
  reply_to?: number | string;
  topic?: number | string;
  /** `тип[: ім'я]` */
  media?: string;
  fwd?: boolean;
  edited?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  /** Текст укорочено, щоб повідомлення влізло в бюджет. */
  cut?: boolean;
}

/** Розібраний ref шлюзу. */
export interface ConversationRef {
  adapter: string;
  account: string;
  /** id розмови в адаптері (для telegram-archive — `ref` переглядача). */
  id: string;
}

const REF = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9-]*):(.+)$/;

export function formatRef(ref: ConversationRef): string {
  return `${ref.adapter}:${ref.account}:${ref.id}`;
}

/** `null` — не ref шлюзу. id адаптера може сам містити «:», тож ділиться лише двічі. */
export function parseRef(raw: string): ConversationRef | null {
  const m = REF.exec(raw.trim());
  if (!m || m[3]!.length > 200) return null;
  return { adapter: m[1]!, account: m[2]!, id: m[3]! };
}

/**
 * Курсор — непрозорий рядок: у telegram-archive це дата й id останнього
 * повідомлення, у YouTube буде pageToken. Продукт його не розбирає, лише
 * повертає; тому і форма одна на всі адаптери.
 */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(raw: string, check: (v: unknown) => v is T): T | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return check(value) ? value : null;
  } catch {
    return null;
  }
}
