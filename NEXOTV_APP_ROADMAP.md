# RAJADA — Roadmap do App (continuidade entre chats)

> **Use este arquivo para retomar o projeto em qualquer chat.** Ele resume a
> visão, a arquitetura decidida, o que JÁ foi feito, o que está em ANDAMENTO e
> o que falta. Sem segredos aqui (este arquivo vai pro GitHub público).

> **Marca do app: RAJADA.** "NexoTV" segue só como nome interno do código/repo/
> servidor por enquanto (renomeio depois se quiser); a cara pro usuário é **RAJADA**.

---

## 🎯 Visão
Transformar o setup atual (IPTV + Stremio + servidor NexoTV) em **um app próprio
estilo Netflix chamado RAJADA**, instalável como **app nativo (APK e equivalentes)**
em **todas as TVs que permitem instalar**, além de celular e notebook. Base:
Stremio (open source) + nossa lógica (catálogos IPTV, Futebol/Sofascore,
enriquecimento TMDB).

## 🧭 Decisões de arquitetura (FECHADAS)
1. **Base de UI:** fork do **stremio-web** (React, open source) → redesenho Netflix.
2. **Lógica:** roda **dentro do app** (reaproveita ~75% do nosso server TS/JS).
   Cada aparelho fala **direto com o IPTV** (IP residencial do aparelho = sem 403).
   **Sem caixinha central, sem nuvem, sem proxy.** (É como os apps de IPTV fazem.)
3. **Empacotamento:** **Capacitor** → gera **APK nativo** (Android TV / Google TV /
   Fire TV) com **HTTP nativo** (resolve CORS) + **player nativo** (ExoPlayer).
   Depois: mesmo código → **Tizen (.wgt)** e **webOS (.ipk)**. Bônus: PWA/celular.
4. **Agenda de futebol:** continua no **Cloudflare Worker central** (já no ar) —
   1 busca/dia ao Sofascore (RapidAPI) servindo todos os aparelhos.
5. **Por que app nativo e não navegador:** o IPTV bloqueia CORS no navegador;
   só o HTTP nativo do app contorna. Por isso "baixar como app", não site.

## 🏗️ Arquitetura final (alvo)
```
   APP NexoTV (1 código web, Capacitor → nativo por plataforma)
   ├── UI: fork stremio-web redesenhado (Netflix)
   ├── Core: nossa lógica TS (catálogos, EPG, jogos, TMDB) rodando no app
   │     ↳ HTTP nativo → IPTV direto (IP residencial do aparelho)
   └── Player nativo (ExoPlayer) pros canais/VOD
   Agenda de futebol → Worker central (Sofascore via RapidAPI), grátis
```

---

## ✅ JÁ FEITO (funcionando hoje)

### Servidor NexoTV (backend TS) — `packages/backend`
- Addon Stremio multi-conta (rota `/:token/...`), Xtream + iptv-org + m3u.
- Catálogo **"Futebol Ao Vivo"**: monta jogos do EPG, jogos ao vivo primeiro,
  selo `[AO VIVO]`, tile com nome dos times (placehold.co), FHD/HD/SD por canal,
  agrupa emissoras, exclui reprises/falsos positivos.
- **Agenda Sofascore (RapidAPI)**: cobre Premiere/DAZN/Caze que o EPG não tem;
  traz a emissora BR exata. Une canais Sofascore + EPG por jogo.
- **Enriquecimento TMDB** (filmes/séries: descrição/elenco/nota/IMDb/poster pt-BR).
- **Correções nodejs-mobile**: `stripAccents` manual (sem ICU), remoção de emoji/
  multibyte (Stremio Android renderiza como "?"), `idPrefix` estável (itens
  salvos não quebram).
- Logos de canais normalizados (wsrv, quadrado) + programação agora/a seguir.

### Relay central de agenda — Cloudflare Worker
- Endpoint **`/agenda`** no Worker `nexotv-voice` (mesmo da skill Alexa).
- Busca ~16 canais BR no Sofascore (RapidAPI/Dojo), agrega, cacheia no KV.
- **Cap mensal 480** (plano grátis = 500 req/mês) + gate por horário.
- NexoTV consome via `SOFASCORE_AGENDA_URL` (sem chave no aparelho).
- Arquivo: `C:\Users\caduv\ftv\alexa-bridge\worker.js` (deploy via dashboard).

### Apps atuais (modelo antigo, 1 server por aparelho)
- APK `com.nexotv.server` (nodejs-mobile) embute o backend; roda na TCL e Fire TV.
- Stremio oficial como UI, apontando pro addon em `localhost:7000`.
- Auto-boot resolvido (TCL Safety Guard; Fire TV).

### Validado no notebook (modo relay)
- Server local em modo relay (`SOFASCORE_AGENDA_URL`) → 28 jogos, nomes pt-BR,
  Globo+SporTV+SBT+Caze por jogo, sem duplicados. ✅

---

## 🔄 EM ANDAMENTO — Fase 1 (core)
Extrair a lógica reaproveitável pro `packages/core` (independente de servidor),
com **HTTP trocável** (`HttpClient`: `fetch` no server / nativo no app).
Construído **em paralelo** ao backend (não quebra o que está rodando); convergir
o backend pra importar do core é cleanup posterior.

