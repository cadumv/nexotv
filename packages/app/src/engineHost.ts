/**
 * Ponte entre o app (UI) e o `@nexotv/core`. Escolhe o cliente HTTP certo:
 * - **nativo (Capacitor)** → HTTP nativo (sem CORS, IP residencial do aparelho)
 * - **web (dev/preview)** → fetch (IPTV vai bloquear por CORS, mas serve pra UI)
 */
import { NexoEngine, FetchHttpClient, createCapacitorHttpClient, type AddonConfig, type EngineOptions, type HttpClient } from '@nexotv/core';

async function makeHttp(): Promise<HttpClient> {
    try {
        const cap: any = await import('@capacitor/core');
        if (cap?.Capacitor?.isNativePlatform?.()) {
            return createCapacitorHttpClient(cap.CapacitorHttp);
        }
    } catch { /* sem capacitor (web) */ }
    return new FetchHttpClient();
}

export async function createEngine(config: AddonConfig, options: EngineOptions): Promise<NexoEngine> {
    const http = await makeHttp();
    const engine = new NexoEngine(config, { http, options });
    await engine.load();
    return engine;
}
