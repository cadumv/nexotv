import { HttpClient, HttpRequestOptions, HttpResponse } from './HttpClient';

/**
 * Adaptador padrão usando o `fetch` global (Node 18+ / navegador).
 * Usado pelo server e por ambientes web. No app nativo, troca-se por um
 * adaptador de HTTP nativo (Capacitor) — mesma interface.
 */
export class FetchHttpClient implements HttpClient {
    async get(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
        const controller = new AbortController();
        const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
        try {
            const resp = await fetch(url, { headers: opts.headers, signal: controller.signal });
            return {
                status: resp.status,
                ok: resp.ok,
                text: () => resp.text(),
                json: () => resp.json(),
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
