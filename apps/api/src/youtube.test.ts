/**
 * Адаптер youtube проти фальшивого Data API і фальшивого yt-dlp (справжній
 * процес: скрипт-підміна на місці бінарника): пагінація коментарів курсором
 * без повторів, бюджет на 5000 коментарів, транскрипт години мовлення ≤ 32 КБ
 * з `next`, стан ключа ok → expired → ok, квота й бот-перевірка — не вирок,
 * облік одиниць квоти в `detail`.
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { byteLength, DEFAULT_LIMITS } from './budget.js';
import { classify } from './adapters/youtube/data-api.js';
import { createYoutube, videoIdOf } from './adapters/youtube/index.js';
import { classifyRun, pickTrack, spawnYtDlp, toSegments, type VideoInfo } from './adapters/youtube/ytdlp.js';
import { AdapterError, createRegistry, type Adapter } from './adapters/types.js';
import { readEnv } from './env.js';
import { failsReady } from './health.js';
import type { CallRecord, Ledger } from './ledger.js';
import type { Quota } from './quota.js';
import type { Grant, ScopeStore } from './scope.js';
import { createService } from './service.js';

const VID = 'AAAAAAAAAAA';
const PROBE = 'PPPPPPPPPPP';

// ── фальшивий Data API ──────────────────────────────────────────────────────

interface Api {
  key: string;
  /** Гілок у відео; у кожної третьої — дві відповіді. */
  threads: number;
  /** Відповідь, якою API зустріне НАСТУПНИЙ запит (і лише його). */
  fail?: { status: number; body: unknown } | undefined;
  /** Усі запити, що дійшли. */
  calls: URL[];
  commentsDisabled?: boolean;
}

const googleError = (status: number, reason: string, detail?: string) => ({
  status,
  body: { error: { code: status, message: reason, errors: [{ reason }], ...(detail ? { details: [{ reason: detail }] } : {}) } },
});

/** Гілка i: верхній коментар датований на i хвилин раніше за полудень 2026-09-20. */
function thread(i: number) {
  const at = new Date(Date.UTC(2026, 8, 20, 12) - i * 60_000).toISOString();
  const top = { id: `c${i}`, snippet: { authorDisplayName: `@u${i}`, textOriginal: `коментар ${i} ${'x'.repeat(40)}`, publishedAt: at, updatedAt: at } };
  const replies =
    i % 3 === 0
      ? [1, 2].map((k) => ({
          id: `c${i}.r${k}`,
          snippet: { authorDisplayName: `@r${k}`, textOriginal: `відповідь ${k}`, parentId: `c${i}`, publishedAt: new Date(Date.parse(at) + k * 1000).toISOString(), updatedAt: new Date(Date.parse(at) + k * 1000).toISOString() },
        }))
      : [];
  return { id: `c${i}`, snippet: { topLevelComment: top, totalReplyCount: replies.length }, ...(replies.length ? { replies: { comments: replies } } : {}) };
}

function fakeApi(api: Api): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    api.calls.push(url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.hostname === 'captions.test') return json(200, hourOfCaptions());
    const key = (init?.headers as Record<string, string>)['x-goog-api-key'];
    if (api.fail) {
      const f = api.fail;
      api.fail = undefined;
      return json(f.status, f.body);
    }
    if (key !== api.key) return json(400, googleError(400, 'badRequest', 'API_KEY_INVALID').body);
    const path = url.pathname.split('/').pop();
    if (path === 'videos') {
      const id = url.searchParams.get('id');
      return json(200, { items: id === VID ? [{ id, snippet: { title: 'Відео' } }] : [] });
    }
    if (path === 'commentThreads') {
      if (url.searchParams.get('videoId') !== VID) return json(404, googleError(404, 'videoNotFound').body);
      if (api.commentsDisabled) return json(403, googleError(403, 'commentsDisabled').body);
      expect(url.searchParams.get('maxResults')).toBe('100');
      const start = Number.parseInt((url.searchParams.get('pageToken') ?? 'p0').slice(1), 10);
      const term = url.searchParams.get('searchTerms');
      const all = Array.from({ length: api.threads }, (_, i) => thread(i)).filter((t) => !term || t.snippet.topLevelComment.snippet.textOriginal.includes(term));
      const items = all.slice(start, start + 100);
      // pageToken справжнього API буває за 200 символів — курсор мусить його пронести.
      const next = start + 100 < all.length ? `p${start + 100}${'Q'.repeat(200)}` : undefined;
      return json(200, { items, ...(next ? { nextPageToken: next } : {}) });
    }
    return json(404, { error: { code: 404 } });
  }) as typeof fetch;
}

