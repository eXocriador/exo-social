/**
 * Бюджет відповіді — ті самі межі, що в `internal/budget/budget_test.go` форку
 * telegram-archive-mcp: 8 КБ на 1000 повідомлень, 5 з 20, 2 КБ на одне
 * величезне, 1 КБ сирого тексту, 2 КБ на 200 чатів. Плюс те, чого Go-версія
 * не перевіряла: стеля не пробивається НІКОЛИ, на будь-яких розмірах.
 */
import { describe, expect, it } from 'vitest';
import { toConversation, toMessage, NAME } from './adapters/telegram-archive/index.js';
import { createTelegramArchive } from './adapters/telegram-archive/index.js';
import { byteLength, clampLimit, cutText, DEFAULT_LIMITS, fitChats, fitMessages, type Limits } from './budget.js';
import { readEnv } from './env.js';
import { decodeCursor, type Message } from './shape.js';

/** Повідомлення так, як його серіалізує переглядач — з raw_data. */
function archiveMsg(id: number, text: string): Record<string, unknown> {
  return {
    id,
    chat_id: -100123,
    date: `2026-09-01T10:${String(id % 60).padStart(2, '0')}:00`,
    text,
    sender_name: null,
    first_name: 'Olena',
    last_name: 'K',
    username: 'olena',
    reply_to_msg_id: null,
    is_outgoing: id % 2,
    is_deleted: 0,
    is_pinned: 0,
    edit_date: null,
    raw_data: { _: 'Message', entities: 'x'.repeat(1500) },
    media: { type: 'photo', file_name: null, file_path: '/data/x.jpg' },
  };
}

const msgs = (rows: Record<string, unknown>[]): Message[] => rows.map((r) => toMessage(r)!);
const adapter = createTelegramArchive({ baseUrl: 'http://viewer', user: 'u', pass: 'p', account: 'acc' });
const cursorOf = (m: Message) => adapter.cursorOf(m);
const bytes = (v: unknown) => byteLength(v);

describe('межі з оточення', () => {
  it('MAX_ITEMS і MAX_RESPONSE_BYTES читаються', () => {
    const env = readEnv({ DATABASE_URL: 'postgres://u:p@h/db', PRODUCT_KEYS: 'a:0123456789abcdef', MAX_ITEMS: '40', MAX_RESPONSE_BYTES: '20000' });
    expect(env.limits).toEqual({ maxItems: 40, maxBytes: 20000 });
  });

  it('дефолти — 100 і 32 КБ', () => {
    const env = readEnv({ DATABASE_URL: 'postgres://u:p@h/db', PRODUCT_KEYS: 'a:0123456789abcdef' });
    expect(env.limits).toEqual(DEFAULT_LIMITS);
  });

  // Відмінність від форку свідома: там сміття мовчки ставало дефолтом, тут —
  // відмова на старті (правило @exo/kit/env: помилка називає змінну).
  it('сміття і стеля нижче підлоги 1024 — відмова на старті, а не тихий дефолт', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/db', PRODUCT_KEYS: 'a:0123456789abcdef' };
    expect(() => readEnv({ ...base, MAX_ITEMS: 'junk' })).toThrow(/MAX_ITEMS/);
    expect(() => readEnv({ ...base, MAX_RESPONSE_BYTES: '10' })).toThrow(/MAX_RESPONSE_BYTES/);
  });
});

describe('clampLimit', () => {
  it.each([
    [0, 30, 30],
    [10, 30, 10],
    [5000, 30, 100],
  ])('clampLimit(%i, %i) = %i', (requested, def, want) => {
    expect(clampLimit({ maxItems: 100, maxBytes: 32 << 10 }, requested, def)).toBe(want);
  });
});

