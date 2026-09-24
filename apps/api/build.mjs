/**
 * АРХЕТИП F3 — збірка сервісу в один ESM-файл (@exo/kit, templates/docker/node-api).
 * Кладеться в apps/api/build.mjs; скрипт `build` сервісу = `node build.mjs`,
 * esbuild — у devDependencies сервісу. Плейсхолдерів тут немає.
 *
 * **Чому бандл, а не `tsx` у рантаймі** (рішення C2, exoanima 2026-09-14, той
 * самий навантажувальний замір 60 с × 16 для обох): пік cgroup 232 МіБ проти
 * 365, на 19 % більше запитів, один процес замість трьох (cli, loader,
 * `esbuild --service`), образ 869 МБ проти 1,45 ГБ. Єдиний аргумент за `tsx` —
 * «один спосіб читати файли» — знімається тим, що це той самий esbuild, лише
 * не в рантаймі.
 *
 * **Чому бандл, а не `tsc` у `dist`.** Пакети монорепо віддають сирий
 * TypeScript (`main: ./src/index.ts`) — так їх читають і Vite, і vitest. `tsc`
 * переписав би лише файли сервісу, а імпорт сусіднього пакета в рантаймі й
 * далі вів би в `.ts`, який Node не виконає. Тож код робочих областей
 * ВКЛЕЮЄТЬСЯ, а npm-залежності лишаються зовнішніми й ставляться в образ
 * `pnpm install --prod`.
 *
 * **Чому зовнішні — рівно прямі npm-залежності сервісу**, а не
 * `packages: 'external'`: те винесло б і робочі області разом з їхніми
 * пакетами, а ті в рантаймі не розв'язуються з `dist` сервісу — pnpm кладе їх
 * поруч із пакетом, не з сервісом (`yaml` у core exoanima). А спільний пакет
 * (`zod`) мусить бути зовнішнім для ВСІХ, хто його імпортує: інакше вклеїться
 * друга копія, і схеми з двох копій зустрінуться в одному `z.object`.
 * Робоча область впізнається протоколом `workspace:`, а не префіксом імені
 * (у exoanima — `@exoanima/`): префікс довелося б правити в кожному продукті.
 *
 * Типів esbuild не перевіряє — стирає. Тому `typecheck` у Dockerfile стоїть
 * окремими воротами.
 */
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const here = new URL('.', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', here), 'utf8'));

await build({
  // Два входи — сервер і stdio-міст MCP (mcp-stdio.ts): кожен окремим файлом у dist.
  entryPoints: [new URL('src/index.ts', here).pathname, new URL('src/mcp-stdio.ts', here).pathname],
  outdir: new URL('dist', here).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Ім'я пакета покриває і його підшляхи: `@exo/kit` виносить і `@exo/kit/auth`.
  external: Object.entries(pkg.dependencies ?? {})
    .filter(([, range]) => !String(range).startsWith('workspace:'))
    .map(([name]) => name),
  // Стек-трейси в лог і Sentry — на рядки `.ts` (`node --enable-source-maps` у CMD).
  sourcemap: true,
  // Вклеєний CommonJS, якщо такий трапиться серед робочих областей, кличе
  // `require` — в ESM його немає без цього рядка.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