/** json3 години мовлення: рядок субтитрів кожні 3 с, по 8 слів. */
function hourOfCaptions() {
  const events = [{ tStartMs: 0, dDurationMs: 3_600_000, id: 1, wpWinPosId: 1 }];
  for (let t = 0; t < 3600; t += 3) {
    events.push({ tStartMs: t * 1000, dDurationMs: 3000, segs: [{ utf8: `слово${t} мовлення тут іде далі і ще трохи` }] } as never);
    events.push({ tStartMs: t * 1000 + 2900, aAppend: 1, segs: [{ utf8: '\n' }] } as never);
  }
  return { events };
}

// ── фальшивий yt-dlp: справжній процес ─────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'relic-ytdlp-'));

/** Скрипт на місці бінарника: друкує JSON плеєра або помилку yt-dlp. */
function fakeYtDlp(mode: 'ok' | 'bot' | 'none' | 'slow'): string {
  const path = join(dir, `yt-dlp-${mode}`);
  const info = {
    id: VID,
    title: 'Година',
    language: 'uk',
    duration: 3600,
    subtitles: mode === 'none' ? {} : { live_chat: [{ ext: 'json', url: 'x' }] },
    automatic_captions:
      mode === 'none'
        ? {}
        : {
            'uk-orig': [
              { ext: 'vtt', url: 'https://captions.test/vtt' },
              { ext: 'json3', url: 'https://captions.test/uk-orig' },
            ],
            en: [{ ext: 'json3', url: 'https://captions.test/en' }],
          },
  };
  const body = {
    ok: `process.stdout.write(${JSON.stringify(JSON.stringify(info))} + '\\n');`,
    none: `process.stdout.write(${JSON.stringify(JSON.stringify(info))} + '\\n');`,
    bot: `process.stderr.write("ERROR: [youtube] ${VID}: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ\\n"); process.exit(1);`,
    slow: 'setTimeout(() => {}, 10_000);',
  }[mode];
  // Оточення, яке отримав процес, — у файл: секрети шлюзу туди не мають потрапити.
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(`${path}.env`)}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

// ── обв'язка ────────────────────────────────────────────────────────────────

function yt(over: { api?: Partial<Api>; ytdlp?: 'ok' | 'bot' | 'none' | 'slow' | null; key?: string | null; now?: () => number } = {}) {
  const api: Api = { key: 'right', threads: 250, calls: [], ...over.api };
  const ytdlpPath = over.ytdlp === null ? null : fakeYtDlp(over.ytdlp ?? 'ok');
  const adapter = createYoutube({
    apiKey: over.key === undefined ? 'right' : over.key,
    probeVideo: PROBE,
    probeIntervalMs: 600_000,
    ytdlpPath,
    ytdlpTimeoutMs: 3_000,
    fetch: fakeApi(api),
    apiBase: 'https://api.test/youtube/v3',
    now: over.now,
  });
  return { adapter, api, ytdlpPath };
}

function serviceOver(adapter: Adapter) {
  const rows: CallRecord[] = [];
  const ledger: Ledger = { record: async (r) => void rows.push(r) };
  const quota: Quota = { cap: 1000, consume: async () => ({ allowed: true, used: 1, cap: 1000 }), used: async () => 1 };
  const grant: Grant = { adapter: 'youtube', account: 'public', conversations: ['*'], access: 'read' };
  const scope: ScopeStore = { grants: async (_p, access) => (access === 'read' ? [grant] : []) };
  const service = createService({ adapters: createRegistry([adapter]), scope, ledger, quota, limits: DEFAULT_LIMITS });
  return { service, rows };
}

const ctx = { product: 'claude', transport: 'mcp' as const };
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── id і URL ────────────────────────────────────────────────────────────────