**Já migrado pro core (compila):**
- `http/HttpClient` + `FetchHttpClient` (camada de rede trocável)
- `utils/lruCache` (cache LRU, puro)
- `parsers/m3uParser` (puro) e `parsers/epgParser` (xml2js, desacoplado de env/logger)
- `text/normalize` (`stripAccents` manual, `normalizeTitle`, `cleanForSearch`, `compact`)
- `meta/titleMatch` (TMDB/Cinemeta via `HttpClient`, apiKey por parâmetro)
- `agenda/sofascoreAgenda` (relay + direto via `HttpClient`)
- `utils/md5` (md5 puro, **bate 100% com o crypto do Node** — verificado)
- `config/cacheKey` (`createCacheKey` portável → **idPrefix idêntico ao server**:
  conta atual = `b59c5679`, itens salvos continuam resolvendo) + `types` (AddonConfig)
- `providers/xtreamProvider` (canais/VOD/séries/EPG via `HttpClient`, retorna dados;
  + `fetchVodInfo`/`fetchSeriesInfo`)

**Próximo no core — o ENGINE (`addon/M3UEPGAddon` → `engine/NexoEngine`):**
A peça que orquestra tudo (catálogos/meta/stream, jogos, enriquecimento). Plano:
- Construtor recebe **deps injetadas**: `{ http, config, options, storage?, log? }`
  em vez de `env`/`fetch`/`sqlite` globais.
- Trocar `env.X` → `options` (timeouts, page size, TTLs, flags rate-limit n/a).
- Trocar `fetch`/providers → os do core (`fetchXtreamData`, `fetchVodInfo`…).
- Trocar `crypto`/`createCacheKey` → `config/cacheKey` do core (já pronto).
- `sqliteCache` → adapter `Storage` opcional (app usa memória/Storage do device).
- Timers (`setInterval`) → opcionais; no app o engine roda sob demanda.
- Reaproveita: parsers, titleMatch, sofascoreAgenda, text/normalize, lruCache.
- ⚠️ Melhor portar COM o provedor no ar (testar paridade catálogos/meta/stream).

## 📋 A FAZER (fases do app)
1. **Core** (em andamento): extrair `M3UEPGAddon`/parsers/`titleMatch`/
   `sofascoreAgenda` para `packages/core`; criar `HttpClient` (interface) e
   adaptadores (fetch / Capacitor HTTP). Trocar `fetch` direto pelos providers.
2. **UI**: fork do stremio-web; trocar a fonte de dados pelo `core`; redesenho
   Netflix (home, fileira Futebol, sem rótulos chatos, branding).
3. **Capacitor**: empacotar como APK; plugin HTTP nativo (CORS/IP); plugin de
   player nativo (ExoPlayer) pros streams IPTV/VOD.
4. **Setup no app**: tela de login IPTV (URL/usuário/senha → monta token);
   `SOFASCORE_AGENDA_URL` embutido; continue assistindo (conta Stremio ou perfis).
5. **Boot + resiliência** (auto-start, manter vivo).
6. **Empacotar Tizen/webOS** (Samsung/LG) a partir do mesmo código.
7. **Testar** em Fire TV + Google TV (+ Samsung/LG depois) e publicar/instalar.

## ⚠️ Riscos / pontos de atenção
- **Player na TV**: HTML5/WebView toca mal HLS/.ts/AC3 → usar **player nativo**.
- **CORS**: só resolve com HTTP nativo (Capacitor) — não dá no navegador puro.
- **Navegação por controle (D-pad)** no stremio-web precisa de ajuste pra TV.
- **Tamanho/ABI** dos pacotes; **GPL-3.0** do stremio-web/Lumera (ok p/ uso pessoal;
  se distribuir, manter aberto).
- **Quota RapidAPI**: 500/mês — gerida pelo Worker (cap 480 + cache adaptativo a fazer).

## 🔑 Segredos / configs (NÃO ficam aqui — guardar fora do repo)
- `SOFASCORE_RAPIDAPI_KEY` → só no Worker (Cloudflare → Settings → Secrets).
- `SHARED_SECRET` do Worker, token IPTV (Xtream), `CONFIG_SECRET`, authKeys
  Stremio → ficam em `main.js` do device / env, nunca no GitHub.
- Worker: `https://<seu-worker>.workers.dev/agenda?secret=<SHARED_SECRET>`.

## 📁 Locais importantes
- Backend (server/core): `packages/backend` (repo GitHub `cadumv/nexotv`).
- Worker: `C:\Users\caduv\ftv\alexa-bridge\worker.js`.
- APK atual (nodejs-mobile): `C:\Users\caduv\ftv` (projeto Android).
- Roadmap (este arquivo): `NEXOTV_APP_ROADMAP.md` na raiz do repo.

## 💡 Como retomar em outro chat
1. Leia este arquivo.
2. Estado do código está no GitHub `cadumv/nexotv` (branch `main`).
3. Próximo passo concreto: ver seção **EM ANDAMENTO** / **A FAZER #1 (Core)**.
