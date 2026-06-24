# @nexotv/app — Rajada (UI + Capacitor)

App do **Rajada**: UI (React/Vite) consumindo o `@nexotv/core` (engine), empacotado
nativo via **Capacitor** (APK Android TV/Fire TV; depois Tizen/webOS).

## Estrutura
- `src/engineHost.ts` — cria o `NexoEngine` com o HTTP certo (Capacitor nativo no
  aparelho; fetch no web). É a ponte app ↔ core.
- `src/App.tsx` — home estilo Netflix (setup IPTV + fileiras de catálogo) — MVP.
- `capacitor.config.json` — `com.rajada.app`, `webDir: dist`.

## ⚠️ 2 follow-ups pro build web/APK (fase de UI)
O scaffold está pronto, mas pra o **bundle web/APK** compilar falta:

1. **Resolver o core no bundler.** O core é CJS; o jeito limpo é o Vite compilar o
   TS do core direto. Adicionar no `vite.config.ts`:
   ```ts
   resolve: { alias: { '@nexotv/core': path.resolve(__dirname, '../core/src/index.ts') } }
   ```
   (e paths no tsconfig). Assim os imports nomeados resolvem como ESM.

2. **EPG no browser.** O `core/parsers/epgParser` usa `xml2js` (puxa builtins do
   Node). No app, trocar por um parser browser-friendly (ex: `fast-xml-parser`)
   ou `DOMParser`. A lógica de `parseEPG` é simples de adaptar — manter a mesma
   saída (objeto indexado por canal). Validado no Node com xml2js; só falta a
   variante de browser.

## Build do APK (estado atual)
✅ `build:web` funciona (gera `dist/`).
✅ Projeto Android nativo já gerado (`npx cap add android` → pasta `android/`,
   gitignored por ser regenerável). `local.properties` aponta `sdk.dir` = asdk.

⚠️ **Falta JDK 17** pra rodar o Gradle (AGP 8 exige; a máquina só tem Java 8).
Passos pra gerar o APK (quando tiver JDK 17 / Android Studio):
```
# 1. instalar JDK 17 (Android Studio já vem com o JBR) e apontar:
export JAVA_HOME="<caminho do JDK 17>"
# 2. gerar/atualizar o projeto e o APK:
pnpm --filter @nexotv/app build:web
cd packages/app && npx cap sync android
cd android && ./gradlew assembleDebug      # -> app/build/outputs/apk/debug/app-debug.apk
# 3. instalar na TV:
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
## Player (cascata de fallbacks)
Atual (`App.tsx` → `Player`):
1. **hls.js** no `<video>` pra HLS (.m3u8/.ts/`/live/`) — funciona no navegador (notebook)
   e em WebView.
2. `<video>` nativo (mp4 / Safari-HLS).
3. Fallback "**Abrir externo**" se falhar.

**Pro APK (Android TV), o melhor é ExoPlayer nativo** (HLS/.ts/DASH + AC3/Dolby +
controle remoto). Plugins recomendados (pesquisa): `@capgo/capacitor-video-player`
(HLS/DASH) ou `wako-capacitor-video-player` (ExoPlayer/Media3 + DRM). Integrar como
camada 0 da cascata: tenta ExoPlayer nativo → cai pro hls.js → externo. Fica pra
quando montar o APK final (precisa device pra validar .ts/AC3 na TV).
Setup: a tela de login (App.tsx) já existe; o `sofascoreAgendaUrl` (Worker) entra ali.
