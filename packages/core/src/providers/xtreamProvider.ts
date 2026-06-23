/**
 * Provedor Xtream Codes, independente de servidor. Rede via `HttpClient`.
 * Diferente do backend (que mutava a instância), aqui as funções RETORNAM os
 * dados — o engine decide o que fazer. SSRF/validação fica a cargo do chamador
 * (no app, a URL é do próprio usuário).
 */
import { HttpClient } from '../http/HttpClient';
import { AddonConfig } from '../types';
import { parseEPG } from '../parsers/epgParser';

export interface XtreamOpts {
    idPrefix: string;
    userAgent?: string;
    fetchTimeoutMs?: number;
    epgFetchTimeoutMs?: number;
    epgMaxBytes?: number;
    log?: (level: 'debug' | 'warn', msg: string, extra?: any) => void;
}

export interface XtreamData {
    channels: any[];
    movies: any[];
    series: any[];
    epgData: Record<string, any[]>;
}

const DEFAULT_FETCH_TIMEOUT = 30000;
const DEFAULT_EPG_TIMEOUT = 60000;

function buildBase(config: AddonConfig) {
    return `${config.xtreamUrl}/player_api.php?username=${encodeURIComponent(config.xtreamUsername || '')}&password=${encodeURIComponent(config.xtreamPassword || '')}`;
}

function ua(opts: XtreamOpts) {
    return { 'User-Agent': opts.userAgent || 'VLC/3.0.20 LibVLC/3.0.20' };
}

async function getJson(http: HttpClient, url: string, opts: XtreamOpts, timeout: number): Promise<any | null> {
    try {
        const r = await http.get(url, { headers: ua(opts), timeoutMs: timeout });
        if (!r || !r.ok) return null;
        return await r.json();
    } catch { return null; }
}

/** Busca canais (+ VOD/séries + EPG) do Xtream. Retorna os dados estruturados. */
export async function fetchXtreamData(http: HttpClient, config: AddonConfig, opts: XtreamOpts): Promise<XtreamData> {
    const { xtreamUrl, xtreamUsername, xtreamPassword } = config;
    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }
    const base = buildBase(config);
    const fetchTimeout = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT;
    const out: XtreamData = { channels: [], movies: [], series: [], epgData: {} };

    // ---- Canais ao vivo (obrigatório) ----
    const liveResp = await http.get(`${base}&action=get_live_streams`, { headers: ua(opts), timeoutMs: fetchTimeout });
    if (!liveResp || !liveResp.ok) throw new Error('Xtream live streams fetch failed');
    const live = await liveResp.json();

    const liveCats = await getJson(http, `${base}&action=get_live_categories`, opts, fetchTimeout);
    const liveCatMap: Record<string, string> = {};
    if (Array.isArray(liveCats)) {
        for (const c of liveCats) if (c?.category_id && c?.category_name) liveCatMap[c.category_id] = c.category_name;
    }

    out.channels = (Array.isArray(live) ? live : []).map((s: any) => {
        const cat = liveCatMap[s.category_id] || s.category_name || s.category_id || 'Live';
        return {
            id: `xc${opts.idPrefix}_${s.stream_id}`,
            name: s.name,
            type: 'tv',
            url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
            logo: s.stream_icon,
            category: cat,
            epg_channel_id: s.epg_channel_id,
            attributes: { 'tvg-logo': s.stream_icon, 'tvg-id': s.epg_channel_id, 'group-title': cat },
        };
    });

    // ---- VOD + Séries (best-effort) ----
    if (config.enableVod !== false) {
        try {
            const [vod, vodCats, series, seriesCats] = await Promise.all([
                getJson(http, `${base}&action=get_vod_streams`, opts, fetchTimeout),
                getJson(http, `${base}&action=get_vod_categories`, opts, fetchTimeout),
                getJson(http, `${base}&action=get_series`, opts, fetchTimeout),
                getJson(http, `${base}&action=get_series_categories`, opts, fetchTimeout),
            ]);
            const catMap = (arr: any): Record<string, string> => {
                const m: Record<string, string> = {};
                if (Array.isArray(arr)) for (const c of arr) if (c?.category_id && c?.category_name) m[c.category_id] = c.category_name;
                return m;
            };
            const vodCatMap = catMap(vodCats), seriesCatMap = catMap(seriesCats);

            if (Array.isArray(vod)) {
                out.movies = vod.map((m: any) => ({
                    id: `vod${opts.idPrefix}_${m.stream_id}`,
                    streamId: m.stream_id,
                    type: 'movie',
                    name: m.name || m.title,
                    poster: m.stream_icon,
                    year: m.year,
                    rating: m.rating,
                    plot: m.plot || m.description || m.overview || '',
                    category: vodCatMap[m.category_id] || m.category_name || 'Filmes',
                    ext: (m.container_extension || 'mp4').replace(/^\./, ''),
                    added: m.added,
                }));
            }
            if (Array.isArray(series)) {
                out.series = series.map((s: any) => ({
                    id: `ser${opts.idPrefix}_${s.series_id}`,
                    seriesId: s.series_id,
                    type: 'series',
                    name: s.name || s.title,
                    poster: s.cover,
                    year: s.year,
                    plot: s.plot,
                    genre: s.genre,
                    cast: s.cast,
                    director: s.director,
                    rating: s.rating,
                    category: seriesCatMap[s.category_id] || s.category_name || 'Séries',
                    lastModified: s.last_modified,
                }));
            }
            opts.log?.('debug', 'VOD/Series fetched', { movies: out.movies.length, series: out.series.length });
        } catch (e: any) {
            opts.log?.('warn', '[XTREAM] VOD/Series fetch failed (live unaffected)', e?.message);
        }
    }

    // ---- EPG ----
    if (config.enableEpg) {
        const customEpgUrl = config.epgUrl && String(config.epgUrl).trim() ? String(config.epgUrl).trim() : null;
        const epgSource = customEpgUrl
            ? customEpgUrl
            : `${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
        try {
            const epgResp = await http.get(epgSource, { headers: ua(opts), timeoutMs: opts.epgFetchTimeoutMs ?? DEFAULT_EPG_TIMEOUT });
            if (epgResp && epgResp.ok) {
                const epgContent = await epgResp.text();
                out.epgData = await parseEPG(epgContent, { maxBytes: opts.epgMaxBytes, log: opts.log });
            }
        } catch { /* EPG opcional */ }
    }

    return out;
}

/** Info detalhada de um filme (plot, gênero, elenco, duração). */
export async function fetchVodInfo(http: HttpClient, config: AddonConfig, streamId: string | number, opts: XtreamOpts) {
    const url = `${buildBase(config)}&action=get_vod_info&vod_id=${encodeURIComponent(String(streamId))}`;
    const data = await getJson(http, url, opts, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT);
    return data?.info || data?.movie_data || null;
}

/** Info de uma série (temporadas + episódios). */
export async function fetchSeriesInfo(http: HttpClient, config: AddonConfig, seriesId: string | number, opts: XtreamOpts) {
    const url = `${buildBase(config)}&action=get_series_info&series_id=${encodeURIComponent(String(seriesId))}`;
    const data = await getJson(http, url, opts, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT);
    if (!data) return null;
    return {
        info: data?.info || {},
        seasons: Array.isArray(data?.seasons) ? data.seasons : [],
        episodes: data?.episodes || {},
    };
}
