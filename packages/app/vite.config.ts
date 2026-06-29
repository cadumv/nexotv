import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Versão do app vinda do package.json — fonte única da verdade. É injetada como
// __APP_VERSION__ e o banner de atualização compara com a última release do GitHub.
const pkgVersion = (() => {
  try { return JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// Proxy de EPG no dev: o navegador bloqueia o xmltv.php do provedor por CORS.
// /__epg?u=<url> busca servidor→servidor e devolve o XML (sem CORS). Só no dev.
const epgProxy = {
  name: 'epg-proxy',
  configureServer(server: any) {
    server.middlewares.use('/__epg', async (req: any, res: any) => {
      try {
        const u = new URL(req.url, 'http://localhost').searchParams.get('u');
        if (!u) { res.statusCode = 400; res.end('missing u'); return; }
        const r = await fetch(u);
        res.setHeader('content-type', r.headers.get('content-type') || 'application/xml');
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.statusCode = 502; res.end('epg proxy error'); }
    });
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname), '');
  // Proxy de /agenda no dev: servidor→servidor (sem CORS no navegador). A origem
  // sai do .env.local (VITE_AGENDA_URL), nada sensível fica no código/repo.
  let agendaOrigin = '';
  try { if (env.VITE_AGENDA_URL) agendaOrigin = new URL(env.VITE_AGENDA_URL).origin; } catch { /* url inválida */ }
  return {
    define: {
      // Versão atual embutida no bundle (string literal). Usada pelo banner de update.
      __APP_VERSION__: JSON.stringify(pkgVersion),
      // Repo público de onde sai a última release (APK/EXE). Sem segredo nenhum.
      __UPDATE_REPO__: JSON.stringify('cadumv/nexotv'),
    },
    plugins: [react(), epgProxy],
    base: './', // Capacitor carrega de arquivos locais
    resolve: {
      alias: {
        // Vite compila o TS do core direto (ESM) — imports nomeados resolvem limpo.
        '@nexotv/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
    // host:true + allowedHosts:true permitem expor via túnel (cloudflared/etc.)
    // pra visualização remota; o proxy /agenda mantém os Jogos funcionando.
    server: {
      host: true,
      allowedHosts: true,
      ...(agendaOrigin ? { proxy: { '/agenda': { target: agendaOrigin, changeOrigin: true, secure: true } } } : {}),
    },
    build: { outDir: 'dist', target: 'es2020' },
  };
});
