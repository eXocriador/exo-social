/**
 * stdio-вхід MCP — для Claude Code на хості VPS, у якого немає ні домену, ні
 * host-порту шлюзу:
 *
 *   claude mcp add exo-social -s user -- docker exec -i exo-social-web node dist/mcp-stdio.js
 *
 * Це МІСТ, а не другий сервер: кожне повідомлення JSON-RPC зі stdin іде в
 * `http://127.0.0.1:<PORT>/mcp` того самого контейнера з ключем продукту
 * `STDIO_PRODUCT` (дефолт `claude`), узятим з оточення контейнера. Тож область,
 * стеля, бюджет і облік — рівно ті, що в HTTP-входу: політика лишається на
 * сервері, а stdio лише переносить байти. Вхід у переглядач і стан адаптера
 * теж один — у сервері, а не в кожній сесії Claude.
 *
 * stdout — це протокол: жодного логу туди, лише stderr.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { readEnv } from './env.js';
import { parseProductKeys } from './keys.js';

function die(message: string): never {
  process.stderr.write(`exo-social stdio: ${message}\n`);
  process.exit(2);
}

let env;
try {
  env = readEnv();
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
const secret = parseProductKeys(env.productKeys).secretOf(env.stdioProduct);
if (!secret) die(`продукт «${env.stdioProduct}» (STDIO_PRODUCT) не має ключа в PRODUCT_KEYS`);

const upstream = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${env.port}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${secret}` } },
});
const local = new StdioServerTransport();

local.onmessage = (message: JSONRPCMessage) => {
  upstream.send(message).catch((error: unknown) => {
    process.stderr.write(`exo-social stdio: ${(error as Error).message}\n`);
    // Запит без відповіді повісив би клієнта: відповісти помилкою від імені сервера.
    if ('id' in message && message.id !== undefined && 'method' in message) {
      void local.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `exo-social недосяжний зсередини контейнера: ${(error as Error).message}` },
      });
    }
  });
};
upstream.onmessage = (message) => void local.send(message);
upstream.onerror = (error) => process.stderr.write(`exo-social stdio: ${error.message}\n`);
local.onclose = () => void upstream.close().finally(() => process.exit(0));

await upstream.start();
await local.start();
