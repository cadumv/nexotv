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
