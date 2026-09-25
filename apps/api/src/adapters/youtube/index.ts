/**
 * Адаптер `youtube` — публічний YouTube без входу в акаунт (connectors.md §3, §5).
 *
 * Два інструменти під одним адаптером:
 *   • **Data API v3** (ключ API) — коментарі й метадані відео;
 *   • **yt-dlp** — транскрипт (субтитри автора або розпізнане мовлення).
 *
 * Форма §3:
 *   розмова      = відео: `youtube:public:<videoId>`, `type: video`, `name` — назва;
 *   повідомлення = коментар: верхній рівень і відповіді, що Data API віддає разом
 *                  із гілкою (`reply_to` — батьківський коментар), новіші гілки першими;
 *   транскрипт   = окремий інструмент `get_transcript` (сегменти з часом): у
 *                  мовленні немає ні автора, ні id, і в «повідомлення» воно не лізе.
 *
 * `list_chats` тут порожній: відео — не «список розмов» акаунта, їх мільярди.
 * Ref будує викликач — з id або з URL (`canonicalId`), окремого `resolve` немає.
 *
 * Акаунт один — `public`: входу немає, тож і розрізняти нічого. Стан «входу» —
 * це стан ключа Data API (ok / expired / down); без ключа — `skip`: коментарі
 * вимкнені, транскрипти працюють. Бот-перевірка yt-dlp і вичерпана квота —
 * `limited` з причиною, не вирок.
 */
import { formatRef, decodeCursor, encodeCursor, type Conversation, type Message, type Segment } from '../../shape.js';
import { assertTimeZone, dayBounds, TimeArgError } from '../../time.js';
import {
  AdapterError,
  type AccountHealth,
  type Adapter,
  type ChatList,
  type DayBatch,
  type MessageBatch,
  type TranscriptBatch,
} from '../types.js';
import { DataApi } from './data-api.js';
import { DEFAULT_GUARD, Guard, memoryKv } from './guard.js';
import { fetchInfo, languagesOf, pickTrack, spawnYtDlp, toSegments, type YtDlpRunner } from './ytdlp.js';

export const NAME = 'youtube';
export const ACCOUNT = 'public';

/** Сторінка commentThreads — ЗАВЖДИ 100: межі сторінок мусять бути ті самі між викликами курсора. */
const THREADS_PAGE = 100;
/** Скільки сторінок (= одиниць квоти) один get_messages може з'їсти. */
const MAX_PAGES = 5;
/** Скільки сторінок обходить get_messages_by_date, перш ніж визнати день надто далеким. */
const MAX_DAY_PAGES = 20;

export interface YoutubeOptions {
  /** Ключ Data API; null — коментарі й метадані вимкнені (`skip`). */
  apiKey: string | null;
  /** Відоме публічне відео для проби ключа (з `.env`, не з git). */
  probeVideo: string | null;
  probeIntervalMs: number;
  /** Шлях до yt-dlp; null — транскрипти вимкнені. */
  ytdlpPath: string | null;
  ytdlpTimeoutMs?: number | undefined;
  ytdlpConcurrency?: number | undefined;
  /** Підміни для тестів. */
  fetch?: typeof fetch | undefined;
  apiBase?: string | undefined;
  runYtDlp?: YtDlpRunner | undefined;
  /** Запобіжник (guard.ts); за замовчуванням — у пам'яті процесу з DEFAULT_GUARD. */
  guard?: Guard | undefined;
  now?: (() => number) | undefined;
}

/** Скільки тримати транскрипт у кеші: він не змінюється, а кожен промах — похід у YouTube. */
const TRANSCRIPT_TTL_SEC = 24 * 3600;

// ── id і URL ────────────────────────────────────────────────────────────────

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;

