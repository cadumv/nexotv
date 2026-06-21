import { parseEPG } from '../parsers/epgParser';
import { validatePublicUrl } from '../utils/validateUrl';
import env from '../config/env';

async function withTimeout(url: string, options: any, ms: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchData(addonInstance: any) {
    const { config } = addonInstance;
    const {
        xtreamUrl,
        xtreamUsername,
        xtreamPassword
    } = config;

    if (!xtreamUrl || !xtreamUsername || !xtreamPassword) {
        throw new Error('Xtream credentials incomplete');
    }

    await validatePublicUrl(xtreamUrl);
    const base = `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

    const liveHeaders: Record<string, string> = {};
    if (addonInstance.xtreamEtag) liveHeaders['If-None-Match'] = addonInstance.xtreamEtag;

    const [liveResp, liveCatsResp] = await Promise.all([
        withTimeout(`${base}&action=get_live_streams`, { headers: liveHeaders }, env.FETCH_TIMEOUT_MS),
        withTimeout(`${base}&action=get_live_categories`, {}, env.FETCH_TIMEOUT_MS).catch(() => null)
    ]);

    if (liveResp.status === 304) {
        addonInstance.log?.debug('Xtream 304 Not Modified — skipping update');
        return;
    }
    if (!liveResp.ok) throw new Error('Xtream live streams fetch failed');

    addonInstance.xtreamEtag = liveResp.headers.get('etag') ?? null;

    addonInstance.channels = [];
    addonInstance.epgData = {};

    const live = await liveResp.json();

    let liveCatMap: Record<string, string> = {};
    try {
        if (liveCatsResp && liveCatsResp.ok) {
            const arr = await liveCatsResp.json();
            if (Array.isArray(arr)) {
                for (const c of arr) {
                    if (c && c.category_id && c.category_name)
                        liveCatMap[c.category_id] = c.category_name;
                }
            }
        }
    } catch { /* ignore */ }

    addonInstance.channels = (Array.isArray(live) ? live : []).map((s: any) => {
        const cat = liveCatMap[s.category_id] || s.category_name || s.category_id || 'Live';
        return {
            id: `xc${addonInstance.idPrefix}_${s.stream_id}`,
            name: s.name,
            type: 'tv',
            url: `${xtreamUrl}/live/${xtreamUsername}/${xtreamPassword}/${s.stream_id}.m3u8`,
            logo: s.stream_icon,
            category: cat,
            epg_channel_id: s.epg_channel_id,
            attributes: {
                'tvg-logo': s.stream_icon,
                'tvg-id': s.epg_channel_id,
                'group-title': cat
            }
        };
    });

    // ---- VOD (movies) + Series ----
    // Best-effort: failures here must NOT break live channels.
    if (config.enableVod !== false) {
        try {
            const [vodResp, vodCatsResp, seriesResp, seriesCatsResp] = await Promise.all([
                withTimeout(`${base}&action=get_vod_streams`, {}, env.FETCH_TIMEOUT_MS).catch(() => null),
                withTimeout(`${base}&action=get_vod_categories`, {}, env.FETCH_TIMEOUT_MS).catch(() => null),
                withTimeout(`${base}&action=get_series`, {}, env.FETCH_TIMEOUT_MS).catch(() => null),
                withTimeout(`${base}&action=get_series_categories`, {}, env.FETCH_TIMEOUT_MS).catch(() => null),
            ]);

            const readCatMap = async (resp: any): Promise<Record<string, string>> => {
                const map: Record<string, string> = {};
                try {
                    if (resp && resp.ok) {
                        const arr = await resp.json();
                        if (Array.isArray(arr)) {
                            for (const c of arr) {
                                if (c && c.category_id && c.category_name) map[c.category_id] = c.category_name;
                            }
                        }
                    }
                } catch { /* ignore */ }
                return map;
            };

            const vodCatMap = await readCatMap(vodCatsResp);
            const seriesCatMap = await readCatMap(seriesCatsResp);

            if (vodResp && vodResp.ok) {
                const vod = await vodResp.json();
                addonInstance.movies = (Array.isArray(vod) ? vod : []).map((m: any) => ({
                    id: `vod${addonInstance.idPrefix}_${m.stream_id}`,
                    streamId: m.stream_id,
                    type: 'movie',
                    name: m.name || m.title,
                    poster: m.stream_icon,
                    year: m.year,
                    rating: m.rating,
                    category: vodCatMap[m.category_id] || m.category_name || 'Filmes',
                    ext: (m.container_extension || 'mp4').replace(/^\./, ''),
                    added: m.added,
                }));
            }

            if (seriesResp && seriesResp.ok) {
                const series = await seriesResp.json();
                addonInstance.series = (Array.isArray(series) ? series : []).map((s: any) => ({
                    id: `ser${addonInstance.idPrefix}_${s.series_id}`,
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

            addonInstance.log?.debug('VOD/Series fetched', {
                movies: addonInstance.movies?.length || 0,
                series: addonInstance.series?.length || 0,
            });
        } catch (e: any) {
            addonInstance.log?.warn('[XTREAM] VOD/Series fetch failed (live unaffected):', e?.message);
        }
    }

    if (config.enableEpg) {
        const customEpgUrl = config.epgUrl && typeof config.epgUrl === 'string' && config.epgUrl.trim() ? config.epgUrl.trim() : null;
        const epgSource = customEpgUrl
            ? customEpgUrl
            : `${xtreamUrl}/xmltv.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;

        const now = Date.now();
        const epgStale = !addonInstance.lastEpgUpdate ||
            (now - addonInstance.lastEpgUpdate > env.EPG_UPDATE_INTERVAL_MS);

        if (epgStale) {
            try {
                if (customEpgUrl) await validatePublicUrl(epgSource);
                const epgResp = await withTimeout(epgSource, {}, env.EPG_FETCH_TIMEOUT_MS);
                if (epgResp.ok) {
                    const contentLength = parseInt(epgResp.headers.get('content-length') ?? '0', 10);
                    if (contentLength > env.EPG_MAX_BYTES) {
                        const sizeMb = (contentLength / 1024 / 1024).toFixed(1);
                        addonInstance.log?.warn(`[EPG] Content-Length too large (${sizeMb} MB), skipping download`);
                    } else {
                        const epgContent = await epgResp.text();
                        addonInstance.epgData = await parseEPG(epgContent, addonInstance.log);
                        addonInstance.lastEpgUpdate = Date.now();
                    }
                }
            } catch {
                // Ignore EPG errors
            }
        } else {
            addonInstance.log?.debug('EPG skip (interval not elapsed)', {
                ms: now - (addonInstance.lastEpgUpdate ?? 0)
            });
        }
    }
}

