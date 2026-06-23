/**
 * @nexotv/core — ponto de entrada.
 * Ver NEXOTV_APP_ROADMAP.md (Fase 1) para o plano de migração da lógica.
 */
export * from './http/HttpClient';
export { FetchHttpClient } from './http/FetchHttpClient';

// Texto (puro)
export * from './text/normalize';

// Cache (puro)
export { default as LRUCache } from './utils/lruCache';

// Parsers
export { parseM3U } from './parsers/m3uParser';
