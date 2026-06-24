import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname), '');
  // Proxy de /agenda no dev: servidor→servidor (sem CORS no navegador). A origem
  // sai do .env.local (VITE_AGENDA_URL), nada sensível fica no código/repo.
  let agendaOrigin = '';
  try { if (env.VITE_AGENDA_URL) agendaOrigin = new URL(env.VITE_AGENDA_URL).origin; } catch { /* url inválida */ }
  return {
    plugins: [react()],
    base: './', // Capacitor carrega de arquivos locais
    resolve: {
      alias: {
        // Vite compila o TS do core direto (ESM) — imports nomeados resolvem limpo.
        '@nexotv/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
    server: agendaOrigin ? { proxy: { '/agenda': { target: agendaOrigin, changeOrigin: true, secure: true } } } : undefined,
    build: { outDir: 'dist', target: 'es2020' },
  };
});
