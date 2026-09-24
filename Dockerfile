# syntax=docker/dockerfile:1
# Згенеровано `exo new exo-social --kind api` (з 2026-09-24 — relic) з архетипу F3 @exo/kit v0.11.0
# (templates/docker/node-api): плейсхолдери підставлені. Стадії SPA немає — шлюз
# без вебу; dbmate і міграції — в образі (MIGRATE=dbmate). Далі це файл
# продукту; `exo upgrade`
# показує, чим він розійшовся з архетипом нового тега.
#
# АРХЕТИП F3 — Node-сервіс з HTTP (Fastify/API), бандл esbuild, pnpm-монорепо
# (@exo/kit, templates/docker). Форми, плейсхолдери і як перевірено:
# templates/docker/README.md. Хто в портфелі на цій формі і чим відрізняється:
# /srv/docs/audits/2026-09-14-dockerfile-drift.md.
#
# Канонічна родина нових продуктів — Fastify + Vite SPA на pnpm (план
# модульності §3.2), тож pnpm — основний варіант. Канонічний член —
# exoanima/services/api (бандл, HEALTHCHECK, три ворота). npm-варіант —
# exo-ai/repo: `npm ci` у base, `npm ci --omit=dev` у prod-deps, решта та сама.
#
# Заповнити: apps/api (тека сервісу, напр. apps/api), @relic/api (його name у
# package.json), 3000. Поруч — build.mjs: кладеться в apps/api, скрипт
# `build` сервісу = `node build.mjs`, esbuild — у його devDependencies. У
# package.json сервісу — `"type": "module"` і скрипти `typecheck`, `test`.
#
# Контекст — корінь монорепо: сервіс імпортує сусідні пакети як сирий
# TypeScript і без них не збирається.

# ── стор pnpm за локом ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Версію pnpm corepack бере з `packageManager` кореневого package.json.
RUN corepack enable
WORKDIR /repo
# Лише лок: `pnpm fetch` кладе в стор усе записане в ньому, і шар переживає
# будь-яку правку коду. Не перелік `package.json` — `COPY` з маскою сплющує теки.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# ── збірка і ворота ─────────────────────────────────────────────────────────
FROM base AS build
# Кореневі конфіги, які розширює сервіс (tsconfig.base.json, vitest.config.ts):
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# Інших робочих областей немає: шлюз без SPA (apps/web знятий, README репо).
# Сервіс з його робочими областями плюс корінь. Сусідній застосунок (Vite, Next)
# сюди не ставиться: ні збірці, ні воротам він не потрібен.
RUN pnpm install --offline --frozen-lockfile --filter "@relic/api..." --filter "{.}"

# Ворота тут, а не на хості: `node_modules` хоста належать власнику, і бачать
# вони рівно дерево образу. `typecheck` окремо від збірки обов'язковий — esbuild
# типи просто стирає, і без цього рядка помилка типів доїхала б у прод.
# Продукт із вендореним SQL kit — ще й ворота проти двох правд про схему входу
# (README kit, «Migrations»):
# RUN pnpm --filter @relic/api run migrations:check
RUN pnpm --filter @relic/api run typecheck \
 && pnpm --filter @relic/api run test
RUN pnpm --filter @relic/api run build

# ── лише продові залежності сервісу ─────────────────────────────────────────
# Без `...`: код робочих областей уже вклеєний у бандл, їхні пакети рантайму не
# потрібні (посилання на теку пакета лишається, його ніхто не імпортує).
#
# `rm -rf node_modules` — не прибирання для краси. `pnpm fetch` у стадії base
# кладе ВЕСЬ лок не лише в стор, а й у віртуальний стор `node_modules/.pnpm`, і
# `install --prod` у стадії, успадкованій від base, зайвого звідти не видаляє:
# перша пробна збірка exoanima (C2) віднесла в рантайм 639 МБ і 258 пакетів
# (Next, typescript, vitest) замість продових. Стор лишається на місці — з нього
# і ставить `--offline`.
FROM base AS prod-deps
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter @relic/api

# ── рантайм ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/api
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/apps/api/node_modules ./node_modules
# `type: module` з маніфесту — інакше Node прочитав би бандл як CommonJS.
COPY apps/api/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
# MIGRATE=dbmate у deploy.conf запускає dbmate З ЦЬОГО ОБРАЗУ (робоча тека —
# ця), тож бінарник і міграції їдуть сюди, і схема з кодом — один коміт за
# побудовою (exo-ai, netwatch). БД немає — обидва рядки прибрати.
COPY --from=amacneil/dbmate:2.35.1 /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY apps/api/db/migrations ./db/migrations

# ARG в останній стадії: хеш міняється з кожним комітом і не має інвалідувати
# встановлення й ворота вище. Ціна — новий верхній шар на кожному коміті, тобто
# кожен деплой перестворює контейнер.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Файли лишаються root-овими й лише читаються. Процес мусить писати — теку
# створити тут, до USER, і віддати йому (`install -d -o node -g node <тека>`),
# а не chown-ити код.
USER node
EXPOSE 3000
# Ні wget, ні curl у slim-образі немає, node є. `--start-interval` потребує
# Docker ≥ 25 і працює лише разом зі `--start-period`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Бандл, а не `tsx`: див. build.mjs. Карти коду — щоб стек у лозі й Sentry
# вказував на рядки `.ts`.
CMD ["node", "--enable-source-maps", "dist/index.js"]