function buildBase(config: any) {
    const { xtreamUrl, xtreamUsername, xtreamPassword } = config;
    return `${xtreamUrl}/player_api.php?username=${encodeURIComponent(xtreamUsername)}&password=${encodeURIComponent(xtreamPassword)}`;
}

/**
 * Fetch detailed VOD info (plot, genre, cast, duration) for a single movie.
 * Returns the raw `info` object or null.
 */
export async function fetchVodInfo(config: any, streamId: string | number) {
    try {
        await validatePublicUrl(config.xtreamUrl);
        const url = `${buildBase(config)}&action=get_vod_info&vod_id=${encodeURIComponent(String(streamId))}`;
        const resp = await withTimeout(url, {}, env.FETCH_TIMEOUT_MS);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.info || data?.movie_data || null;
    } catch {
        return null;
    }
}

/**
 * Fetch series info (seasons + episodes) for a single series.
 * Returns { info, episodes } where episodes is keyed by season number.
 */
export async function fetchSeriesInfo(config: any, seriesId: string | number) {
    try {
        await validatePublicUrl(config.xtreamUrl);
        const url = `${buildBase(config)}&action=get_series_info&series_id=${encodeURIComponent(String(seriesId))}`;
        const resp = await withTimeout(url, {}, env.FETCH_TIMEOUT_MS);
        if (!resp.ok) return null;
        const data = await resp.json();
        return {
            info: data?.info || {},
            seasons: Array.isArray(data?.seasons) ? data.seasons : [],
            episodes: data?.episodes || {},
        };
    } catch {
        return null;
    }
}
