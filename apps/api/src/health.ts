/**
 * Здоров'я бачить вхід кожного адаптера (connectors.md §3, «Здоров'я»).
 *
 * Вада exo-ai, яку тут НЕ копіюємо: там протухла автентифікація Google лишає
 * `/health/ready` і Kuma зеленими (пули стають `unknown`, а не `down`), і
 * сигнал живе лише в обліку. Тут відхилений вхід увімкненого адаптера — це
 * 503 проби: шлюз для цього адаптера непридатний, і монітор мусить це бачити.
 *
 * Проба ходить за розкладом, а не на кожен запит монітора: відхилений вхід
 * переглядача — теж спроба, а стеля входів там 15 за 5 хв на IP. `/health/ready`
 * читає останній стан; виклики інструментів оновлюють його теж (adapter.observed).
 *
 * Поруч зі входом — ДОСТУП: скільки розмов акаунт бачить і чи всі явні ref
 * областей серед них. Порожній доступ — `degraded` (200, `status: "degraded"`),
 * а не 503: шлюз справний, просто власник ще нічого не відкрив. Kuma бачить його
 * окремим монітором-ключовим словом `"status":"ok"` (README, «Здоров'я»).
 */
import type { AccessHealth, AccountHealth, AdapterRegistry, LoginState } from './adapters/types.js';

/** Явний ref області (не `*`) — з рядків `social_scope` усіх продуктів. */
export interface ScopeRef {
  adapter: string;
  account: string;
  ref: string;
}

const WORST: LoginState[] = ['expired', 'down', 'unknown', 'skip', 'ok'];

/** Найгірший стан серед акаунтів адаптера: один протухлий акаунт — адаптер непридатний. */
export function worst(states: LoginState[]): LoginState {
  for (const s of WORST) if (states.includes(s)) return s;
  return 'ok';
}

/**
 * Чи валить цей стан пробу готовності. `unknown` — лише до першої проби, і він
 * не вирок; `skip` — вхід вимкнений конфігом свідомо.
 */
export function failsReady(state: LoginState): boolean {
  return state === 'expired' || state === 'down';
}

/**
 * Вирок доступу з того, що акаунт бачить, і явних ref областей. Порожній доступ
 * і мертвий ref — `degraded`: шлюз живий, але продукт через нього нічого (або не
 * все обіцяне) не прочитає.
 *
 * Мертвий ref у білому списку САМОГО акаунта переглядача звідси не видно:
 * переглядач мовчки відкидає його і свого списку акаунту не показує. Коли він
 * там єдиний — це `visible: 0`, тобто той самий `degraded`.
 */
export function judgeAccess(
  base: { adapter: string; account: string },
  seen: { total: number; refs: string[] },
  scope: ScopeRef[],
  at: string,
): AccessHealth {
  const visible = new Set(seen.refs);
  const missing = [
    ...new Set(scope.filter((s) => s.adapter === base.adapter && s.account === base.account && !visible.has(s.ref)).map((s) => s.ref)),
  ];
  const reasons: string[] = [];
  if (seen.total === 0) reasons.push('акаунт не бачить жодної розмови — відкрийте чати в білому списку інструмента');
  if (missing.length) reasons.push(`область називає ${missing.length} ref, яких акаунт не бачить — чат зник або його закрили`);
  return {
    ...base,
    state: reasons.length ? 'degraded' : 'ok',
    visible: seen.total,
    missing,
    reason: reasons.length ? reasons.join('; ') : null,
    checkedAt: at,
  };
}

export function createAdapterHealth(opts: {
  adapters: AdapterRegistry;
  intervalMs: number;
  /** Явні ref областей; без нього доступ судиться лише за кількістю видимих розмов. */
  scopeRefs?: () => Promise<ScopeRef[]>;
  now?: () => number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const now = opts.now ?? Date.now;
  const access = new Map<string, AccessHealth>();
  const key = (adapter: string, account: string) => `${adapter}\u0000${account}`;
  const unknownAccess = (adapter: string, account: string, reason: string): AccessHealth => ({
    adapter,
    account,
    state: 'unknown',
    visible: null,
    missing: [],
    reason,
    checkedAt: null,
  });

  /** Доступ акаунтів, у яких він є (адаптери з visibleRefs). */
  function accessSnapshot(): AccessHealth[] {
    return [...opts.adapters.values()]
      .filter((a) => a.visibleRefs)
      .flatMap((a) => a.accounts.map((acc) => access.get(key(a.name, acc)) ?? unknownAccess(a.name, acc, 'ще не дивились')));
  }

  /** Найгірший доступ адаптера — те, що йде в `checks` як `<адаптер>.access`. */
  function accessStates(): Record<string, AccessHealth['state']> {
    const out: Record<string, AccessHealth['state']> = {};
    for (const h of accessSnapshot()) {
      const k = `${h.adapter}.access`;
      const prev = out[k];
      out[k] = prev === 'degraded' || h.state === 'degraded' ? 'degraded' : prev === 'unknown' || h.state === 'unknown' ? 'unknown' : 'ok';
    }
    return out;
  }

  function snapshot(): AccountHealth[] {
    return [...opts.adapters.values()].flatMap((a) => a.accounts.map((acc) => a.health(acc)));
  }

  /** Стан кожного адаптера — те, що йде в `checks` проби. */
  function states(): Record<string, LoginState> {
    const out: Record<string, LoginState> = {};
    for (const a of opts.adapters.values()) out[a.name] = worst(a.accounts.map((acc) => a.health(acc).state));
    return out;
  }

  async function sweep(): Promise<void> {
    let scope: ScopeRef[] | null = null;
    if (opts.scopeRefs) {
      try {
        scope = await opts.scopeRefs();
      } catch (err) {
        opts.logWarn?.('adapter.scope_refs_failed', { reason: (err as Error).message });
      }
    }
    await Promise.all(
      [...opts.adapters.values()].flatMap((a) =>
        a.accounts.map(async (acc) => {
          const before = a.health(acc).state;
          const after = await a.probe(acc);
          if (after.state !== before) {
            const log = after.state === 'ok' ? opts.logInfo : opts.logWarn;
            log?.('adapter.state', { adapter: a.name, account: acc, from: before, to: after.state, reason: after.reason });
          }
          if (!a.visibleRefs) return;
          const k = key(a.name, acc);
          const was = access.get(k)?.state ?? 'unknown';
          let next: AccessHealth;
          if (after.state !== 'ok') {
            next = unknownAccess(a.name, acc, 'вхід не ok — вирок дає вхід');
          } else {
            try {
              const seen = await a.visibleRefs(acc);
              // Область не прочиталась — судимо лише кількість, мертвих ref не вигадуємо.
              next = judgeAccess({ adapter: a.name, account: acc }, seen, scope ?? [], new Date(now()).toISOString());
            } catch (err) {
              next = unknownAccess(a.name, acc, (err as Error).message);
            }
          }
          access.set(k, next);
          if (next.state !== was) {
            const log = next.state === 'degraded' ? opts.logWarn : opts.logInfo;
            log?.('adapter.access', { adapter: a.name, account: acc, from: was, to: next.state, visible: next.visible, missing: next.missing.length });
          }
        }),
      ),
    );
  }

  return {
    snapshot,
    states,
    accessSnapshot,
    accessStates,
    sweep,
    start() {
      timer ??= setInterval(() => void sweep(), opts.intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type AdapterHealth = ReturnType<typeof createAdapterHealth>;
