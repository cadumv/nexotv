import { HttpClient, HttpRequestOptions, HttpResponse } from './HttpClient';

/**
 * Adaptador de HTTP NATIVO para o app (Capacitor). Requisições nativas **não
 * sofrem CORS** e saem pelo IP residencial do aparelho — é o que permite falar
 * direto com o IPTV (sem 403, sem proxy).
 *
 * O core não depende do `@capacitor/core` (pra compilar em qualquer lugar): o
 * app injeta o objeto `CapacitorHttp` (de `@capacitor/core`) aqui.
 *
 *   import { CapacitorHttp } from '@capacitor/core';
 *   const http = createCapacitorHttpClient(CapacitorHttp);
 */
export function createCapacitorHttpClient(CapacitorHttp: any): HttpClient {
    return {
        async get(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
            const res = await CapacitorHttp.request({
                method: 'GET',
                url,
                headers: opts.headers || {},
                connectTimeout: opts.timeoutMs,
                readTimeout: opts.timeoutMs,
                // Mantém o corpo cru quando possível; fazemos o parse aqui.
                responseType: 'text',
            });
            const status: number = res?.status ?? 0;
            const raw = res?.data;
            return {
                status,
                ok: status >= 200 && status < 300,
                text: async () => (typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')),
                json: async () => (typeof raw === 'string' ? JSON.parse(raw) : raw),
            };
        },
    };
}
