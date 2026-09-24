import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// У проді SPA роздає той самий Fastify-процес із apps/web/dist (один процес,
// план §3.2). Проксі тут — лише для `pnpm dev:web` поруч із `dev:api`.
//
// Tailwind 4 — плагіном Vite, без postcss і tailwind.config. Тема — у
// @exo/kit-ui/tokens.css; його імпортує src/styles.css.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
