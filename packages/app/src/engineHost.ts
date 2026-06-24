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

export async function createEngine(config: AddonConfig, options: EngineOptions): Promise<NexoEngine> {
    const http = await makeHttp();
    // Banco de logos (iptv-org BR, bundlado) como fallback automático + TMDB padrão.
    const opts: EngineOptions = {
        ...options,
        tmdbApiKey: options.tmdbApiKey || DEFAULT_TMDB,
        logoBank: options.logoBank || (logoBank as Record<string, string>),
    };
    const engine = new NexoEngine(config, { http, options: opts });
    await engine.load();
    return engine;
}
