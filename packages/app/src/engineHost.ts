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

export async function createEngine(config: AddonConfig, options: EngineOptions): Promise<NexoEngine> {
    const http = await makeHttp();
    // Banco de logos (iptv-org BR, bundlado) como fallback automático + TMDB padrão.
    const opts: EngineOptions = {
        ...options,
        tmdbApiKey: options.tmdbApiKey || DEFAULT_TMDB,
        logoBank: options.logoBank || (logoBank as Record<string, string>),
        logoProxyBase: deriveLogoProxy(options),
    };
    const engine = new NexoEngine(config, { http, options: opts });
    await engine.load();
    return engine;
}