/** 11 символів id з id або з посилання YouTube; null — не впізнано. */
export function videoIdOf(raw: string): string | null {
  const s = raw.trim();
  if (VIDEO_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (HOSTS.test(host)) {
    id = url.searchParams.get('v');
    if (!id) {
      const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

// ── нормалізація у спільну форму ────────────────────────────────────────────

interface CommentSnippet {
  authorDisplayName?: unknown;
  textOriginal?: unknown;
  textDisplay?: unknown;
  publishedAt?: unknown;
  updatedAt?: unknown;
  parentId?: unknown;
}
interface CommentRes {
  id?: unknown;
  snippet?: CommentSnippet;
}
interface ThreadRes {
  id?: unknown;
  snippet?: { topLevelComment?: CommentRes; totalReplyCount?: unknown };
  replies?: { comments?: CommentRes[] };
}
interface ThreadsPage {
  nextPageToken?: unknown;
  items?: ThreadRes[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function toMessage(c: CommentRes | undefined, parent: string | null): Message | null {
  const id = str(c?.id);
  const s = c?.snippet;
  const date = str(s?.publishedAt);
  if (!id || !date) return null;
  const m: Message = { id, date: new Date(date).toISOString() };
  const from = str(s?.authorDisplayName);
  if (from) m.from = from;
  const text = str(s?.textOriginal) || str(s?.textDisplay);
  if (text) m.text = text;
  const reply = parent ?? (str(s?.parentId) || null);
  if (reply) m.reply_to = reply;
  if (str(s?.updatedAt) && str(s?.updatedAt) !== date) m.edited = true;
  return m;
}

/** Гілки сторінки → плоский список: коментар, за ним його відповіді (старіші першими). */
export function flatten(items: ThreadRes[] | undefined): Message[] {
  const out: Message[] = [];
  for (const t of items ?? []) {
    const top = toMessage(t.snippet?.topLevelComment, null);
    if (!top) continue;
    out.push(top);
    const replies = (t.replies?.comments ?? [])
      .map((c) => toMessage(c, String(top.id)))
      .filter((m): m is Message => m !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    out.push(...replies);
  }
  return out;
}

// ── курсори ─────────────────────────────────────────────────────────────────

/**
 * Курсор коментарів: сторінка Data API (`p`, її pageToken; null — перша) і
 * останній уже відданий коментар на ній (`a`, і його позиція `s` у плоскому
 * списку сторінки — запасом, якщо між викликами коментар зник).
 * Наступний виклик бере ту саму сторінку ще раз і продовжує ПІСЛЯ `a` — тож
 * бюджет, що обрізав сторінку посередині, не губить і не повторює рядків.
 */
interface CommentCursor {
  p: string | null;
  a: string;
  s: number;
}
const isCommentCursor = (v: unknown): v is CommentCursor =>
  typeof v === 'object' &&
  v !== null &&
  ((v as CommentCursor).p === null || typeof (v as CommentCursor).p === 'string') &&
  typeof (v as CommentCursor).a === 'string' &&
  Number.isInteger((v as CommentCursor).s);

/** Курсор транскрипту: мова доріжки і скільки сегментів уже віддано. */
interface TranscriptCursor {
  l: string | null;
  o: number;
}
const isTranscriptCursor = (v: unknown): v is TranscriptCursor =>
  typeof v === 'object' &&
  v !== null &&
  ((v as TranscriptCursor).l === null || typeof (v as TranscriptCursor).l === 'string') &&
  Number.isInteger((v as TranscriptCursor).o) &&
  (v as TranscriptCursor).o >= 0;

/** Маленький LRU з TTL: назви відео і позиції коментарів для курсора (транскрипти — у кеші запобіжника, guard.ts). */
class Lru<V> {
  private readonly map = new Map<string, { v: V; at: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

interface CachedTranscript {
  title: string | null;
  duration: number | null;
  language: string | null;
  source: 'manual' | 'auto' | 'none';
  segments: Segment[];
}

// ── адаптер ─────────────────────────────────────────────────────────────────

export function createYoutube(opts: YoutubeOptions): Adapter {
  const now = opts.now ?? Date.now;
  const guard = opts.guard ?? new Guard(memoryKv(now), DEFAULT_GUARD, now);
  const api = opts.apiKey
    ? new DataApi({ key: opts.apiKey, baseUrl: opts.apiBase, fetch: opts.fetch, takeUnit: () => guard.takeUnit() })
    : null;
  const ytdlpTimeoutMs = opts.ytdlpTimeoutMs ?? 60_000;
  // Один процес за раз: і пам'ять, і обережність — YouTube бачить не більше одного запиту плеєра.
  const run: YtDlpRunner | null =
    opts.runYtDlp ??
    (opts.ytdlpPath ? spawnYtDlp({ path: opts.ytdlpPath, timeoutMs: ytdlpTimeoutMs, concurrency: opts.ytdlpConcurrency ?? 1 }) : null);
  const fetchImpl = opts.fetch ?? fetch;

  const titles = new Lru<Conversation>(256, 60 * 60_000, now);
  /** Де лежить відданий коментар: сторінка й позиція — для cursorOf. */
  const positions = new Lru<{ p: string | null; s: number }>(5_000, 60 * 60_000, now);

  // Стан входу — лише від Data API; дві незалежні причини `limited`.
  let state: AccountHealth['state'] = api ? 'unknown' : 'skip';
  let stateReason: string | null = api
    ? 'ще жодної проби'
    : 'YOUTUBE_API_KEY не задано: коментарі й назви відео вимкнені, транскрипти — через yt-dlp';
  let quotaLimited: string | null = null;
  let ytdlpBlocked: string | null = run ? null : 'yt-dlp не налаштований (YTDLP_PATH): транскриптів немає';
  let checkedAt: string | null = null;
  let lastApiContact = 0;

  const health = (): AccountHealth => {
    const paused =
      guard.pausedUntil > now()
        ? `yt-dlp на паузі запобіжника до ${new Date(guard.pausedUntil).toISOString().slice(11, 16)}Z (${guard.pauseReason ?? 'YouTube відмовляв'})`
        : null;
    const reasons = [stateReason, quotaLimited, paused ?? ytdlpBlocked].filter((r): r is string => r !== null);
    return {
      adapter: NAME,
      account: ACCOUNT,
      state,
      reason: reasons.length ? reasons.join('; ') : null,
      limited: quotaLimited !== null || paused !== null || (ytdlpBlocked !== null && run !== null),
      checkedAt,
    };
  };

  function mark(next: AccountHealth['state'], reason: string | null): void {
    state = next;
    stateReason = reason;
    checkedAt = new Date(now()).toISOString();
  }

  /** Відповідь Data API — свідок стану ключа: відмова видна в /health/ready одразу. */
  async function viaApi<T>(fn: (api: DataApi) => Promise<T>): Promise<T> {
    if (!api) {
      throw new AdapterError('expired', 'YOUTUBE_API_KEY не задано — коментарі й метадані YouTube вимкнені; транскрипт — get_transcript');
    }
    try {
      const out = await fn(api);
      lastApiContact = now();
      if (state !== 'ok') mark('ok', null);
      quotaLimited = null;
      return out;
    } catch (err) {
      if (err instanceof AdapterError) {
        lastApiContact = now();
        if (err.kind === 'expired') mark('expired', err.message);
        else if (err.kind === 'down') mark('down', err.message);
        else {
          // Квота, «немає відео», «коментарі вимкнені» — Google спершу прийняв
          // ключ, тож він живий; квота лише додає `limited`.
          if (err.kind === 'rate_limited') quotaLimited = err.message;
          if (state !== 'ok') mark('ok', null);
        }
      }
      throw err;
    }
  }

  function own(account: string): void {
    if (account !== ACCOUNT) throw new AdapterError('not_found', 'розмови немає або вона поза областю');
  }

  function videoId(id: string): string {
    const v = videoIdOf(id);
    if (!v) throw new AdapterError('bad_request', 'не id відео YouTube і не посилання на відео');
    return v;
  }

  const threads = (vid: string, extra: Record<string, string | number | undefined>) =>
    viaApi((a) =>
      a.get<ThreadsPage>('commentThreads', {
        part: 'snippet,replies',
        videoId: vid,
        maxResults: THREADS_PAGE,
        textFormat: 'plainText',
        ...extra,
      }),
    );

  return {
    name: NAME,
    accounts: [ACCOUNT],

    health: () => health(),

    canonicalId: (id) => videoIdOf(id),

    /**
     * Проба ключа — `videos.list` на одне відоме відео, 1 одиниця квоти, не
     * частіше за `probeIntervalMs` (10 хв = 144 одиниці на добу з 10 000).
     * Загальний розклад проб шлюзу частіший (для переглядача Telegram), тож
     * тут — власний: між пробами віддається останній стан, а свіжий контакт
     * з API у виклику інструмента теж рахується пробою.
     */
    async probe() {
      if (!api) return health();
      if (state !== 'unknown' && now() - lastApiContact < opts.probeIntervalMs) return health();
      try {
        await viaApi((a) => a.get('videos', { part: 'id', id: opts.probeVideo ?? '' }));
      } catch {
        // стан уже записав viaApi; 429 квоти — лише `limited`
      }
      return health();
    },

    async listConversations(account): Promise<ChatList> {
      own(account);
      return { conversations: [], total: 0, hasMore: false };
    },

    async getConversation(account, id) {
      own(account);
      const vid = videoId(id);
      const cached = titles.get(vid);
      if (cached) return cached;
      const body = await viaApi((a) =>
        a.get<{ items?: { snippet?: { title?: unknown } }[] }>('videos', { part: 'snippet', id: vid }),
      );
      const item = body.items?.[0];
      if (!item) throw new AdapterError('not_found', 'відео немає');
      const c: Conversation = {
        ref: formatRef({ adapter: NAME, account: ACCOUNT, id: vid }),
        name: str(item.snippet?.title) || vid,
        type: 'video',
        platform: 'youtube',
      };
      titles.set(vid, c);
      return c;
    },

    async getMessages(account, id, page): Promise<MessageBatch> {
      own(account);
      const vid = videoId(id);
      let cur: CommentCursor | null = null;
      if (page.cursor) {
        cur = decodeCursor(page.cursor, isCommentCursor);
        if (!cur) throw new AdapterError('bad_request', 'cursor не з цього адаптера — беріть next з попередньої відповіді');
      }
      let token: string | null = cur?.p ?? null;
      const out: Message[] = [];
      let more = false;
      for (let pages = 0; pages < MAX_PAGES; pages++) {
        const body = await threads(vid, { order: 'time', pageToken: token ?? undefined });
        const flat = flatten(body.items);
        let from = 0;
        if (cur) {
          const at = flat.findIndex((m) => m.id === cur!.a);
          from = at >= 0 ? at + 1 : Math.min(cur.s, flat.length);
          cur = null;
        }
        const next = str(body.nextPageToken) || null;
        for (let i = from; i < flat.length && out.length < page.limit; i++) {
          positions.set(String(flat[i]!.id), { p: token, s: i + 1 });
          out.push(flat[i]!);
          if (out.length === page.limit) more = i < flat.length - 1 || next !== null;
        }
        if (out.length >= page.limit || !next) break;
        token = next;
        more = true;
      }
      return { messages: out, maybeMore: more };
    },

    async searchMessages(account, id, query, limit): Promise<MessageBatch> {
      own(account);
      const vid = videoId(id);
      const body = await threads(vid, { searchTerms: query, order: 'relevance' });
      const flat = flatten(body.items);
      return { messages: flat.slice(0, limit), maybeMore: flat.length > limit || Boolean(str(body.nextPageToken)) };
    },

    /**
     * Коментарі одного дня: обхід гілок від новіших (order=time — за часом
     * верхнього коментаря) до першої, старшої за початок дня. Відповіді — лише
     * ті, що Data API віддав разом із гілкою, і лише датовані цим днем.
     * Дня далі за MAX_DAY_PAGES сторінок не шукаємо: це вже не день, а архів.
     */
    async getMessagesByDate(account, id, day): Promise<DayBatch> {
      own(account);
      const vid = videoId(id);
      const tz = day.timezone || 'UTC';
      let bounds: { start: number; end: number };
      try {
        assertTimeZone(tz);
        bounds = dayBounds(day.date, tz);
      } catch (err) {
        if (err instanceof TimeArgError) throw new AdapterError('bad_request', err.message);
        throw err;
      }
      const inDay: Message[] = [];
      let token: string | null = null;
      let reached = false;
      for (let pages = 0; pages < MAX_DAY_PAGES; pages++) {
        const body: ThreadsPage = await threads(vid, { order: 'time', pageToken: token ?? undefined });
        for (const t of body.items ?? []) {
          const top = toMessage(t.snippet?.topLevelComment, null);
          if (!top) continue;
          const at = Date.parse(top.date);
          if (at < bounds.start) reached = true;
          for (const m of flatten([t])) {
            const mt = Date.parse(m.date);
            if (mt >= bounds.start && mt < bounds.end) inDay.push(m);
          }
        }
        token = str(body.nextPageToken) || null;
        if (reached || !token) {
          reached = true;
          break;
        }
      }
      if (!reached) {
        throw new AdapterError(
          'bad_request',
          `день надто далеко: ${MAX_DAY_PAGES} сторінок коментарів (${MAX_DAY_PAGES} одиниць квоти) до нього не дійшли — беріть get_messages з cursor`,
        );
      }
      inDay.sort((a, b) => a.date.localeCompare(b.date));
      return { messages: inDay.slice(0, day.limit), maybeMore: inDay.length > day.limit, timezone: tz };
    },

    cursorOf(m) {
      const pos = positions.get(String(m.id));
      return encodeCursor({ p: pos?.p ?? null, a: String(m.id), s: pos?.s ?? 0 } satisfies CommentCursor);
    },

    async getTranscript(account, id, o): Promise<TranscriptBatch> {
      own(account);
      const vid = videoId(id);
      let offset = 0;
      let want = o.language?.trim() || null;
      if (o.cursor) {
        const c = decodeCursor(o.cursor, isTranscriptCursor);
        if (!c) throw new AdapterError('bad_request', 'cursor не з get_transcript — беріть next з попередньої відповіді');
        offset = c.o;
        want = c.l;
      }
      if (want && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(want)) {
        throw new AdapterError('bad_request', 'language — код мови, як-от uk, en, pt-BR');
      }
      const key = `transcript:${vid}|${want ?? ''}`;
      // Порядок — від найдешевшого для YouTube: кеш → пам'ять відмов → стелі й
      // пауза запобіжника → і лише тоді запит.
      let t = await guard.cacheGet<CachedTranscript>(key);
      if (!t) {
        if (!run) throw new AdapterError('down', 'yt-dlp не налаштований (YTDLP_PATH) — транскриптів немає');
        if (await guard.isBlocked(vid)) {
          throw new AdapterError('blocked', 'YouTube відмовив серверу в цьому відео менш ніж добу тому — шлюз не питає вдруге; повтор не допоможе');
        }
        const admitted = await guard.admitYtDlp();
        if (!admitted.ok) throw new AdapterError('rate_limited', admitted.reason);
        let info;
        try {
          info = await fetchInfo(run, vid, ytdlpTimeoutMs);
          ytdlpBlocked = null;
          await guard.record('ok');
        } catch (err) {
          if (err instanceof AdapterError && err.kind === 'blocked') {
            await guard.markBlocked(vid);
            if (/бот-перевірка/.test(err.message)) {
              ytdlpBlocked = `yt-dlp: YouTube просить вхід (бот-перевірка) для IP сервера — транскрипти частини відео недоступні (останнє: ${new Date(now()).toISOString()})`;
              await guard.record('bot');
            }
          } else if (err instanceof AdapterError && err.kind === 'rate_limited') {
            await guard.record('429');
          }
          throw err;
        }
        const track = pickTrack(info, want);
        if (!track && want) {
          const have = languagesOf(info);
          throw new AdapterError('bad_request', `субтитрів мовою «${want}» немає; є: ${have.length ? have.join(', ') : 'жодних'}`);
        }
        let segments: Segment[] = [];
        if (track) {
          let res: Response;
          try {
            res = await fetchImpl(track.url, { signal: AbortSignal.timeout(20_000) });
          } catch {
            throw new AdapterError('down', 'доріжка субтитрів недосяжна');
          }
          if (res.status === 429) {
            await guard.record('429');
            throw new AdapterError('rate_limited', 'YouTube відповів 429 на доріжку субтитрів — запобіжник поставив yt-dlp на паузу');
          }
          if (!res.ok) throw new AdapterError('down', `доріжка субтитрів: ${res.status}`);
          segments = toSegments(await res.json().catch(() => null));
        }
        t = {
          title: info.title,
          duration: info.duration,
          language: track?.language ?? null,
          source: track?.source ?? 'none',
          segments,
        };
        await guard.cacheSet(key, t, TRANSCRIPT_TTL_SEC);
      }
      const lang = want;
      return {
        title: t.title,
        duration: t.duration,
        language: t.language,
        source: t.source,
        segments: t.segments.slice(offset),
        cursorAfter: (i) => encodeCursor({ l: lang, o: offset + i + 1 } satisfies TranscriptCursor),
      };
    },
  };
}