describe('fitMessages', () => {
  it('компактна форма без raw_data і з тим, що треба читачеві', () => {
    const page = fitMessages(DEFAULT_LIMITS, msgs([archiveMsg(7, 'привіт')]), { maybeMore: false, cursorOf });
    const s = JSON.stringify(page);
    for (const bad of ['raw_data', 'file_path', 'entities', 'chat_id']) expect(s).not.toContain(bad);
    expect(page.messages[0]).toMatchObject({ id: 7, text: 'привіт', from: 'Olena K', out: true, media: 'photo' });
    expect(page.messages[0]!.date).toBe('2026-09-01T10:07:00Z');
    expect(page.truncated).toBe(false);
    expect(page.next).toBeUndefined();
  });

  // Сценарій, заради якого бюджет існує: чат на десятки тисяч повідомлень.
  it('величезний чат не виходить за байтовий бюджет', () => {
    const limits: Limits = { maxItems: 1000, maxBytes: 8 << 10 };
    const rows: Record<string, unknown>[] = [];
    for (let i = 10000; i > 9000; i--) rows.push(archiveMsg(i, 'довге повідомлення '.repeat(10)));
    const page = fitMessages(limits, msgs(rows), { maybeMore: true, cursorOf, extra: { conversation: 'telegram-archive:acc:abc' } });
    expect(bytes(page)).toBeLessThanOrEqual(8 << 10);
    expect(page.truncated).toBe(true);
    expect(page.note).toBeTruthy();
    expect(page.next).toBeTruthy();
    const last = page.messages[page.messages.length - 1]!;
    const cur = decodeCursor(page.next!, (v): v is { d: string; i: number } => typeof v === 'object' && v !== null);
    expect(cur).toEqual({ d: last.date, i: last.id });
  });

  it('MAX_ITEMS обмежує кількість', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 20; i > 0; i--) rows.push(archiveMsg(i, 'hi'));
    const page = fitMessages({ maxItems: 5, maxBytes: 1 << 20 }, msgs(rows), { maybeMore: true, cursorOf });
    expect(page.count).toBe(5);
    expect(page.truncated).toBe(true);
    expect(page.next).toBeTruthy();
  });

  it('повна сторінка означає «можливо, є ще»; неповна — кінець', () => {
    const rows = msgs([archiveMsg(3, 'a'), archiveMsg(2, 'b')]);
    const full = fitMessages(DEFAULT_LIMITS, rows, { maybeMore: true, cursorOf });
    expect(full.truncated).toBe(true);
    expect(decodeCursor(full.next!, (v): v is { i: number } => true)).toMatchObject({ i: 2 });
    const short = fitMessages(DEFAULT_LIMITS, rows, { maybeMore: false, cursorOf });
    expect(short.truncated).toBe(false);
    expect(short.next).toBeUndefined();
  });

  it('одне завелике повідомлення вкорочується, а не випадає', () => {
    const page = fitMessages({ maxItems: 100, maxBytes: 2048 }, msgs([archiveMsg(1, 'я'.repeat(5000))]), {
      maybeMore: false,
      cursorOf,
    });
    expect(bytes(page)).toBeLessThanOrEqual(2048);
    // Валідний UTF-8 JSON — розрізаний символ дав би �.
    expect(JSON.stringify(page)).not.toContain('�');
    expect(page.count).toBe(1);
    expect(page.messages[0]!.cut).toBe(true);
    expect(page.messages[0]!.text!.endsWith('…')).toBe(true);
  });

  it('текст із лапками й керівними символами теж влазить (екранування JSON)', () => {
    const page = fitMessages({ maxItems: 100, maxBytes: 1500 }, msgs([archiveMsg(1, '"\n\t\u0001'.repeat(2000))]), {
      maybeMore: false,
    });
    expect(bytes(page)).toBeLessThanOrEqual(1500);
    expect(page.count).toBe(1);
  });

  it('стеля не пробивається ніколи — на будь-яких розмірах', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 200; run++) {
      const maxBytes = 1024 + Math.floor(rnd() * 40_000);
      const maxItems = 1 + Math.floor(rnd() * 150);
      const rows: Record<string, unknown>[] = [];
      const n = Math.floor(rnd() * 300);
      for (let i = n; i > 0; i--) rows.push(archiveMsg(i, 'ї"'.repeat(Math.floor(rnd() * 800))));
      const page = fitMessages({ maxItems, maxBytes }, msgs(rows), { maybeMore: rnd() > 0.5, cursorOf });
      expect(bytes(page)).toBeLessThanOrEqual(maxBytes);
      expect(page.count).toBeLessThanOrEqual(maxItems);
      if (n > 0) expect(page.count).toBeGreaterThan(0);
    }
  });
});

describe('cutText', () => {
  it('довільний текст ріжеться до стелі й каже, що обрізаний', () => {
    const out = cutText(`{"detail":"${'є'.repeat(3000)}"}`, 1024);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024);
    expect(out).toContain('truncated');
    expect(out).not.toContain('�');
  });
});

describe('fitChats', () => {
  it('розмови компактні й обмежені', () => {
    const chats = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      ref: `r${i}`,
      type: 'private',
      title: null,
      first_name: 'Ivan',
      last_name: String(i),
      description: 'd'.repeat(300),
      avatar_url: '/avatars/x.jpg',
      last_message_date: '2026-09-01T10:00:00',
    }));
    const page = fitChats(
      { maxItems: 100, maxBytes: 2048 },
      chats.map((c) => toConversation('acc', c)!),
      { total: 200, hasMore: false },
    );
    const s = JSON.stringify(page);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(2048);
    expect(s).not.toContain('description');
    expect(s).not.toContain('avatar');
    expect(page.conversations[0]).toMatchObject({ ref: `${NAME}:acc:r0`, name: 'Ivan 0', platform: 'telegram' });
    // Числовий id чату назовні не йде.
    expect(page.conversations[0]).not.toHaveProperty('id');
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(200);
  });
});
