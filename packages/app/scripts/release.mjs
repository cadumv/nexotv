// Release de uma só vez: builda APK (TV/Android) + instalador EXE (PC/Electron) e
// publica tudo numa GitHub Release pública. O app instalado (PC e TV) detecta essa
// release e oferece a atualização.
//
// Uso (rodar de packages/app):
//   pnpm release            -> usa a versão atual do package.json
//   pnpm release patch      -> 1.0.0 -> 1.0.1
//   pnpm release minor      -> 1.0.0 -> 1.1.0
//   pnpm release major      -> 1.0.0 -> 2.0.0
//   pnpm release 1.4.2      -> versão explícita
//   pnpm release patch --notes "texto das novidades"
//
// Pré-requisitos: gh autenticado (gh auth status), JDK/Android SDK p/ o APK,
// e electron-builder (já é devDependency).
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// Quota um argumento p/ a shell (Windows precisa de shell p/ rodar .bat/.cmd como
// npx/gh/gradlew; sem isto, caminhos com espaço — "C:\Program Files", "Proza Setup
// 1.0.0.exe" — quebram). Monta a linha inteira e passa como string única.
function q(s) { return /[\s"&|<>^()]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s); }
function run(cmd, args, opts = {}) {
  const line = [cmd, ...args].map(q).join(' ');
  console.log(`\n$ ${line}`);
  const r = spawnSync(line, { stdio: 'inherit', cwd: APP, shell: true, ...opts });
  if (r.status !== 0) { console.error(`\nFalhou: ${cmd} (código ${r.status})`); process.exit(r.status || 1); }
}

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let bump = '';
let notes = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--notes') { notes = argv[++i] || ''; continue; }
  if (!bump) bump = argv[i];
}

// --- versão ------------------------------------------------------------------
const pkgPath = resolve(APP, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
let [MA, MI, PA] = (pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/) || [, 0, 0, 0]).slice(1).map(Number);

if (/^\d+\.\d+\.\d+$/.test(bump)) { [MA, MI, PA] = bump.split('.').map(Number); }
else if (bump === 'major') { MA++; MI = 0; PA = 0; }
else if (bump === 'minor') { MI++; PA = 0; }
else if (bump === 'patch') { PA++; }
else if (bump) { console.error(`Argumento inválido: ${bump} (use patch|minor|major|x.y.z)`); process.exit(1); }

const version = `${MA}.${MI}.${PA}`;
const tag = `v${version}`;
console.log(`\n=== Release Proza ${tag} ===`);

// Grava a versão no package.json (fonte da verdade) e sincroniza o Android.
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
run(process.execPath, [resolve(__dirname, 'version-sync.mjs')]);

// --- staging -----------------------------------------------------------------
const OUT = resolve(APP, 'release');
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- 1) APK (TV/Android) -----------------------------------------------------
console.log('\n--- Buildando web + APK ---');
run('npx', ['vite', 'build']);
run('npx', ['cap', 'sync', 'android']);
const androidDir = resolve(APP, 'android');
const gradlew = isWin ? resolve(androidDir, 'gradlew.bat') : './gradlew';
run(gradlew, ['assembleDebug'], { cwd: androidDir });
const apkSrc = resolve(APP, 'android/app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(apkSrc)) { console.error(`APK não encontrado em ${apkSrc}`); process.exit(1); }
const apkDst = join(OUT, `Proza-${version}.apk`);
copyFileSync(apkSrc, apkDst);
console.log(`APK -> ${apkDst}`);

// --- 2) Instalador EXE (PC/Electron) ----------------------------------------
console.log('\n--- Buildando instalador Windows (Electron) ---');
run('npx', ['electron-builder', '--win', '--x64', '-p', 'never']);
// Copia o .exe, o latest.yml (electron-updater) e o .blockmap (delta) pro staging.
const distEl = resolve(APP, 'dist-electron');
for (const f of readdirSync(distEl)) {
  // Só os artefatos DESTA versão (dist-electron pode ter .exe de versões antigas).
  const isThisVersion = f.includes(version) && /\.exe$|\.exe\.blockmap$/.test(f);
  if (isThisVersion || f === 'latest.yml') {
    copyFileSync(join(distEl, f), join(OUT, f));
    console.log(`PC -> ${f}`);
  }
}
if (!existsSync(join(OUT, 'latest.yml'))) {
  console.warn('\n[aviso] latest.yml não foi gerado — o auto-update do PC não vai funcionar sem ele.');
}

// --- 3) GitHub Release -------------------------------------------------------
console.log('\n--- Publicando no GitHub Releases ---');
const assets = readdirSync(OUT).map((f) => join(OUT, f));
// -R explicito: o repo pode ter um 'upstream' e o gh mira o upstream por padrao.
const ghArgs = ['release', 'create', tag, '-R', 'cadumv/nexotv', '--target', 'main', '--title', `Proza ${version}`, ...assets];
if (notes) ghArgs.push('--notes', notes);
else ghArgs.push('--generate-notes');
run('gh', ghArgs);

console.log(`\n✅ Release ${tag} publicada. Os apps instalados vão detectar e oferecer a atualização.`);
console.log('   Lembre de commitar o bump de versão (package.json + android/app/build.gradle).');