describe('ref відео', () => {
  it('id і посилання всіх форм → 11 символів id; чуже — null', () => {
    for (const s of [
      VID,
      `https://www.youtube.com/watch?v=${VID}&t=42s`,
      `https://youtu.be/${VID}?si=x`,
      `youtube.com/shorts/${VID}`,
      `https://m.youtube.com/live/${VID}`,
      `https://www.youtube-nocookie.com/embed/${VID}`,
    ]) {
      expect(videoIdOf(s)).toBe(VID);
    }
    expect(videoIdOf('https://evil.test/watch?v=AAAAAAAAAAA')).toBeNull();
    expect(videoIdOf('short')).toBeNull();
  });

  it('сервіс канонізує ref ДО області й обліку: URL і id — одна розмова', async () => {
    const { adapter } = yt();
    const { service, rows } = serviceOver(adapter);
    const page = await service.getMessages(ctx, { conversation: `youtube:public:https://youtu.be/${VID}`, limit: 3 });
    expect(page.conversation).toBe(`youtube:public:${VID}`);
    await settle();
    expect(rows[0]!.conversation).toBe(`youtube:public:${VID}`);
  });

  it('list_chats для youtube порожній: відео не список розмов', async () => {
    const { adapter } = yt();
    const { service } = serviceOver(adapter);
    expect((await service.listChats(ctx, {})).conversations).toEqual([]);
  });
});

// ── коментарі ───────────────────────────────────────────────────────────────

