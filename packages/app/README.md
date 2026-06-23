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

## Depois disso
```
pnpm --filter @nexotv/app build:web   # gera dist/
npx cap add android                    # 1x
pnpm --filter @nexotv/app cap:sync     # copia dist pro android
pnpm --filter @nexotv/app cap:android  # abre no Android Studio -> APK
```
Player: usar plugin de vídeo nativo (ExoPlayer) pros streams IPTV/VOD.
Setup: a tela de login já existe; o `sofascoreAgendaUrl` (Worker) entra ali.
