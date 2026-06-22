# NexoTV — Fire TV APK (servidor embutido via nodejs-mobile)

Roda o servidor NexoTV **dentro da própria Fire TV** (Fire TV Stick 4K, 32-bit
armeabi-v7a, Fire OS 6 / API 25) — sem PC e sem nuvem. Resolve o bloqueio 403 de
provedores IPTV (a TV usa IP residencial) e dá interface "tipo Netflix" via Stremio.

## O que tem aqui
- App Android nativo que embute o servidor Node (nodejs-mobile) e o serve em `http://localhost:7000`.
- **Auto-start no boot** (cedo, via `CONNECTIVITY_CHANGE`, contornando o atraso do Fire OS).
- **Foreground service** + wake lock + START_STICKY + alarme keepalive → "nunca dorme" / auto-recupera.
- **Warm-up**: pré-carrega os catálogos no boot.
- **Ponte de voz** (porta 7001) + serviço opcional que abre buscas no Stremio.

## Pré-requisitos
- JDK 17, Android SDK (platform 34, build-tools 34, NDK r27, CMake 3.22.1), Gradle 8.9
- Node 18.x (para instalar as deps puras-JS do bundle)

## Montagem (passos)
1. **libnode**: baixe `nodejs-mobile-v18.20.4-android.zip` do release oficial
   (github.com/nodejs-mobile/nodejs-mobile) e coloque:
   - `app/libnode/bin/armeabi-v7a/libnode.so`
   - `app/libnode/include/node/*` (headers)
2. **Backend**: compile o backend NexoTV (`pnpm --filter @nexotv/backend build`) e
   copie o resultado para `app/src/main/assets/nodejs-project/packages/backend/dist/`
   (e o frontend para `.../packages/frontend/dist/`).
3. **Deps do bundle**: em `app/src/main/assets/nodejs-project/` rode
   `npm install --omit=dev` (somente pacotes puros-JS; NUNCA módulos nativos).
4. **Segredos**: edite `app/src/main/assets/nodejs-project/main.js` e preencha
   `CONFIG_SECRET`, `TMDB_API_KEY`, `WARM_TOKEN` (token base64url da SUA config Xtream),
   e opcionalmente `CLOUD_BRIDGE_URL`/`CLOUD_BRIDGE_SECRET` (ver `../alexa-bridge`).
5. **Build**: `gradle assembleDebug` → `app/build/outputs/apk/debug/app-debug.apk`

## Instalar na Fire TV
```
adb connect <IP-da-firetv>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.nexotv.server/.MainActivity   # abrir 1x (requisito p/ boot)
```
No Stremio, instale o addon apontando para `http://localhost:7000/<seu-token>/manifest.json`.

## Notas
- 32-bit only (`armeabi-v7a`); use `useLegacyPackaging true`.
- `SearchInterceptorService` (acessibilidade) é opcional e **bloqueado pela Fire OS**
  na Stick 4K (não ativável) — incluído como referência; não é necessário.
- Busca por voz funciona via skill Alexa (ver `../alexa-bridge`).
