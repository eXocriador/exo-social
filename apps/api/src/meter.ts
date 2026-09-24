/**
 * Лічильник витрат ОДНОГО виклику інструмента — те, що платформа рахує нам:
 * одиниці квоти YouTube Data API (`units`), запуски yt-dlp (`ytdlp`).
 *
 * Сервіс відкриває лічильник на кожен виклик (`metered`), клієнт платформи
 * додає до нього (`charge`) — без протягування лічильника крізь кожен підпис
 * адаптера. Підсумок їде в `detail` рядка обліку (`units=3 ytdlp=1`), і на
 * відмову теж: квота Google списується й за запит, що впав. Звідси видно, скільки
 * добової квоти (10 000) з'їв кожен продукт — README продукту, «Облік».
 *
 * Поза викликом (проба здоров'я) `charge` нічого не робить: у пробі немає
 * продукту, на якого записати. Її ціна — стала і названа в README.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type Meter = Record<string, number>;

const store = new AsyncLocalStorage<Meter>();

/**
 * Виконати `fn` з лічильником `meter`. Лічильник заводить викликач, а не ця
 * функція: на відмову (проміс відхилено) він мусить лишитись у руках — квота
 * списана й тоді.
 */
export function metered<T>(meter: Meter, fn: () => Promise<T>): Promise<T> {
  return store.run(meter, fn);
}

export function charge(what: string, n = 1): void {
  const m = store.getStore();
  if (m) m[what] = (m[what] ?? 0) + n;
}

/** `units=3 ytdlp=1` або null, якщо виклик нічого платного не робив. */
export function meterDetail(m: Meter | undefined): string | null {
  if (!m) return null;
  const parts = Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`);
  return parts.length ? parts.join(' ') : null;
}
