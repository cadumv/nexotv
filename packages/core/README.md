# @nexotv/core

Lógica do NexoTV **independente de servidor** — roda no backend Node E dentro do
app (Capacitor/WebView). É a base do "App NexoTV" (ver `NEXOTV_APP_ROADMAP.md`).

## Ideia central: HTTP trocável
Toda chamada de rede passa por um `HttpClient` (interface). Assim o MESMO código
roda em qualquer lugar, só trocando o adaptador:

- **Server (Node) / navegador** → `FetchHttpClient` (usa `fetch` global).
- **App nativo (Capacitor)** → `CapacitorHttpClient` (HTTP nativo, sem CORS, IP
  residencial do aparelho) — implementado na camada do app.

Isso resolve o bloqueio de CORS do IPTV no navegador: no app, o HTTP é nativo.

## O que migra pra cá (do `packages/backend/src`)
- `addon/M3UEPGAddon` (catálogos/meta/stream) — lógica pura
- `parsers/epgParser`, `parsers/m3uParser`
- `providers/xtreamProvider`, `iptvOrgProvider`, `m3uProvider` (usando `HttpClient`)
- `utils/titleMatch` (TMDB via `HttpClient`), `utils/sofascoreAgenda`
- `utils/lruCache`, `utils/cryptoConfig`

## O que NÃO vem (fica só no server)
- `routes/*`, `middleware/*`, `metrics`, `sqliteCache`, `outboundProxy`, Express.

## Status
Esqueleto inicial: interface `HttpClient` + `FetchHttpClient`. Migração dos
módulos é a Fase 1 (em andamento) — ver roadmap.
