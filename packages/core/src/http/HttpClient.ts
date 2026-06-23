/**
 * Abstração de rede do @nexotv/core.
 *
 * Toda chamada HTTP da lógica (Xtream, TMDB, Sofascore, EPG/m3u) passa por aqui,
 * para o mesmo código rodar no server (fetch) e no app nativo (HTTP do Capacitor,
 * que contorna o CORS do IPTV e usa o IP residencial do aparelho).
 */

export interface HttpRequestOptions {
    headers?: Record<string, string>;
    /** Timeout em ms (o adaptador aborta a requisição ao estourar). */
    timeoutMs?: number;
}

export interface HttpResponse {
    status: number;
    ok: boolean;
    /** Corpo como texto cru. */
    text(): Promise<string>;
    /** Corpo já parseado como JSON (lança se não for JSON válido). */
    json(): Promise<any>;
}

export interface HttpClient {
    get(url: string, opts?: HttpRequestOptions): Promise<HttpResponse>;
}
