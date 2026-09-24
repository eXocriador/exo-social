/**
 * MCP — через `@modelcontextprotocol/sdk` (Streamable HTTP), протокол руками
 * не пишеться. Сервер будується НА ЗАПИТ і на продукт: stateless-режим,
 * жодної сесії в пам'яті, а область бере продукт із ключа цього ж запиту.
 *
 * Інструменти — ті самі функції сервісного шару, що й REST-двійники: область,
 * стеля, бюджет і облік не знають, яким входом прийшов виклик.
 *
 * Запису немає: `send_message`/`reply` з'являться з першим рядком області
 * `write` і першим адаптером, що вміє відправляти (connectors.md §3, §7 крок 3).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CallContext, Service } from './service.js';
import { ServiceError } from './service.js';

const REF = 'Conversation ref from list_chats (the "ref" field, adapter:account:id).';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function fail(err: unknown) {
  const e = err instanceof ServiceError ? err : new ServiceError('adapter_down', (err as Error)?.message ?? 'error');
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, detail: e.message }) }] };
}

async function call<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export function buildMcpServer(service: Service, ctx: CallContext, version: string): McpServer {
  const server = new McpServer({ name: 'relic', version });

  server.registerTool(
    'list_chats',
    {
      description:
        'List the conversations this key may read (Telegram and other platforms behind the gateway): ref, name, type, platform, last message date. Use this first; pass a ref as `conversation` to the other tools. An empty list means nothing has been opened to this key yet.',
      inputSchema: {
        limit: z.number().int().positive().optional().describe('Most conversations to return (the server caps it, 100 by default).'),
        offset: z.number().int().nonnegative().optional().describe('Skip this many (for paging).'),
      },
      annotations: readOnly,
    },
    (args) => call(() => service.listChats(ctx, { limit: args.limit, offset: args.offset })),
  );

  server.registerTool(
    'get_messages',
    {
      description:
        'Messages of one conversation, newest first, in a compact form (id, date in UTC, from, text, reply_to, media). One answer is capped by the server (count and bytes); when truncated is true, pass `next` back as `cursor` for older ones. Read only as far back as the question needs — prefer search_messages or get_messages_by_date on big conversations.',
      inputSchema: {
        conversation: z.string().min(3).describe(REF),
        limit: z.number().int().positive().optional().describe('Most messages to return (default 30; the server caps it, 100 by default).'),
        cursor: z.string().optional().describe('`next` from the previous answer: continues with older messages.'),
      },
      annotations: readOnly,
    },
    (args) => call(() => service.getMessages(ctx, { conversation: args.conversation, limit: args.limit, cursor: args.cursor })),
  );

  server.registerTool(
    'search_messages',
    {
      description: 'Search one conversation by keyword. Returns compact messages, newest first; the answer is capped by the server.',
      inputSchema: {
        conversation: z.string().min(3).describe(REF),
        query: z.string().min(1).describe('Words to search for.'),
        limit: z.number().int().positive().optional().describe('Most results (default 20; the server caps it).'),
      },
      annotations: readOnly,
    },
    (args) =>
      call(() => service.searchMessages(ctx, { conversation: args.conversation, query: args.query, limit: args.limit })),
  );

  server.registerTool(
    'get_messages_by_date',
    {
      description:
        'Every message of one conversation sent on one calendar day, oldest first. The day is taken in the given timezone (default UTC). When the day holds more than fits, the newest are dropped and truncated is true.',
      inputSchema: {
        conversation: z.string().min(3).describe(REF),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Day in YYYY-MM-DD.'),
        timezone: z.string().optional().describe('IANA timezone the date is in, e.g. Europe/Kyiv. Default UTC.'),
        limit: z.number().int().positive().optional().describe('Most messages (default and maximum: the server cap).'),
      },
      annotations: readOnly,
    },
    (args) =>
      call(() =>
        service.getMessagesByDate(ctx, {
          conversation: args.conversation,
          date: args.date,
          timezone: args.timezone,
          limit: args.limit,
        }),
      ),
  );

  return server;
}
