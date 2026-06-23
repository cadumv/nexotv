import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './', // Capacitor carrega de arquivos locais
  resolve: {
    alias: {
      // Vite compila o TS do core direto (ESM) — imports nomeados resolvem limpo.
      '@nexotv/core': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  build: { outDir: 'dist', target: 'es2020' },
});
