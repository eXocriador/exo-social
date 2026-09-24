import { timingSafeEqual } from 'node:crypto';

/**
 * Ключ на продукт — механіка exo-ai (`src/http/auth.ts`), перенесена, а не
 * імпортована: шлюзи один про одного не знають (connectors.md, вступ).
 *
 * Ключ не просто пускає, а НАЗИВАЄ продукт. Саме це ім'я шукається в області
 * (`social_scope.product`) і їде в облік, тож підробити його клієнт не може.
 */
export interface ProductKeys {
  /** Ім'я продукту за ключем, або null. */
  resolve(key: string | null): string | null;
  /** Секрет продукту — лише для stdio-входу, що ходить у свій же /mcp. */
  secretOf(product: string): string | null;
  readonly products: readonly string[];
}

export class KeyConfigError extends Error {}

const PRODUCT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Розібрати `PRODUCT_KEYS`: "claude:SECRET,exopost:SECRET". */
export function parseProductKeys(raw: string): ProductKeys {
  const byKey = new Map<string, string>();
  const byProduct = new Map<string, string>();

  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    const at = entry.indexOf(':');
    if (at <= 0 || at === entry.length - 1) {
      throw new KeyConfigError(`PRODUCT_KEYS: запис "${entry.slice(0, 12)}…" не має вигляду продукт:секрет`);
    }
    const product = entry.slice(0, at).trim();
    const secret = entry.slice(at + 1).trim();
    if (!PRODUCT_NAME.test(product)) {
      throw new KeyConfigError(`PRODUCT_KEYS: ім'я продукту "${product.slice(0, 40)}" — kebab-case латиницею`);
    }
    if (secret.length < 16) {
      // Довжина, а не значення: повідомлення про ключі не має містити ключів.
      throw new KeyConfigError(`PRODUCT_KEYS: секрет продукту "${product}" коротший за 16 символів`);
    }
    if (byKey.has(secret)) {
      throw new KeyConfigError('PRODUCT_KEYS: один секрет виданий двом продуктам — облік і область не розділились би');
    }
    if (byProduct.has(product)) {
      throw new KeyConfigError(`PRODUCT_KEYS: продукт "${product}" має два ключі — ротація робиться заміною, не додаванням`);
    }
    byKey.set(secret, product);
    byProduct.set(product, secret);
  }

  if (byKey.size === 0) throw new KeyConfigError('PRODUCT_KEYS порожній — шлюз нікого не обслужив би');

  return {
    products: [...byProduct.keys()],
    secretOf: (product) => byProduct.get(product) ?? null,
    resolve(key) {
      if (!key) return null;
      // Порівняння сталого часу по всіх кандидатах: наївний Map.get(key)
      // порівнює рядки достроково і зливає префікс ключа по таймінгу.
      let found: string | null = null;
      for (const [secret, product] of byKey) {
        if (constantTimeEqual(secret, key)) found = product;
      }
      return found;
    },
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual вимагає однакової довжини. Різна довжина сама по собі не
  // секрет — її видно і з мережевого пакета.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `Authorization: Bearer <key>`, або `X-Api-Key: <key>`. */
export function readKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = first(headers['authorization']);
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  const direct = first(headers['x-api-key']);
  return direct ? direct.trim() : null;
}

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
