// Sincroniza a versão do Android (build.gradle) com a fonte da verdade (package.json).
// versionName = a versão semver; versionCode = inteiro monotônico derivado dela
// (major*10000 + minor*100 + patch), pra o Android sempre ver o número subir.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8'));
const version = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!m) { console.error(`Versão inválida em package.json: ${version}`); process.exit(1); }
const [, MA, MI, PA] = m.map(Number);
const versionCode = MA * 10000 + MI * 100 + PA;

const gradlePath = resolve(APP, 'android/app/build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`);
writeFileSync(gradlePath, gradle);

console.log(`Android sincronizado: versionName="${version}", versionCode=${versionCode}`);
