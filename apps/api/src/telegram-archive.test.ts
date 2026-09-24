/**
 * Адаптер telegram-archive проти фальшивого переглядача: кука Secure руками,
 * перелогін на 401, стан входу (ok / expired / down), 429 — не вирок, обхід дня.
 */
import { describe, expect, it } from 'vitest';
import { ViewerClient, readCookie } from './adapters/telegram-archive/client.js';
import { collectDay, createTelegramArchive } from './adapters/telegram-archive/index.js';
import { AdapterError } from './adapters/types.js';
import { dayBounds } from './time.js';

interface Viewer {
  password: string;
  /** Токени, які переглядач вважає живими. */
  sessions: Set<string>;
  loginStatus?: number;
  down?: boolean;
  calls: { method: string; path: string; cookie: string | null }[];
  chats: Record<string, unknown>[];
  messages: Record<string, unknown>[];
}

function viewer(over: Partial<Viewer> = {}): Viewer {
  return { password: 'right', sessions: new Set(), calls: [], chats: [], messages: [], ...over };
}

function fakeFetch(v: Viewer): typeof fetch {
  let n = 0;
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = /viewer_auth=([^;]+)/.exec(headers.cookie ?? '')?.[1] ?? null;
    v.calls.push({ method: init?.method ?? 'GET', path: url.pathname, cookie });
    if (v.down) throw new TypeError('fetch failed');
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

    if (url.pathname === '/api/login') {
      if (v.loginStatus) return json(v.loginStatus, { detail: 'nope' });
      const body = JSON.parse(String(init?.body)) as { password: string };
      if (body.password !== v.password) return json(401, { detail: 'Invalid credentials' });
      const token = `tok${++n}`;
      v.sessions.add(token);
      // Так, як ставить переглядач із SECURE_COOKIES=true.
      return json(200, { success: true }, { 'set-cookie': `viewer_auth=${token}; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax; Secure` });
    }
    if (url.pathname === '/api/logout') return json(200, {});
    const alive = cookie !== null && v.sessions.has(cookie);
    if (url.pathname === '/api/auth/check') return json(200, { authenticated: alive });
    if (!alive) return json(401, { detail: 'Not authenticated' });
    if (url.pathname === '/api/chats') return json(200, { chats: v.chats, total: v.chats.length, has_more: false });
    const m = /^\/api\/chats\/([^/]+)\/messages$/.exec(url.pathname);
    if (m) {
      if (m[1] !== 'REF1') return json(404, { detail: 'Chat not found' });
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const beforeId = Number(url.searchParams.get('before_id') ?? 0);
      const beforeDate = url.searchParams.get('before_date');
      let rows = v.messages;
      if (beforeDate) {
        const b = Date.parse(beforeDate.endsWith('Z') ? beforeDate : `${beforeDate}Z`);
        rows = rows.filter((r) => {
          const t = Date.parse(`${String(r.date)}Z`);
          return t < b || (t === b && beforeId > 0 && Number(r.id) < beforeId);
        });
      }
      return json(200, rows.slice(0, limit));
    }
    return json(404, { detail: 'Not Found' });
  }) as typeof fetch;
}

const opts = (v: Viewer, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'http://viewer',
  user: 'relic',
  pass: 'right',
  account: 'acc',
  fetch: fakeFetch(v),
  ...extra,
});

describe('кука Secure — руками', () => {
  it('береться з Set-Cookie і шлеться заголовком Cookie', async () => {
    const v = viewer({ chats: [{ id: 1, ref: 'REF1', type: 'private', first_name: 'A' }] });
    const a = createTelegramArchive(opts(v));
    const list = await a.listConversations('acc', { limit: 10, offset: 0 });
    expect(list.conversations[0]!.ref).toBe('telegram-archive:acc:REF1');
    const get = v.calls.find((c) => c.path === '/api/chats')!;
    expect(get.cookie).toBe('tok1');
  });

  it('readCookie читає рядок із Secure і не плутає з іншими куками', () => {
    const h = new Headers();
    h.append('set-cookie', 'other=1; Path=/');
    h.append('set-cookie', 'viewer_auth=abc.DEF-_; HttpOnly; Secure; SameSite=lax');
    expect(readCookie(h)).toBe('abc.DEF-_');
  });

  it('401 на запиті — перелогін один раз і повтор', async () => {
    const v = viewer({ messages: [{ id: 1, date: '2026-09-01T10:00:00', text: 'x' }] });
    const a = createTelegramArchive(opts(v));
    await a.getMessages('acc', 'REF1', { limit: 10, cursor: null });
    v.sessions.clear(); // переглядач скинув сесії (зміна прав або пароля)
    const batch = await a.getMessages('acc', 'REF1', { limit: 10, cursor: null });
    expect(batch.messages).toHaveLength(1);
    expect(v.calls.filter((c) => c.path === '/api/login')).toHaveLength(2);
  });
});

