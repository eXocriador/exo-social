import { Card } from '@exo/kit-ui';
import { useEffect, useState } from 'react';
import { api, type Live } from './api';

/** Порожній продукт: назва і версія з проби. Сторінки додаються тут. */
export function App() {
  const [live, setLive] = useState<Live | null>(null);
  useEffect(() => {
    void api.live().then(setLive, () => setLive(null));
  }, []);
  return (
    <main className="flex min-h-screen justify-center px-4 py-12">
      <Card className="grid h-fit w-full max-w-xl gap-2">
        <h1 className="text-2xl font-semibold">exo-social</h1>
        <p className="text-ink-tertiary">{live ? `версія ${live.version}` : 'Завантаження…'}</p>
      </Card>
    </main>
  );
}
