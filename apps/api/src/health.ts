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
 */
import type { AccountHealth, AdapterRegistry, LoginState } from './adapters/types.js';

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

export function createAdapterHealth(opts: {
  adapters: AdapterRegistry;
  intervalMs: number;
  logInfo?: (event: string, fields?: Record<string, unknown>) => void;
  logWarn?: (event: string, fields?: Record<string, unknown>) => void;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;

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
    await Promise.all(
      [...opts.adapters.values()].flatMap((a) =>
        a.accounts.map(async (acc) => {
          const before = a.health(acc).state;
          const after = await a.probe(acc);
          if (after.state !== before) {
            const log = after.state === 'ok' ? opts.logInfo : opts.logWarn;
            log?.('adapter.state', { adapter: a.name, account: acc, from: before, to: after.state, reason: after.reason });
          }
        }),
      ),
    );
  }

  return {
    snapshot,
    states,
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