describe('стан входу', () => {
  it('ok → expired (пароль змінено) → ok (повернено)', async () => {
    const v = viewer();
    const a = createTelegramArchive(opts(v));
    expect((await a.probe('acc')).state).toBe('ok');

    v.password = 'changed';
    v.sessions.clear();
    const bad = await a.probe('acc');
    expect(bad.state).toBe('expired');
    expect(bad.reason).toMatch(/відхилив вхід/);

    v.password = 'right';
    expect((await a.probe('acc')).state).toBe('ok');
  });

  it('після відмови виклики інструментів не палять стелю входів — до наступної проби', async () => {
    const v = viewer({ password: 'changed' });
    let now = 1_000_000;
    const a = createTelegramArchive(opts(v, { now: () => now, loginBackoffMs: 60_000 }));
    expect((await a.probe('acc')).state).toBe('expired');
    const before = v.calls.filter((c) => c.path === '/api/login').length;
    for (let i = 0; i < 5; i++) {
      await expect(a.getMessages('acc', 'REF1', { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'expired' });
    }
    expect(v.calls.filter((c) => c.path === '/api/login').length).toBe(before);
    now += 61_000;
    await expect(a.getMessages('acc', 'REF1', { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'expired' });
    expect(v.calls.filter((c) => c.path === '/api/login').length).toBe(before + 1);
  });

  it('недосяжний переглядач — down', async () => {
    const a = createTelegramArchive(opts(viewer({ down: true })));
    const h = await a.probe('acc');
    expect(h.state).toBe('down');
  });

  it('429 на вході — не вирок: стан лишається, яким був', async () => {
    const v = viewer();
    const a = createTelegramArchive(opts(v));
    expect((await a.probe('acc')).state).toBe('ok');
    v.sessions.clear();
    v.loginStatus = 429;
    const h = await a.probe('acc');
    expect(h.state).toBe('ok');
    expect(h.limited).toBe(true);
  });

  it('виклик інструмента теж свідок: відмова видна одразу, не за хвилину', async () => {
    const v = viewer();
    const a = createTelegramArchive(opts(v));
    await a.probe('acc');
    v.sessions.clear();
    v.password = 'changed';
    await expect(a.getMessages('acc', 'REF1', { limit: 5, cursor: null })).rejects.toBeInstanceOf(AdapterError);
    expect(a.health('acc').state).toBe('expired');
  });

  it('чужий акаунт і невідомий ref — not_found', async () => {
    const a = createTelegramArchive(opts(viewer()));
    await expect(a.getMessages('other', 'REF1', { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(a.getMessages('acc', 'NOPE', { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('курсор з чужого адаптера — bad_request, а не тихий початок з голови', async () => {
    const a = createTelegramArchive(opts(viewer()));
    await expect(a.getMessages('acc', 'REF1', { limit: 5, cursor: 'garbage' })).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('ViewerClient: паралельні виклики на старті — один вхід', async () => {
    const v = viewer({ messages: [] });
    const c = new ViewerClient({ baseUrl: 'http://viewer', user: 'u', pass: 'right', fetch: fakeFetch(v) });
    await Promise.all(Array.from({ length: 5 }, () => c.get('/api/chats')));
    expect(v.calls.filter((x) => x.path === '/api/login')).toHaveLength(1);
  });
});

describe('курсор get_messages', () => {
  it('next веде на старішу сторінку без повторів', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ id: 10 - i, date: `2026-09-01T10:00:${String(10 - i).padStart(2, '0')}` }));
    const a = createTelegramArchive(opts(viewer({ messages })));
    const first = await a.getMessages('acc', 'REF1', { limit: 4, cursor: null });
    expect(first.messages.map((m) => m.id)).toEqual([10, 9, 8, 7]);
    expect(first.maybeMore).toBe(true);
    const second = await a.getMessages('acc', 'REF1', { limit: 4, cursor: a.cursorOf(first.messages[3]!) });
    expect(second.messages.map((m) => m.id)).toEqual([6, 5, 4, 3]);
  });
});

describe('обхід дня (collectDay)', () => {
  // Повідомлення кожні 10 хв з 2026-09-01 20:00 до 2026-09-03 04:00 UTC, новіші першими.
  const all: Record<string, unknown>[] = [];
  let id = 1;
  for (let t = Date.UTC(2026, 8, 1, 20); t <= Date.UTC(2026, 8, 3, 4); t += 10 * 60_000) {
    all.push({ id: id++, date: new Date(t).toISOString().slice(0, 19) });
  }
  all.reverse();
  const page = (size: number) => async (cur: { date: string; id: number }) => {
    const b = Date.parse(`${cur.date}Z`);
    return all
      .filter((r) => {
        const t = Date.parse(`${String(r.date)}Z`);
        return t < b || (t === b && cur.id > 0 && Number(r.id) < cur.id);
      })
      .slice(0, size);
  };

  it('рівно доба UTC, старіші першими', async () => {
    const { rows, truncated } = await collectDay(dayBounds('2026-09-02', 'UTC'), 1000, page(50));
    expect(rows).toHaveLength(144);
    expect(truncated).toBe(false);
    expect((rows[0] as { date: string }).date).toBe('2026-09-02T00:00:00');
    expect((rows[143] as { date: string }).date).toBe('2026-09-02T23:50:00');
  });

  it('день у поясі: Europe/Kyiv (UTC+3 у вересні) зсуває межі', async () => {
    const { rows } = await collectDay(dayBounds('2026-09-02', 'Europe/Kyiv'), 1000, page(50));
    expect((rows[0] as { date: string }).date).toBe('2026-09-01T21:00:00');
    expect((rows[rows.length - 1] as { date: string }).date).toBe('2026-09-02T20:50:00');
  });

  it('більше за limit — лишаються найстаріші, truncated', async () => {
    const { rows, truncated } = await collectDay(dayBounds('2026-09-02', 'UTC'), 10, page(7));
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(10);
    expect((rows[0] as { date: string }).date).toBe('2026-09-02T00:00:00');
  });

  it('курсор, що не рухається, не крутить вічно', async () => {
    const stuck = async () => [{ id: 5, date: '2026-09-02T12:00:00' }];
    const { rows } = await collectDay(dayBounds('2026-09-02', 'UTC'), 100, stuck);
    expect(rows).toHaveLength(1);
  });

  it('невірна дата й пояс — помилка аргументу', () => {
    expect(() => dayBounds('2026-02-30', 'UTC')).toThrow(/YYYY-MM-DD/);
    expect(() => dayBounds('2026-09-02', 'Mars/Olympus')).toThrow(/IANA/);
  });
});
