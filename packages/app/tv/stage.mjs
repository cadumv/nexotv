// Monta a pasta empacotável de uma plataforma de TV a partir do dist/ já buildado.
// Uso: node tv/stage.mjs tizen   |   node tv/stage.mjs webos
// Saída: tv/build/<plataforma>/  (index.html + assets + manifesto + ícones)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const DIST = join(APP, 'dist');
const platform = process.argv[2];

if (!['tizen', 'webos'].includes(platform)) {
  console.error('Plataforma inválida. Use: node tv/stage.mjs tizen|webos');
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ não encontrado — rode `vite build` antes (os scripts pack:* já fazem isso).');
  process.exit(1);
}

const out = join(__dirname, 'build', platform);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) conteúdo web (dist é buildado com base:'./' → caminhos relativos, ok p/ TV).
cpSync(DIST, out, { recursive: true });

// 2) manifesto + ícones da plataforma.
const src = join(__dirname, platform);
if (platform === 'tizen') {
  cpSync(join(src, 'config.xml'), join(out, 'config.xml'));
  cpSync(join(src, 'icon.png'), join(out, 'icon.png'));
} else {
  cpSync(join(src, 'appinfo.json'), join(out, 'appinfo.json'));
  cpSync(join(src, 'icon.png'), join(out, 'icon.png'));
  cpSync(join(src, 'largeIcon.png'), join(out, 'largeIcon.png'));
}

console.log(`OK — pasta pronta: tv/build/${platform}`);
console.log(platform === 'tizen'
  ? 'Próximo: tizen build-web + tizen package -t wgt -s <perfil> (veja tv/BUILD_TV.md)'
  : 'Próximo: ares-package tv/build/webos (veja tv/BUILD_TV.md)');
