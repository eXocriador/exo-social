import { fetchJson } from '@exo/kit-ui';

/** Клієнт API — тонкий. Поки в продукту немає маршрутів, є проба здоров'я. */
export interface Live {
  status: string;
  version: string;
}

export const api = {
  live: () => fetchJson<Live>('/health/live'),
};
