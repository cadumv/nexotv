/**
 * Resolução de títulos (Cinemeta/IMDB + TMDB), independente de servidor.
 * Migrado de packages/backend; rede via `HttpClient`, apiKey por parâmetro.
 * Os helpers puros (normalizeTitle/cleanForSearch) vêm de ../text/normalize.
 */
import { HttpClient } from '../http/HttpClient';
import { normalizeTitle, cleanForSearch } from '../text/normalize';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CineMeta { name: string; year: string | null; }

const cineCache = new Map<string, { data: CineMeta | null; ts: number }>();

/** Resolve um IMDB id (tt…) para nome+ano via Cinemeta. Cache 1 dia. */
export async function resolveImdbTitle(
    http: HttpClient,
    type: 'movie' | 'series',
    ttId: string,
    timeoutMs = 8000,
): Promise<CineMeta | null> {
    const key = `${type}:${ttId}`;
    const cached = cineCache.get(key);
    if (cached && Date.now() - cached.ts < DAY_MS) return cached.data;

    let data: CineMeta | null = null;
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(ttId)}.json`;
        const resp = await http.get(url, { timeoutMs });
        if (resp && resp.ok) {
            const j = await resp.json();
            const m = j?.meta || {};
            const rawYear = m.year || m.releaseInfo || '';
            const year = rawYear ? String(rawYear).slice(0, 4) : null;
            if (m.name) data = { name: m.name, year };
        }
    } catch { data = null; }
    cineCache.set(key, { data, ts: Date.now() });
    return data;
}

export interface TmdbTitles { names: string[]; year: string | null; }

const tmdbCache = new Map<string, { data: TmdbTitles | null; ts: number }>();

/** Resolve um IMDB id para títulos TMDB (pt-BR + original) + ano via /find. */
export async function resolveTmdbTitles(
    http: HttpClient,
    type: 'movie' | 'series',
    ttId: string,
    apiKey: string,
    timeoutMs = 8000,
): Promise<TmdbTitles | null> {
    if (!apiKey) return null;
    const key = `${type}:${ttId}`;
    const cached = tmdbCache.get(key);
    if (cached && Date.now() - cached.ts < DAY_MS) return cached.data;

    let data: TmdbTitles | null = null;
    try {
        const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(ttId)}` +
            `?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id&language=pt-BR`;
        const resp = await http.get(url, { timeoutMs });
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
    } catch { data = null; }
    tmdbCache.set(key, { data, ts: Date.now() });
    return data;
}

export interface TmdbMeta {
    overview: string; poster: string | null; background: string | null;
    rating: string | null; genres: string[]; year: string | null;
    cast: string[]; imdb: string | null; runtime: string | null;
}

const tmdbMetaCache = new Map<string, { data: TmdbMeta | null; ts: number }>();
const TMDB_META_TTL = 7 * DAY_MS;

/**
 * Busca metadados ricos no TMDB por título (pt-BR). Preenche lacunas onde o
 * provedor IPTV não tem descrição/IMDB. Cache 7 dias. type = 'movie' | 'tv'.
 */
export async function fetchTmdbMeta(
    http: HttpClient,
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
        const sres = await http.get(surl, { timeoutMs: 8000 });
        if (sres.ok) {
            const sj: any = await sres.json();
            const hit = sj.results && sj.results[0];
            if (hit) {
                const durl = `https://api.themoviedb.org/3/${type}/${hit.id}?api_key=${encodeURIComponent(apiKey)}` +
                    `&language=pt-BR&append_to_response=credits,external_ids`;
                const dres = await http.get(durl, { timeoutMs: 8000 });
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
    } catch { data = null; }
    tmdbMetaCache.set(key, { data, ts: Date.now() });
    return data;
}
