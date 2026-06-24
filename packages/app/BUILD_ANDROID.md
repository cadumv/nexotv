# Rajada — gerar o APK (Android / Android TV)

O app web roda dentro de um WebView nativo (Capacitor). Nativo = **sem CORS e sem
mixed content**, então os streams HTTP, os Jogos e o EPG funcionam direto (não
precisa do proxy de dev). Player = `<video>`/hls.js dentro do WebView (ExoPlayer
nativo fica pra uma fase 2).

## Pré-requisitos (na sua máquina)
- **Node 18+** e **pnpm**
- **JDK 17** (o Capacitor 6 não builda com Java 8). Confirme: `java -version` → 17.
- **Android Studio** + **Android SDK** (Platform 34 + build-tools). `ANDROID_HOME` apontando pro SDK.
- Pra instalar na TV: `adb` (vem no SDK platform-tools).

## Passos
```bash
# 1) instalar deps (na raiz do monorepo)
pnpm install

# 2) build do web (gera packages/app/dist)
pnpm --filter @nexotv/app build:web

# 3) entrar no app e sincronizar o projeto Android
cd packages/app

# Se a pasta android/ NÃO existir (ela é gitignored), crie-a uma vez:
#   npx cap add android
# (depois aplique o trecho de TV do AndroidManifest abaixo)

npx cap sync android      # copia o dist + aplica capacitor.config (cleartext HTTP)

# 4) gerar o APK de debug
cd android
./gradlew assembleDebug   # Windows: gradlew.bat assembleDebug
# APK em: android/app/build/outputs/apk/debug/app-debug.apk

# 5) instalar (celular ou Android TV via adb)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
No celular: copie o APK e instale (habilite "fontes desconhecidas"). Na TV:
`adb connect <ip-da-tv>:5555` e depois o `adb install`.

## Cleartext HTTP — já configurado
`capacitor.config.json` já tem `server.androidScheme: "http"` + `cleartext: true` +
`android.allowMixedContent: true`. O `cap sync` aplica isso. É o que permite tocar
os streams `http://` do provedor sem o navegador bloquear.

## Android TV (leanback) — aplicar no AndroidManifest
A pasta `android/` é regenerada (gitignored), então, **depois de `cap add android`**,
edite `android/app/src/main/AndroidManifest.xml`:

1. Antes de `<application>`, adicione (roda em TV sem exigir touch):
```xml
<uses-feature android:name="android.software.leanback" android:required="false" />
<uses-feature android:name="android.hardware.touchscreen" android:required="false" />
```
2. No `<application ...>`, adicione `android:banner="@mipmap/ic_launcher"` (e, se
   quiser garantir, `android:usesCleartextTraffic="true"`).
3. No `<intent-filter>` da MainActivity, adicione a categoria de launcher de TV:
```xml
<category android:name="android.intent.category.LEANBACK_LAUNCHER" />
```
Isso faz o Rajada aparecer na tela inicial da Android TV. Navegação por controle
(D-pad) já está implementada no app (setas movem o foco; OK/Enter seleciona).

## Ícone e splash (branding) — opcional
Coloque um `icon.png` (1024×1024) e um `splash.png` (2732×2732) numa pasta
`assets/` em `packages/app/` e rode:
```bash
npx @capacitor/assets generate --android
```
Isso gera os mipmaps/splash. Depois `npx cap sync android` e rebuild.

## Observações
- Em produção/nativo o EPG (xmltv) e os Jogos (/agenda) são buscados direto pelo
  cliente HTTP nativo (sem CORS) — o proxy `/__epg` do Vite é só pro dev no navegador.
- Para um APK de release assinado: `./gradlew assembleRelease` com um keystore
  configurado em `android/app/build.gradle` (passo separado, quando for publicar).