describe('коментарі', () => {
  it('гілка, за нею її відповіді з reply_to; дати ISO UTC', async () => {
    const { adapter } = yt({ api: { threads: 4 } });
    const batch = await adapter.getMessages('public', VID, { limit: 100, cursor: null });
    expect(batch.messages.map((m) => m.id)).toEqual(['c0', 'c0.r1', 'c0.r2', 'c1', 'c2', 'c3', 'c3.r1', 'c3.r2']);
    expect(batch.messages[1]).toMatchObject({ reply_to: 'c0', from: '@r1' });
    expect(batch.messages[0]!.date).toMatch(/Z$/);
    expect(batch.maybeMore).toBe(false);
  });

  it('курсор: сторінки без повторів і без пропусків аж до кінця, pageToken у 200+ символів', async () => {
    const { adapter } = yt({ api: { threads: 250 } });
    const { service } = serviceOver(adapter);
    const conversation = `youtube:public:${VID}`;
    const seen: (string | number)[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await service.getMessages(ctx, { conversation, limit: 100, ...(cursor ? { cursor } : {}) });
      seen.push(...page.messages.map((m) => m.id));
      if (!page.truncated) break;
      expect(page.next).toBeDefined();
      cursor = page.next!;
    }
    // 250 гілок, у кожної третьої (84) — дві відповіді.
    expect(seen).toHaveLength(250 + 84 * 2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('бюджет: 5000 коментарів просять — ≤ 32 КБ, ≤ 100, truncated + next', async () => {
    const { adapter } = yt({ api: { threads: 5000 } });
    const { service, rows } = serviceOver(adapter);
    const page = await service.getMessages(ctx, { conversation: `youtube:public:${VID}`, limit: 5000 });
    expect(page.count).toBeLessThanOrEqual(100);
    expect(byteLength(page)).toBeLessThanOrEqual(32 << 10);
    expect(page.truncated).toBe(true);
    expect(page.next).toBeDefined();
    await settle();
    // Облік: одиниці квоти в detail — одна сторінка = одна одиниця.
    expect(rows[0]).toMatchObject({ adapter: 'youtube', account: 'public', outcome: 'ok', detail: 'units=1' });
  });

  it('пошук — searchTerms, одна одиниця', async () => {
    const { adapter, api } = yt({ api: { threads: 30 } });
    const batch = await adapter.searchMessages('public', VID, 'коментар 2', 20);
    expect(batch.messages.every((m) => m.reply_to !== undefined || m.text!.includes('коментар 2'))).toBe(true);
    expect(api.calls.at(-1)!.searchParams.get('searchTerms')).toBe('коментар 2');
  });

  it('день: лише коментарі цього дня, старіші першими; надто далекий день — відмова з ціною', async () => {
    const { adapter } = yt({ api: { threads: 250 } });
    // Гілка i — за i хвилин до полудня 2026-09-20 UTC: 250 гілок укладаються в той самий день.
    const day = await adapter.getMessagesByDate('public', VID, { date: '2026-09-20', timezone: null, limit: 100 });
    expect(day.messages).toHaveLength(100);
    expect(day.maybeMore).toBe(true);
    expect(day.messages[0]!.date < day.messages[1]!.date).toBe(true);
    const none = await adapter.getMessagesByDate('public', VID, { date: '2026-09-21', timezone: null, limit: 100 });
    expect(none.messages).toEqual([]);

    const far = yt({ api: { threads: 5000 } });
    await expect(far.adapter.getMessagesByDate('public', VID, { date: '2026-09-10', timezone: null, limit: 100 })).rejects.toMatchObject({
      kind: 'bad_request',
    });
  });

  it('коментарі вимкнені — bad_request з поясненням; відео немає — not_found', async () => {
    const { adapter } = yt({ api: { commentsDisabled: true } });
    await expect(adapter.getMessages('public', VID, { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(adapter.getMessages('public', 'BBBBBBBBBBB', { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'not_found' });
    expect(adapter.health('public').state).toBe('ok');
  });

  it('назва відео — getConversation, type video, кеш на годину', async () => {
    const { adapter, api } = yt();
    const c = await adapter.getConversation('public', `https://youtu.be/${VID}`);
    expect(c).toEqual({ ref: `youtube:public:${VID}`, name: 'Відео', type: 'video', platform: 'youtube' });
    await adapter.getConversation('public', VID);
    expect(api.calls.filter((u) => u.pathname.endsWith('/videos'))).toHaveLength(1);
  });
});

// ── стан ключа ──────────────────────────────────────────────────────────────

describe('стан входу = ключ Data API', () => {
  it('ok → expired (ключ відхилено) → ok; проба не частіше за інтервал', async () => {
    let t = 1_000_000;
    const { adapter, api } = yt({ now: () => t });
    expect((await adapter.probe('public')).state).toBe('ok');
    expect(api.calls.at(-1)!.searchParams.get('id')).toBe(PROBE);

    // Проба в межах інтервалу — без мережі.
    const before = api.calls.length;
    await adapter.probe('public');
    expect(api.calls.length).toBe(before);

    // Ключ відкликали: 400 API_KEY_INVALID — expired, і проба готовності валиться.
    api.key = 'other';
    t += 600_001;
    const h = await adapter.probe('public');
    expect(h.state).toBe('expired');
    expect(failsReady(h.state)).toBe(true);
    expect(h.reason).toMatch(/ключ/);

    // Ключ повернули.
    api.key = 'right';
    t += 600_001;
    expect((await adapter.probe('public')).state).toBe('ok');
  });

  it('403 accessNotConfigured і ключ з чужої IP — теж expired', () => {
    expect(classify(403, googleError(403, 'accessNotConfigured').body).kind).toBe('expired');
    expect(classify(403, googleError(403, 'forbidden', 'API_KEY_IP_ADDRESS_BLOCKED').body).kind).toBe('expired');
  });

  it('квота вичерпана — НЕ вирок: стан ok, limited з причиною; виклик — rate_limited', async () => {
    let t = 1_000_000;
    const { adapter, api } = yt({ now: () => t });
    await adapter.probe('public');
    api.fail = googleError(403, 'quotaExceeded');
    await expect(adapter.getMessages('public', VID, { limit: 5, cursor: null })).rejects.toMatchObject({ kind: 'rate_limited' });
    const h = adapter.health('public');
    expect(h.state).toBe('ok');
    expect(h.limited).toBe(true);
    expect(h.reason).toMatch(/квот/);
    expect(failsReady(h.state)).toBe(false);
    // Наступна вдала відповідь знімає `limited`.
    await adapter.getMessages('public', VID, { limit: 5, cursor: null });
    expect(adapter.health('public').limited).toBe(false);
    t += 1;
  });

  it('квота на першій пробі — ключ живий: ok, а не unknown', async () => {
    const { adapter, api } = yt();
    api.fail = googleError(403, 'quotaExceeded');
    const h = await adapter.probe('public');
    expect(h.state).toBe('ok');
    expect(h.limited).toBe(true);
  });

  it('5xx і мережа — down', async () => {
    const { adapter, api } = yt();
    api.fail = { status: 503, body: { error: { code: 503 } } };
    expect((await adapter.probe('public')).state).toBe('down');
  });

  it('без ключа — skip: коментарі — adapter_expired з причиною, транскрипт працює, проба зелена', async () => {
    const { adapter } = yt({ key: null });
    const h = await adapter.probe('public');
    expect(h.state).toBe('skip');
    expect(failsReady(h.state)).toBe(false);
    const { service, rows } = serviceOver(adapter);
    await expect(service.getMessages(ctx, { conversation: `youtube:public:${VID}` })).rejects.toMatchObject({
      code: 'adapter_expired',
      message: expect.stringMatching(/YOUTUBE_API_KEY/),
    });
    const tr = await service.getTranscript(ctx, { conversation: `youtube:public:${VID}` });
    expect(tr.count).toBeGreaterThan(0);
    await settle();
    expect(rows.map((r) => r.outcome)).toEqual(['expired', 'ok']);
    expect(rows[1]!.detail).toBe('ytdlp=1');
  });
});

// ── транскрипт ──────────────────────────────────────────────────────────────

describe('транскрипт', () => {
  it('година мовлення: ≤ 32 КБ, truncated + next; усі сторінки — без повторів до кінця, yt-dlp один раз', async () => {
    const { adapter, ytdlpPath } = yt();
    const { service, rows } = serviceOver(adapter);
    const conversation = `youtube:public:${VID}`;
    const first = await service.getTranscript(ctx, { conversation });
    expect(byteLength(first)).toBeLessThanOrEqual(32 << 10);
    expect(first).toMatchObject({ title: 'Година', duration: 3600, language: 'uk', source: 'auto', truncated: true });
    expect(first.next).toBeDefined();
    expect(first.segments[0]).toMatchObject({ start: 0 });
    expect(first.segments[1]!.start - first.segments[0]!.start).toBeCloseTo(30, 0);

    const starts: number[] = first.segments.map((s) => s.start);
    let cursor = first.next;
    while (cursor) {
      const page = await service.getTranscript(ctx, { conversation, cursor });
      starts.push(...page.segments.map((s) => s.start));
      cursor = page.next;
    }
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts).toHaveLength(120); // 3600 с / 30 с
    await settle();
    // yt-dlp запускався один раз: решта сторінок — із кешу.
    expect(rows.filter((r) => r.detail === 'ytdlp=1')).toHaveLength(1);

    // Процес не бачить секретів шлюзу.
    const seen = JSON.parse((await import('node:fs')).readFileSync(`${ytdlpPath}.env`, 'utf8')) as { env: Record<string, string>; argv: string[] };
    expect(Object.keys(seen.env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
    // Без JS-рушія: челендж плеєра потрібен потокам, а не субтитрам, і коштує ~190 МіБ на запуск.
    expect(seen.argv).toContain('--no-js-runtimes');
    expect(seen.argv.at(-1)).toBe(`https://www.youtube.com/watch?v=${VID}`);
  });

  it('бот-перевірка — platform_blocked 502, облік `blocked`; здоров\'ю не вирок, лише limited', async () => {
    const { adapter } = yt({ ytdlp: 'bot' });
    await adapter.probe('public');
    const { service, rows } = serviceOver(adapter);
    await expect(service.getTranscript(ctx, { conversation: `youtube:public:${VID}` })).rejects.toMatchObject({
      code: 'platform_blocked',
      status: 502,
    });
    const h = adapter.health('public');
    expect(h.state).toBe('ok');
    expect(h.limited).toBe(true);
    expect(h.reason).toMatch(/бот-перевірка/);
    await settle();
    expect(rows[0]).toMatchObject({ outcome: 'blocked', detail: expect.stringMatching(/\[ytdlp=1\]$/) });
    // Посилання на FAQ yt-dlp і поради про cookies до викликача не доходять.
    expect(rows[0]!.detail).not.toMatch(/cookies|https?:/);
  });

  it('субтитрів немає зовсім — порожній транскрипт, а не помилка; немає названої мови — список наявних', async () => {
    const none = yt({ ytdlp: 'none' });
    const t = await none.adapter.getTranscript!('public', VID, { language: null, cursor: null });
    expect(t).toMatchObject({ source: 'none', language: null, segments: [] });

    const { adapter } = yt();
    await expect(adapter.getTranscript!('public', VID, { language: 'de', cursor: null })).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringMatching(/uk/),
    });
  });

  it('yt-dlp завис — процес убито за таймаутом, down', async () => {
    const run = spawnYtDlp({ path: fakeYtDlp('slow'), timeoutMs: 300, concurrency: 1 });
    const r = await run([]);
    expect(r.timedOut).toBe(true);
    expect(classifyRun(r, 300).kind).toBe('down');
  });

  it('семафор: не більше concurrency процесів одночасно', async () => {
    const path = join(dir, 'yt-dlp-count');
    writeFileSync(
      path,
      `#!/usr/bin/env node\nconst fs=require('fs');const f=${JSON.stringify(join(dir, 'count'))};const n=(fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0)+1;fs.writeFileSync(f,String(n));fs.appendFileSync(f+'.max',n+'\\n');setTimeout(()=>{fs.writeFileSync(f,String(+fs.readFileSync(f,'utf8')-1))},150);\n`,
    );
    chmodSync(path, 0o755);
    const run = spawnYtDlp({ path, timeoutMs: 3_000, concurrency: 2 });
    await Promise.all(Array.from({ length: 5 }, () => run([])));
    const peaks = (await import('node:fs')).readFileSync(join(dir, 'count.max'), 'utf8').trim().split('\n').map(Number);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  });

  it('вибір доріжки: ручні мовою відео → розпізнані мовою відео; автопереклад сам не обирається', () => {
    const t = (url: string) => [{ ext: 'json3', url }];
    const info: VideoInfo = {
      id: VID,
      title: null,
      language: 'uk',
      duration: null,
      subtitles: { en: t('m-en') },
      automatic_captions: { 'uk-orig': t('a-uk-orig'), uk: t('a-uk'), en: t('a-en') },
    };
    expect(pickTrack(info, null)).toEqual({ language: 'uk', source: 'auto', url: 'a-uk-orig' });
    expect(pickTrack({ ...info, subtitles: { uk: t('m-uk') } }, null)).toEqual({ language: 'uk', source: 'manual', url: 'm-uk' });
    expect(pickTrack(info, 'en')).toEqual({ language: 'en', source: 'manual', url: 'm-en' });
    expect(pickTrack({ ...info, language: null, automatic_captions: { en: t('a-en') } }, null)).toEqual({ language: 'en', source: 'manual', url: 'm-en' });
    expect(pickTrack({ ...info, language: null, subtitles: {}, automatic_captions: { de: t('a-de') } }, null)).toBeNull();
  });

  it('json3 → сегменти до 30 с, порожні рядки й переноси — геть', () => {
    const segs = toSegments({
      events: [
        { tStartMs: 0, dDurationMs: 60000 },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'раз ' }, { utf8: 'два' }] },
        { tStartMs: 3000, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 29000, dDurationMs: 4000, segs: [{ utf8: 'три' }] },
        { tStartMs: 31000, dDurationMs: 1500, segs: [{ utf8: 'чотири' }] },
      ],
    });
    expect(segs).toEqual([
      { start: 1, end: 33, text: 'раз два три' },
      { start: 31, end: 32.5, text: 'чотири' },
    ]);
    expect(() => toSegments({ nope: 1 })).toThrow(AdapterError);
  });
});

describe('конфіг', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@db:5432/x', PRODUCT_KEYS: 'claude:s' };
  it('ні ключа, ні yt-dlp — адаптера немає; лише yt-dlp — адаптер без ключа', () => {
    expect(readEnv(base).youtube).toBeNull();
    expect(readEnv({ ...base, YTDLP_PATH: '/opt/y' }).youtube).toMatchObject({ apiKey: null, ytdlpPath: '/opt/y' });
  });
  it('ключ без відео для проби — помилка старту, а не «проба вимкнена»', () => {
    expect(() => readEnv({ ...base, YOUTUBE_API_KEY: 'k' })).toThrow(/YOUTUBE_PROBE_VIDEO/);
    expect(readEnv({ ...base, YOUTUBE_API_KEY: 'k', YOUTUBE_PROBE_VIDEO: VID }).youtube).toMatchObject({ apiKey: 'k', probeVideo: VID });
  });
});
