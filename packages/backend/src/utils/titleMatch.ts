/**
 * Title normalization + Cinemeta (IMDB) resolution for matching IPTV VOD
 * against the standard Stremio (Cinemeta) catalog by title + year.
 */

const QUALITY_TOKENS = new Set([
    '4k', 'uhd', 'fhd', 'hd', 'sd', 'dv', 'hdr', 'hdr10', 'h265', 'h264', 'x265', 'x264',
    'dual', 'dublado', 'dub', 'leg', 'legendado', 'nacional', 'atmos', 'web', 'webdl',
    'bluray', 'bdrip', '2160p', '1080p', '720p', '480p', 'remux', 'imax', 'extended',
]);

/**
 * Normalize a title for fuzzy matching: strip bracketed tags, accents,
 * quality/language tokens, and punctuation.
 */
export function normalizeTitle(s: string | undefined | null): string {
    if (!s) return '';
    let t = String(s).toLowerCase();
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' '); // [FHD], (2024)
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');       // strip accents
    t = t.replace(/[^a-z0-9]+/g, ' ').trim();                     // punctuation -> space
    const kept = t.split(/\s+/).filter(w => w && !QUALITY_TOKENS.has(w));
    return kept.join(' ').trim();
}

export interface CineMeta { name: string; year: string | null; }

const cineCache = new Map<string, { data: CineMeta | null; ts: number }>();
const CINE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve an IMDB id (tt…) to its canonical name + year via Cinemeta.
 * Cached in-memory for a day. Returns null on failure.
 */
export async function resolveImdbTitle(
    type: 'movie' | 'series',
    ttId: string,
    timeoutMs = 8000,
): Promise<CineMeta | null> {
    const key = `${type}:${ttId}`;
    const cached = cineCache.get(key);
    if (cached && Date.now() - cached.ts < CINE_TTL_MS) return cached.data;

    let data: CineMeta | null = null;
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(ttId)}.json`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let resp: any;
        try {
            resp = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (resp && resp.ok) {
            const j = await resp.json();
            const m = j?.meta || {};
            const rawYear = m.year || m.releaseInfo || '';
            const year = rawYear ? String(rawYear).slice(0, 4) : null;
            if (m.name) data = { name: m.name, year };
        }
    } catch {
        data = null;
    }
    cineCache.set(key, { data, ts: Date.now() });
    return data;
}

export interface TmdbTitles { names: string[]; year: string | null; }

const tmdbCache = new Map<string, { data: TmdbTitles | null; ts: number }>();

/**
 * Resolve an IMDB id to its TMDB titles (pt-BR + original) + year via the
 * TMDB /find endpoint. This is what lets us match translated catalogs
 * ("A Origem" ⇄ Inception). Returns null if no key or no match.
 */
export async function resolveTmdbTitles(
    type: 'movie' | 'series',
    ttId: string,
    apiKey: string,
    timeoutMs = 8000,
): Promise<TmdbTitles | null> {
    if (!apiKey) return null;
    const key = `${type}:${ttId}`;
    const cached = tmdbCache.get(key);
    if (cached && Date.now() - cached.ts < CINE_TTL_MS) return cached.data;

    let data: TmdbTitles | null = null;
    try {
        const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(ttId)}` +
            `?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id&language=pt-BR`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let resp: any;
        try {
            resp = await fetch(url, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        if (resp && resp.ok) {
            const j = await resp.json();
            const r = type === 'movie' ? (j?.movie_results || [])[0] : (j?.tv_results || [])[0];
            if (r) {
                const names = [r.title, r.name, r.original_title, r.original_name]
                    .filter((n: any): n is string => !!n);
                const date = r.release_date || r.first_air_date || '';
                data = { names: [...new Set(names)], year: date ? String(date).slice(0, 4) : null };
            }
        }
    } catch {
        data = null;
    }
    tmdbCache.set(key, { data, ts: Date.now() });
    return data;
}

/**
 * Clean a provider title for a TMDB search: drop bracketed tags, quality tokens
 * and trailing year, but keep the readable words/accents (TMDB search is fuzzy).
 */
export function cleanForSearch(s: string | undefined | null): string {
    if (!s) return '';
    let t = String(s).replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    t = t.split(/\s+/).filter(w => w && !QUALITY_TOKENS.has(w.toLowerCase())).join(' ');
    t = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
}

export interface TmdbMeta {
    overview: string; poster: string | null; background: string | null;
    rating: string | null; genres: string[]; year: string | null;
    cast: string[]; imdb: string | null; runtime: string | null;
}

const tmdbMetaCache = new Map<string, { data: TmdbMeta | null; ts: number }>();
const TMDB_META_TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Search TMDB by title (pt-BR) and return rich metadata (overview, cast, rating,
 * poster, IMDB id, genres, year). Used to fill gaps where the IPTV provider has
 * no description/IMDB. Cached 7 days. type = 'movie' | 'tv'.
 */
export async function fetchTmdbMeta(
    apiKey: string | null | undefined,
    title: string,
    year: string | null | undefined,
    type: 'movie' | 'tv'
): Promise<TmdbMeta | null> {
    if (!apiKey || !title) return null;
    const clean = cleanForSearch(title);
    if (!clean) return null;
    const key = type + '|' + normalizeTitle(clean) + '|' + (year || '');
    const c = tmdbMetaCache.get(key);
    if (c && Date.now() - c.ts < TMDB_META_TTL) return c.data;

    let data: TmdbMeta | null = null;
    try {
        const yp = year ? (type === 'movie' ? `&year=${year}` : `&first_air_date_year=${year}`) : '';
        const surl = `https://api.themoviedb.org/3/search/${type}?api_key=${encodeURIComponent(apiKey)}` +
            `&language=pt-BR&include_adult=false&query=${encodeURIComponent(clean)}${yp}`;
        const sres = await fetch(surl);
        if (sres.ok) {
            const sj: any = await sres.json();
            const hit = sj.results && sj.results[0];
            if (hit) {
                const durl = `https://api.themoviedb.org/3/${type}/${hit.id}?api_key=${encodeURIComponent(apiKey)}` +
                    `&language=pt-BR&append_to_response=credits,external_ids`;
                const dres = await fetch(durl);
                if (dres.ok) {
                    const d: any = await dres.json();
                    data = {
                        overview: d.overview || hit.overview || '',
                        poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
                        background: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : null,
                        rating: (typeof d.vote_average === 'number' && d.vote_average > 0) ? d.vote_average.toFixed(1) : null,
                        genres: Array.isArray(d.genres) ? d.genres.map((g: any) => g.name) : [],
                        year: (d.release_date || d.first_air_date || '').slice(0, 4) || null,
                        cast: (d.credits && Array.isArray(d.credits.cast)) ? d.credits.cast.slice(0, 10).map((x: any) => x.name) : [],
                        imdb: (d.external_ids && d.external_ids.imdb_id) || null,
                        runtime: d.runtime ? `${d.runtime} min` : null,
                    };
                }
            }
        }
    } catch {
        data = null;
    }
    tmdbMetaCache.set(key, { data, ts: Date.now() });
    return data;
}
