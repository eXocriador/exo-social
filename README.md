# exo-social

Згенеровано `exo new exo-social --kind api` (план модульності §5 D2) —
канонічна родина (§3.2): Fastify + Vite/React SPA в pnpm-workspace, один
Node-процес, що роздає і API, і зібрану SPA.

| тека | що |
|---|---|
| `apps/api` | Fastify на `@exo/kit`: `env`, `health`, `infra`, `log`, `telemetry`; бандл esbuild (`build.mjs`) |
| `apps/web` | Vite + React 19 + Tailwind 4 на `@exo/kit-ui` |
| `packages` | пакети без знання про продукт (порожньо з народження) |

Деплой — `/srv/products/exo-social/deploy.sh` (exo-deploy): збірка з
`git archive HEAD`, тож некомічене в образ не їде. Dockerfile — архетип F3 kit
(`templates/docker/node-api`) з підставленими плейсхолдерами; ворота
(`typecheck`, `test`) — у стадіях образу, не на хості.

## Локально

```bash
pnpm install
pnpm dev:api   # :3000
pnpm dev:web   # Vite з проксі на :3000
pnpm test
```
