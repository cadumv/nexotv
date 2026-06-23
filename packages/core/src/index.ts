/**
 * @nexotv/core — ponto de entrada (lógica do app Rajada / backend NexoTV).
 * Ver NEXOTV_APP_ROADMAP.md (Fase 1) para o plano de migração.
 */

// Rede (trocável)
export * from './http/HttpClient';
export { FetchHttpClient } from './http/FetchHttpClient';
export { createCapacitorHttpClient } from './http/CapacitorHttpClient';

// Texto (puro)
export * from './text/normalize';

// Cache (puro)
export { default as LRUCache } from './utils/lruCache';

// Parsers
export { parseM3U } from './parsers/m3uParser';
export {
    parseEPG, parseEPGTime, getCurrentProgram, getUpcomingPrograms,
    type ParseEpgOptions,
} from './parsers/epgParser';

// Metadados (TMDB / Cinemeta)
export {
    resolveImdbTitle, resolveTmdbTitles, fetchTmdbMeta,
    type CineMeta, type TmdbTitles, type TmdbMeta,
} from './meta/titleMatch';

// Agenda de futebol (Sofascore: relay ou direto)
export {
    fetchSofascoreAgenda, BR_FOOTBALL_CHANNELS,
    type AgendaGame, type AgendaConfig,
} from './agenda/sofascoreAgenda';

// Config / ids
export { type AddonConfig } from './types';
export { createCacheKey, idPrefixFromCacheKey } from './config/cacheKey';
export { md5 } from './utils/md5';

// Provedores
export {
    fetchXtreamData, fetchVodInfo, fetchSeriesInfo,
    type XtreamOpts, type XtreamData,
} from './providers/xtreamProvider';

// Engine (orquestra catálogos/meta/stream)
export { NexoEngine, type EngineOptions, type EngineDeps } from './engine/NexoEngine';
