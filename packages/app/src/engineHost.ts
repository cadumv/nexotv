/**
 * Ponte entre o app (UI) e o `@nexotv/core`. Escolhe o cliente HTTP certo:
 * - **nativo (Capacitor)** → HTTP nativo (sem CORS, IP residencial do aparelho)
 * - **web (dev/preview)** → fetch (IPTV vai bloquear por CORS, mas serve pra UI)
 */
import { NexoEngine, FetchHttpClient, createCapacitorHttpClient, type AddonConfig, type EngineOptions, type HttpClient } from '@nexotv/core';
import logoBank from './data/logos.br.json';

async function makeHttp(): Promise<HttpClient> {
    try {
        const cap: any = await import('@capacitor/core');
        if (cap?.Capacitor?.isNativePlatform?.()) {
            return createCapacitorHttpClient(cap.CapacitorHttp);
        }
    } catch { /* sem capacitor (web) */ }
    return new FetchHttpClient();
}

// Chave TMDB padrão (de .env.local / build-time, fora do GitHub) — pra posters/
// hero funcionarem sem o usuário digitar.
const DEFAULT_TMDB = (import.meta as any).env?.VITE_TMDB_KEY || null;
// Proxy de logos (Worker /img): build-time, ou derivado do Worker da agenda (mesmo
// Worker hospeda /agenda e /img). Quando presente, logos ficam CORS-limpos e a
// detecção de fundo (cover vs contain) liga sozinha.
const DEFAULT_LOGO_PROXY = (import.meta as any).env?.VITE_LOGO_PROXY || null;
function deriveLogoProxy(o: EngineOptions): string | null {
    if (o.logoProxyBase) return o.logoProxyBase;
    if (DEFAULT_LOGO_PROXY) return DEFAULT_LOGO_PROXY;
    const a = o.sofascoreAgendaUrl;
    if (a) { try { return new URL(a).origin; } catch { /* url inválida */ } }
    return null;
}

/** Backdrop cinematográfico (landscape, alta qualidade) do TMDB por busca — usado
 *  na arte dos cards da tela inicial. TMDB tem CORS liberado. */
export async function tmdbBackdrop(query: string): Promise<string | null> {
    if (!DEFAULT_TMDB) return null;
    try {
        const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${DEFAULT_TMDB}&language=pt-BR&include_adult=false&query=${encodeURIComponent(query)}`);
        if (!r.ok) return null;
        const j = await r.json();
        const hit = (j.results || []).find((x: any) => x.backdrop_path);
        return hit ? `https://image.tmdb.org/t/p/w780${hit.backdrop_path}` : null;
    } catch { return null; }
}

// URL do Worker /agenda (RapidAPI Sofascore) — build-time (.env.local, fora do
// GitHub), pra os Jogos preencherem sem o usuário digitar.
const DEFAULT_AGENDA = (import.meta as any).env?.VITE_AGENDA_URL || null;
// No dev (vite serve) usamos caminho RELATIVO pra cair no proxy do vite (sem CORS).
// No APK/preview usamos a URL completa (nativo não tem CORS).
function resolveAgenda(full: string | null | undefined): string | null {
    if (!full) return null;
    if ((import.meta as any).env?.DEV) { try { const u = new URL(full); return u.pathname + u.search; } catch { return full; } }
    return full;
}

/** Pôster cinematográfico (RETRATO 2:3) do TMDB por busca — pra cards de pôster. */
export async function tmdbPoster(query: string): Promise<string | null> {
    if (!DEFAULT_TMDB) return null;
    try {
        const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${DEFAULT_TMDB}&language=pt-BR&include_adult=false&query=${encodeURIComponent(query)}`);
        if (!r.ok) return null;
        const j = await r.json();
        const hit = (j.results || []).find((x: any) => x.poster_path);
        return hit ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
    } catch { return null; }
}

// Liga o EPG e, no dev (navegador), roteia o xmltv pelo proxy do Vite (/__epg)
// pra furar o CORS. No nativo/APK não há CORS → busca direto.
function withEpg(config: AddonConfig): AddonConfig {
    const c: any = { ...config, enableEpg: true };
    const isDev = (import.meta as any).env?.DEV;
    if (isDev && c.provider === 'xtream' && c.xtreamUrl && c.xtreamUsername && c.xtreamPassword && !c.epgUrl) {
        const xmltv = `${c.xtreamUrl}/xmltv.php?username=${encodeURIComponent(c.xtreamUsername)}&password=${encodeURIComponent(c.xtreamPassword)}`;
        // URL absoluta (origem do dev) — relativa vira "http:///__epg" na normalização do core.
        const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
        c.epgUrl = `${origin}/__epg?u=${encodeURIComponent(xmltv)}`;
    }
    return c;
}

export async function createEngine(config: AddonConfig, options: EngineOptions): Promise<NexoEngine> {
    config = withEpg(config);
    const http = await makeHttp();
    // Banco de logos (iptv-org BR, bundlado) como fallback automático + TMDB padrão.
    const opts: EngineOptions = {
        ...options,
        tmdbApiKey: options.tmdbApiKey || DEFAULT_TMDB,
        sofascoreAgendaUrl: resolveAgenda(options.sofascoreAgendaUrl || DEFAULT_AGENDA),
        logoBank: options.logoBank || (logoBank as Record<string, string>),
        logoProxyBase: deriveLogoProxy(options),
    };
    const engine = new NexoEngine(config, { http, options: opts });
    await engine.load();
    return engine;
}
