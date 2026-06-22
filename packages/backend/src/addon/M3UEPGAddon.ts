import crypto from 'crypto';
import LRUCache from '../utils/lruCache';
import * as sqliteCache from '../utils/sqliteCache';
import { makeLogger } from '../utils/logger';
import { parseEPG, getCurrentProgram, getUpcomingPrograms } from '../parsers/epgParser';
import env from '../config/env';
import * as xtreamProvider from '../providers/xtreamProvider';
import * as iptvOrgProvider from '../providers/iptvOrgProvider';
import * as m3uProvider from '../providers/m3uProvider';
import { normalizeTitle, resolveImdbTitle, resolveTmdbTitles } from '../utils/titleMatch';

const CACHE_ENABLED = env.CACHE_ENABLED;
const CACHE_TTL_MS = env.CACHE_TTL_MS;
const MAX_CACHE_ENTRIES = env.MAX_CACHE_ENTRIES;

if (CACHE_ENABLED) {
    sqliteCache.init(env.SQLITE_PATH);
}

export const buildPromiseCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });

const PROVIDER_MAP: Record<string, { fetchData: (addon: any) => Promise<void> }> = {
    'xtream': xtreamProvider,
    'iptv-org': iptvOrgProvider,
    'm3u': m3uProvider,
};

export interface AddonConfig {
    provider?: string;
    xtreamUrl?: string;
    xtreamUsername?: string;
    xtreamPassword?: string;
    m3uUrl?: string;
    epgUrl?: string;
    enableEpg?: boolean;
    enableVod?: boolean;
    epgOffsetHours?: number | string;
    reformatLogos?: boolean;
    iptvOrgCountry?: string;
    iptvOrgCategory?: string;
    instanceId?: string;
    catalogName?: string;
    globalUserAgent?: string;
}

function stableStringify(obj: any) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

export function createCacheKey(config: AddonConfig) {
    const provider = config.provider || 'xtream';
    let minimal: any;
    if (provider === 'iptv-org') {
        minimal = {
            provider,
            iptvOrgCountry: config.iptvOrgCountry || null,
            iptvOrgCategory: config.iptvOrgCategory || null,
        };
    } else if (provider === 'm3u') {
        minimal = {
            provider,
            m3uUrl: config.m3uUrl || null,
            enableEpg: !!config.enableEpg,
            epgUrl: config.epgUrl || null,
            epgOffsetHours: config.epgOffsetHours,
            reformatLogos: !!config.reformatLogos,
            globalUserAgent: config.globalUserAgent || null,
        };
    } else {
        minimal = {
            provider: 'xtream',
            epgUrl: config.epgUrl,
            enableEpg: !!config.enableEpg,
            xtreamUrl: config.xtreamUrl,
            xtreamUsername: config.xtreamUsername,
            epgOffsetHours: config.epgOffsetHours,
            reformatLogos: !!config.reformatLogos
        };
    }
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

export class M3UEPGAddon {
    providerName: string;
    config: AddonConfig;
    manifestRef: any;
    cacheKey: string;
    idPrefix: string;
    updateInterval: number;
    channels: any[];
    channelMap: Map<string, any>;
    movies: any[];
    movieMap: Map<string, any>;
    series: any[];
    seriesMap: Map<string, any>;
    movieTitleIndex: Map<string, any>;
    movieTitleYearIndex: Map<string, any>;
    seriesTitleIndex: Map<string, any>;
    seriesTitleYearIndex: Map<string, any>;
    seriesInfoCache: Map<string, { data: any; ts: number }>;
    vodInfoCache: Map<string, { data: any; ts: number }>;
    epgData: Record<string, any[]>;
    lastUpdate: number;
    m3uEtag: string | null;
    m3uLastModified: string | null;
    iptvOrgEtag: string | null;
    xtreamEtag: string | null;
    lastEpgUpdate: number | null;
    _evictTimer: any;
    private _updateTimer: ReturnType<typeof setInterval> | null;
    _loadPromise: any;
    firstCatalogRefreshDone: boolean;
    firstCatalogRefreshPromise: any;
    private _consecutiveRefreshFailures = 0;
    private _refreshFailedAt: number | null = null;
    private _timerConsecutiveFailures = 0;
    private _timerPausedUntil: number | null = null;
    cacheTtl: number;
    log: ReturnType<typeof makeLogger>;

    constructor(config: AddonConfig = {}, manifestRef?: any) {
        this.providerName = config.provider || 'xtream';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.idPrefix = this.cacheKey.slice(0, 8);
        this.updateInterval = env.UPDATE_INTERVAL_MS;
        this.channels = [];
        this.channelMap = new Map();
        this.movies = [];
        this.movieMap = new Map();
        this.series = [];
        this.seriesMap = new Map();
        this.movieTitleIndex = new Map();
        this.movieTitleYearIndex = new Map();
        this.seriesTitleIndex = new Map();
        this.seriesTitleYearIndex = new Map();
        this.seriesInfoCache = new Map();
        this.vodInfoCache = new Map();
        this.epgData = {};
        this.lastUpdate = 0;
        this.m3uEtag = null;
        this.m3uLastModified = null;
        this.iptvOrgEtag = null;
        this.xtreamEtag = null;
        this.lastEpgUpdate = null;
        this._evictTimer = null;
        this._updateTimer = null;
        this._loadPromise = null;
        this.firstCatalogRefreshDone = false;
        this.firstCatalogRefreshPromise = null;
        const TTL_MAP: Record<string, number> = {
            'iptv-org': env.IPTV_ORG_CACHE_TTL_MS,
            'm3u': env.M3U_CACHE_TTL_MS,
        };
        this.cacheTtl = TTL_MAP[this.providerName] ?? CACHE_TTL_MS;
        this.log = makeLogger();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours as number))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours as number) > 48)
            this.config.epgOffsetHours = 0;

        if (this.providerName === 'iptv-org' || this.providerName === 'm3u') {
            this.config.reformatLogos = true;
        }

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours
        });
    }

    async saveChannelsToCache() {
        if (!CACHE_ENABLED) return;
        sqliteCache.setRaw('addon:channels:' + this.cacheKey, {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            lastUpdate: this.lastUpdate,
            m3uEtag: this.m3uEtag ?? null,
            m3uLastModified: this.m3uLastModified ?? null,
            iptvOrgEtag: this.iptvOrgEtag ?? null,
            xtreamEtag: this.xtreamEtag ?? null,
            lastEpgUpdate: this.lastEpgUpdate ?? null,
        }, this.cacheTtl);
        this.log.debug('Channels saved to cache', { count: this.channels.length });
    }

    async loadChannelsFromCache() {
        if (!CACHE_ENABLED) return;
        const cached = sqliteCache.getRaw('addon:channels:' + this.cacheKey);
        if (cached) {
            this.channels = cached.channels || [];
            this.channelMap = new Map(this.channels.map(c => [c.id, c]));
            this.movies = cached.movies || [];
            this.movieMap = new Map(this.movies.map((m: any) => [m.id, m]));
            this.series = cached.series || [];
            this.seriesMap = new Map(this.series.map((s: any) => [s.id, s]));
            this.buildTitleIndexes();
            this.lastUpdate = cached.lastUpdate || 0;
            this.m3uEtag = cached.m3uEtag ?? null;
            this.m3uLastModified = cached.m3uLastModified ?? null;
            this.iptvOrgEtag = cached.iptvOrgEtag ?? null;
            this.xtreamEtag = cached.xtreamEtag ?? null;
            this.lastEpgUpdate = cached.lastEpgUpdate ?? null;
            this.log.debug('Channels loaded from cache', { count: this.channels.length });
        }
    }

    async saveEpgToCache() {
        if (!CACHE_ENABLED) return;
        if (!this.epgData || Object.keys(this.epgData).length === 0) return;
        sqliteCache.set('addon:epg:' + this.cacheKey, { epgData: this.epgData }, this.cacheTtl);
        this.log.debug('EPG saved to cache', { channels: Object.keys(this.epgData).length });
    }

    async loadEpgFromCache() {
        if (!CACHE_ENABLED) return;
        const cached = sqliteCache.get('addon:epg:' + this.cacheKey);
        if (cached) {
            this.epgData = cached.epgData || {};
            this.log.debug('EPG loaded from cache', { channels: Object.keys(this.epgData).length });
        }
    }

    async ensureEpgLoaded() {
        if (this.epgData && Object.keys(this.epgData).length > 0) return;
        if (!CACHE_ENABLED) return;
        await this.loadEpgFromCache();
    }

    buildGenresInManifest() {
        if (!this.manifestRef) return;
        const tvCatalog = this.manifestRef.catalogs.find((c: any) => c.id === 'iptv_channels');
        if (tvCatalog) {
            const groups = [
                ...new Set(
                    this.channels
                        .map(c => c.category || c.attributes?.['group-title'])
                        .filter(Boolean)
                        .map((s: string) => s.trim())
                )
            ].sort((a: any, b: any) => a.localeCompare(b));
            if (!groups.includes('All Channels')) groups.unshift('All Channels');
            // Accent-stripped for display (Stremio mis-renders UTF-8). The genre
            // filter in builder.ts compares accent-insensitively so this still works.
            const dispGroups = groups.map((g: any) => M3UEPGAddon.stripAccents(g));
            tvCatalog.genres = dispGroups;

            const genreExtra = tvCatalog.extra.find((e: any) => e.name === 'genre');
            if (genreExtra) {
                genreExtra.options = dispGroups;
            }
        }

        const setCatalogGenres = (catalogId: string, items: any[]) => {
            const cat = this.manifestRef.catalogs.find((c: any) => c.id === catalogId);
            if (!cat) return;
            const groups = [
                ...new Set(items.map((i: any) => i.category).filter(Boolean).map((s: string) => s.trim()))
            ].sort((a: any, b: any) => a.localeCompare(b)).map((g: any) => M3UEPGAddon.stripAccents(g));
            cat.genres = groups;
            const genreExtra = cat.extra?.find((e: any) => e.name === 'genre');
            if (genreExtra) genreExtra.options = groups;
        };
        setCatalogGenres('nexotv_vod', this.movies || []);
        setCatalogGenres('nexotv_series', this.series || []);

        this._appendCategoryCatalogs();

        this.log.debug('Catalog genres built', {
            tvGenres: tvCatalog?.genres?.length || 0,
            movies: this.movies?.length || 0,
            series: this.series?.length || 0,
            totalCatalogs: this.manifestRef?.catalogs?.length || 0,
        });
    }

    // Encode a provider category name into a URL-safe catalog id suffix (base64url).
    static encodeCategory(name: string) {
        return Buffer.from(name, 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    static decodeCategory(b64: string) {
        let s = b64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = (4 - (s.length % 4)) % 4;
        if (pad) s += '='.repeat(pad);
        return Buffer.from(s, 'base64').toString('utf8');
    }

    // Stremio's Android/TV client mis-renders UTF-8 accents in catalog names
    // (e.g. "Séries" shows as "SÃ©ries"). Strip diacritics for the DISPLAY name
    // only — the catalog id keeps the original category so item filtering still works.
    static stripAccents(s: string) {
        return s.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
    }

    // Expose every provider category as its own Stremio catalog (one row each),
    // in addition to the three base catalogs. Idempotent: strips previously-added
    // category catalogs before re-appending so repeated builds don't duplicate.
    _appendCategoryCatalogs() {
        if (!this.manifestRef) return;
        const BASE = new Set(['iptv_channels', 'nexotv_vod', 'nexotv_series']);
        // The manifest's `catalogs` property is read-only (cannot reassign), so
        // mutate the array in place: strip previously-added category catalogs.
        const catalogs = this.manifestRef.catalogs;
        for (let i = catalogs.length - 1; i >= 0; i--) {
            if (!BASE.has(catalogs[i].id)) catalogs.splice(i, 1);
        }

        // name: accent-stripped for display (client mis-renders UTF-8); id keeps
        // the original category (via encodeCategory) so item filtering still matches.
        // No 'search' extra here: only the 3 base catalogs are searchable, so a
        // global search doesn't loop through all ~119 category catalogs.
        const mk = (type: string, base: string, category: string) => ({
            type,
            id: `${base}_g_${M3UEPGAddon.encodeCategory(category)}`,
            name: M3UEPGAddon.stripAccents(category),
            extra: [
                { name: 'skip' }
            ],
            genres: []
        });

        const addCats = (type: string, base: string, items: any[], getCat: (i: any) => string | undefined) => {
            const cats = [
                ...new Set(items.map(getCat).filter(Boolean).map((s: any) => s.trim()))
            ].sort((a: any, b: any) => a.localeCompare(b));
            for (const c of cats) this.manifestRef.catalogs.push(mk(type, base, c as string));
        };

        addCats('movie', 'nexotv_vod', this.movies || [], (i: any) => i.category);
        addCats('series', 'nexotv_series', this.series || [], (i: any) => i.category);
        addCats('tv', 'iptv_channels', this.channels || [], (c: any) => c.category || c.attributes?.['group-title']);
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if (this.channels.length && now - this.lastUpdate < env.MIN_UPDATE_INTERVAL_MS) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        try {
            const start = Date.now();
            const providerModule = PROVIDER_MAP[this.providerName];
            if (!providerModule) throw new Error(`Unknown provider: ${this.providerName}`);
            const epgUpdateTimeBefore = this.lastEpgUpdate;
            await providerModule.fetchData(this);
            this.channelMap = new Map(this.channels.map(c => [c.id, c]));
            this.movieMap = new Map((this.movies || []).map(m => [m.id, m]));
            this.seriesMap = new Map((this.series || []).map(s => [s.id, s]));
            this.buildTitleIndexes();
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED && this.channels.length > 0) {
                await this.saveChannelsToCache();
                if (this.lastEpgUpdate !== epgUpdateTimeBefore) {
                    await this.saveEpgToCache();
                }
            }
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                ms: Date.now() - start
            });
        } catch (e: any) {
            this.log.error('[UPDATE] Failed:', e.message);
            throw e;
        }
    }

    private _getRefreshCooldownMs(): number {
        if (this._consecutiveRefreshFailures <= 0) return 0;
        if (this._consecutiveRefreshFailures === 1) return 60_000;      // 1 min
        if (this._consecutiveRefreshFailures === 2) return 5 * 60_000;  // 5 min
        return 30 * 60_000;                                              // 30 min
    }

    async refreshOnFirstCatalogRequest() {
        // Exponential backoff: don't hammer a failing provider
        if (this._refreshFailedAt !== null) {
            const cooldown = this._getRefreshCooldownMs();
            if (Date.now() - this._refreshFailedAt < cooldown) return;
        }

        if (this.firstCatalogRefreshDone) return;
        if (this.firstCatalogRefreshPromise) {
            await this.firstCatalogRefreshPromise;
            return;
        }

        const JUST_FETCHED_MS = 2 * 60 * 1000;
        if (this.lastUpdate && (Date.now() - this.lastUpdate < JUST_FETCHED_MS)) {
            this.firstCatalogRefreshDone = true;
            return;
        }

        this.firstCatalogRefreshPromise = (async () => {
            // Reset ETags so the forced re-fetch is unconditional (not a 304).
            // Without this, channels evicted from RAM + a cached ETag would cause
            // fetchData to get a 304, save 0 channels, and wipe the valid cache.
            this.m3uEtag = null;
            this.m3uLastModified = null;
            this.iptvOrgEtag = null;
            this.xtreamEtag = null;
            if (CACHE_ENABLED) {
                sqliteCache.del('addon:channels:' + this.cacheKey);
                sqliteCache.del('addon:epg:' + this.cacheKey);
            }
            await this.updateData(true);
            this.firstCatalogRefreshDone = true;
            this.log.debug('Bootstrap catalog refresh completed', {
                cacheKey: this.cacheKey,
                channels: this.channels.length
            });
        })();

        try {
            await this.firstCatalogRefreshPromise;
            this._consecutiveRefreshFailures = 0;  // reset on success
            this._refreshFailedAt = null;
        } catch (e) {
            this._consecutiveRefreshFailures++;
            this._refreshFailedAt = Date.now();
            throw e;
        } finally {
            this.firstCatalogRefreshPromise = null;
        }
    }

    deriveFallbackLogoUrl(item: any) {
        let finalUrl: string;
        const logoAttr = item.attributes?.['tvg-logo'] || item.logo;
        if (logoAttr && logoAttr.trim()) {
            finalUrl = logoAttr;
        } else {
            finalUrl = `https://placehold.co/250x375/2b2b2b/FFFFFF.png?text=${encodeURIComponent(item.name || 'TV')}`;
        }

        if (this.config.reformatLogos && finalUrl.startsWith('http') && !finalUrl.includes('wsrv.nl') && !finalUrl.includes('placehold.co')) {
            if (finalUrl.includes('imgur.com')) {
                finalUrl = `https://proxy.duckduckgo.com/iu/?u=${encodeURIComponent(finalUrl)}`;
            }
            return `https://wsrv.nl/?url=${encodeURIComponent(finalUrl)}&w=250&h=375&fit=contain&we&bg=2b2b2b`;
        }
        return finalUrl;
    }

    generateMetaPreview(item: any) {
        const logoUrl = this.deriveFallbackLogoUrl(item);
        return {
            id: item.id,
            type: 'tv',
            name: item.name,
            description: '📡 Live Channel',
            poster: logoUrl,
            background: logoUrl,
            posterShape: 'poster',
            genres: item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live'
        };
    }

    // ---------- VOD (movies) & Series ----------

    private _posterOrPlaceholder(url: string | undefined, name: string) {
        if (url && url.trim()) return url;
        return `https://placehold.co/250x375/2b2b2b/FFFFFF.png?text=${encodeURIComponent(name || 'VOD')}`;
    }

    generateMoviePreview(m: any) {
        return {
            id: m.id,
            type: 'movie',
            name: m.name,
            poster: this._posterOrPlaceholder(m.poster, m.name),
            posterShape: 'poster',
            releaseInfo: m.year || undefined,
            imdbRating: m.rating || undefined,
            genres: m.category ? [m.category] : undefined,
        };
    }

    generateSeriesPreview(s: any) {
        return {
            id: s.id,
            type: 'series',
            name: s.name,
            poster: this._posterOrPlaceholder(s.poster, s.name),
            posterShape: 'poster',
            releaseInfo: s.year || undefined,
            imdbRating: s.rating || undefined,
            genres: s.category ? [s.category] : undefined,
        };
    }

    async getMoviesForCatalog() {
        await this.ensureDataLoaded();
        return this.movies || [];
    }

    async getSeriesForCatalog() {
        await this.ensureDataLoaded();
        return this.series || [];
    }

    buildTitleIndexes() {
        this.movieTitleIndex = new Map();
        this.movieTitleYearIndex = new Map();
        this.seriesTitleIndex = new Map();
        this.seriesTitleYearIndex = new Map();
        for (const m of this.movies || []) {
            const key = normalizeTitle(m.name);
            if (!key) continue;
            if (!this.movieTitleIndex.has(key)) this.movieTitleIndex.set(key, m);
            const y = m.year ? String(m.year).slice(0, 4) : null;
            if (y) {
                const yk = `${key}|${y}`;
                if (!this.movieTitleYearIndex.has(yk)) this.movieTitleYearIndex.set(yk, m);
            }
        }
        for (const s of this.series || []) {
            const key = normalizeTitle(s.name);
            if (!key) continue;
            if (!this.seriesTitleIndex.has(key)) this.seriesTitleIndex.set(key, s);
            const y = s.year ? String(s.year).slice(0, 4) : null;
            if (y) {
                const yk = `${key}|${y}`;
                if (!this.seriesTitleYearIndex.has(yk)) this.seriesTitleYearIndex.set(yk, s);
            }
        }
    }

    private _lookupByTitle(
        byTitle: Map<string, any>,
        byTitleYear: Map<string, any>,
        items: any[],
        name: string,
        year: string | null,
    ) {
        const key = normalizeTitle(name);
        if (!key) return null;

        // 1) Exact title + year (±1 for release-date drift between sources)
        if (year) {
            for (const y of [year, String(Number(year) + 1), String(Number(year) - 1)]) {
                const hit = byTitleYear.get(`${key}|${y}`);
                if (hit) return hit;
            }
        }
        // 2) Exact title
        const exact = byTitle.get(key);
        if (exact) return exact;

        // 3) Fuzzy: IPTV title often carries a subtitle ("Breaking Bad: A Química…").
        //    Accept when one normalized title is a word-boundary prefix of the other.
        //    Prefer a year match; otherwise the closest (shortest) candidate.
        let best: any = null;
        let bestLen = Infinity;
        let bestYearMatch = false;
        for (const it of items) {
            const t = normalizeTitle(it.name);
            if (!t) continue;
            const isPrefix = t === key || t.startsWith(key + ' ') || key.startsWith(t + ' ');
            if (!isPrefix) continue;
            const ym = !!(year && it.year && String(it.year).slice(0, 4) === year);
            // Prefer year matches; among those (or among non-matches) prefer shortest title.
            if (ym && !bestYearMatch) { best = it; bestLen = t.length; bestYearMatch = true; continue; }
            if (ym === bestYearMatch && t.length < bestLen) { best = it; bestLen = t.length; }
        }
        return best;
    }

    async getSeriesInfoCached(id: string, seriesId: string | number) {
        const cached = this.seriesInfoCache.get(id);
        if (cached && Date.now() - cached.ts < this.cacheTtl) return cached.data;
        const data = await xtreamProvider.fetchSeriesInfo(this.config, seriesId);
        if (data) this.seriesInfoCache.set(id, { data, ts: Date.now() });
        return data;
    }

    /** Build ordered name+year candidates for an IMDB id: TMDB (pt-BR + original) then Cinemeta. */
    private async _imdbTitleCandidates(type: 'movie' | 'series', ttId: string) {
        const out: { name: string; year: string | null }[] = [];
        const apiKey = (env as any).TMDB_API_KEY;
        if (apiKey) {
            const tmdb = await resolveTmdbTitles(type, ttId, apiKey);
            if (tmdb) for (const n of tmdb.names) out.push({ name: n, year: tmdb.year });
        }
        const cine = await resolveImdbTitle(type, ttId);
        if (cine?.name) out.push({ name: cine.name, year: cine.year });
        return out;
    }

    /** Resolve an IMDB movie id (tt…) to an IPTV stream by title+year. */
    async getMovieStreamsByImdb(ttId: string) {
        const candidates = await this._imdbTitleCandidates('movie', ttId);
        let m: any = null;
        for (const c of candidates) {
            m = this._lookupByTitle(this.movieTitleIndex, this.movieTitleYearIndex, this.movies || [], c.name, c.year);
            if (m) break;
        }
        if (!m) return [];
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${m.streamId}.${m.ext || 'mp4'}`;
        return [{
            url,
            title: `📺 IPTV${m.year ? ` (${m.year})` : ''}`,
            behaviorHints: { bingeGroup: `nexotv-vod-${this.idPrefix}` },
        }];
    }

    /** Resolve an IMDB series episode (tt…:S:E) to an IPTV stream by title+year. */
    async getSeriesStreamsByImdb(ttId: string, season: number, episode: number) {
        const candidates = await this._imdbTitleCandidates('series', ttId);
        let s: any = null;
        for (const c of candidates) {
            s = this._lookupByTitle(this.seriesTitleIndex, this.seriesTitleYearIndex, this.series || [], c.name, c.year);
            if (s) break;
        }
        if (!s) return [];
        const data = await this.getSeriesInfoCached(s.id, s.seriesId);
        const eps = data?.episodes?.[String(season)] || [];
        const ep = eps.find((e: any) => Number(e.episode_num) === episode);
        if (!ep) return [];
        const ext = (ep.container_extension || 'mp4').replace(/^\./, '');
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${ep.id}.${ext}`;
        return [{
            url,
            title: `📺 IPTV — S${season}E${episode}`,
            behaviorHints: { bingeGroup: `nexotv-series-${this.idPrefix}` },
        }];
    }

    async getMovieMeta(id: string) {
        const m = this.movieMap.get(id);
        if (!m) return null;
        let info: any = null;
        const cached = this.vodInfoCache.get(id);
        if (cached && Date.now() - cached.ts < this.cacheTtl) {
            info = cached.data;
        } else {
            info = await xtreamProvider.fetchVodInfo(this.config, m.streamId);
            if (info) this.vodInfoCache.set(id, { data: info, ts: Date.now() });
        }
        const cast = info?.cast ? String(info.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;
        const backdrop = Array.isArray(info?.backdrop_path) ? info.backdrop_path[0] : undefined;
        return {
            id: m.id,
            type: 'movie',
            name: m.name,
            poster: this._posterOrPlaceholder(m.poster, m.name),
            posterShape: 'poster',
            background: backdrop || m.poster,
            description: info?.plot || info?.description || '',
            releaseInfo: m.year || info?.releasedate || undefined,
            imdbRating: m.rating || info?.rating || undefined,
            genres: m.category ? [m.category] : (info?.genre ? [info.genre] : undefined),
            runtime: info?.duration || undefined,
            cast,
            director: info?.director || undefined,
        };
    }

    async getSeriesMeta(id: string) {
        const s = this.seriesMap.get(id);
        if (!s) return null;
        const data = await this.getSeriesInfoCached(id, s.seriesId);
        const videos: any[] = [];
        if (data?.episodes) {
            for (const seasonNum of Object.keys(data.episodes)) {
                const eps = data.episodes[seasonNum] || [];
                for (const ep of eps) {
                    const ext = (ep.container_extension || 'mp4').replace(/^\./, '');
                    const seasN = Number(seasonNum) || 1;
                    const epNum = Number(ep.episode_num) || (videos.length + 1);
                    let released: string | undefined;
                    if (ep.info?.releasedate) released = ep.info.releasedate;
                    else if (ep.added) {
                        const t = Number(ep.added);
                        if (isFinite(t) && t > 0) released = new Date(t * 1000).toISOString();
                    }
                    videos.push({
                        id: `epi${this.idPrefix}_${ep.id}__${ext}`,
                        title: ep.title || `S${seasN}E${epNum}`,
                        season: seasN,
                        episode: epNum,
                        thumbnail: ep.info?.movie_image || ep.info?.cover_big || s.poster || undefined,
                        overview: ep.info?.plot || ep.info?.overview || undefined,
                        released,
                    });
                }
            }
        }
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        const backdrop = Array.isArray(data?.info?.backdrop_path) ? data.info.backdrop_path[0] : undefined;
        return {
            id: s.id,
            type: 'series',
            name: s.name,
            poster: this._posterOrPlaceholder(s.poster, s.name),
            posterShape: 'poster',
            background: backdrop || s.poster,
            description: s.plot || data?.info?.plot || '',
            releaseInfo: s.year || undefined,
            imdbRating: s.rating || data?.info?.rating || undefined,
            genres: s.category ? [s.category] : (s.genre ? [s.genre] : undefined),
            cast: s.cast ? String(s.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined,
            director: s.director || undefined,
            videos,
        };
    }

    getMovieStreams(id: string) {
        const m = this.movieMap.get(id);
        if (!m) return [];
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${m.streamId}.${m.ext || 'mp4'}`;
        // No notWebReady: let the native player (desktop libmpv / Fire TV ExoPlayer) play
        // the file directly so AC3/E-AC3 (Dolby) audio is decoded natively. Routing VOD
        // through Stremio's streaming server tends to drop AC3 audio.
        return [{
            url,
            title: `${m.name}${m.year ? ` (${m.year})` : ''}`,
            behaviorHints: { bingeGroup: `nexotv-vod-${this.idPrefix}` },
        }];
    }

    getEpisodeStreams(id: string) {
        const prefix = `epi${this.idPrefix}_`;
        const rest = id.slice(prefix.length);
        const sep = rest.lastIndexOf('__');
        const episodeId = sep >= 0 ? rest.slice(0, sep) : rest;
        const ext = sep >= 0 ? rest.slice(sep + 2) : 'mp4';
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${episodeId}.${ext}`;
        // No notWebReady: native player handles direct playback + AC3/Dolby audio.
        return [{
            url,
            title: 'Assistir',
            behaviorHints: { bingeGroup: `nexotv-series-${this.idPrefix}` },
        }];
    }

    async getStreams(id: string) {
        await this.ensureDataLoaded();
        if (id.startsWith('tt')) {
            const parts = id.split(':');
            if (parts.length >= 3) {
                return this.getSeriesStreamsByImdb(parts[0], parseInt(parts[1], 10), parseInt(parts[2], 10));
            }
            return this.getMovieStreamsByImdb(parts[0]);
        }
        if (id.startsWith(`vod${this.idPrefix}_`)) return this.getMovieStreams(id);
        if (id.startsWith(`epi${this.idPrefix}_`)) return this.getEpisodeStreams(id);
        const item = this.channelMap.get(id);
        if (!item) return [];

        const reqHeaders: Record<string, string> = {};
        if (item.userAgent) reqHeaders['User-Agent'] = item.userAgent;
        if (item.referrer)  reqHeaders['Referer']    = item.referrer;
        const behaviorHints = Object.keys(reqHeaders).length
            ? { notWebReady: true, proxyHeaders: { request: reqHeaders } }
            : { notWebReady: true };

        if (item.urls && item.urls.length > 0) {
            return item.urls.map((url: string, index: number) => ({
                url,
                title: item.urls.length > 1 ? `${item.name} - Link ${index + 1}` : `${item.name} - Live`,
                behaviorHints,
            }));
        }

        const streams = [{ url: item.url, title: `${item.name} - Live`, behaviorHints }];

        const xtreamRe = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(\d+)$/;
        if (xtreamRe.test(item.url)) {
            streams.unshift({
                url: item.url + '.m3u8',
                title: `${item.name} - HLS`,
                behaviorHints,
            });
        }

        return streams;
    }

    async getDetailedMeta(id: string) {
        // IMDB ids are owned by Cinemeta — don't provide meta, only streams.
        if (id.startsWith('tt')) return null;
        await this.ensureDataLoaded();
        if (id.startsWith(`vod${this.idPrefix}_`)) return this.getMovieMeta(id);
        if (id.startsWith(`ser${this.idPrefix}_`)) return this.getSeriesMeta(id);
        await this.ensureEpgLoaded();
        const item = this.channelMap.get(id);
        if (!item) return null;
        const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = getCurrentProgram(this.epgData, epgId, this.config.epgOffsetHours as number);
        const upcoming = getUpcomingPrograms(this.epgData, epgId, 3, this.config.epgOffsetHours as number);
        let description = `📺 CHANNEL: ${item.name}`;
        if (current) {
            const start = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
            const end = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
            description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
            if (current.description) description += `\n\n${current.description}`;
        }
        if (upcoming.length) {
            description += '\n\n📅 UPCOMING:\n';
            for (const p of upcoming) {
                description += `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}\n`;
            }
        }
        const logoUrl = this.deriveFallbackLogoUrl(item);
        return {
            id: item.id,
            type: 'tv',
            name: item.name,
            poster: logoUrl,
            background: logoUrl,
            posterShape: 'poster',
            description,
            genres: item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live'
        };
    }

    _resetEvictTimer() {
        // Without a persistent backend (nodejs-mobile APK), RAM is the source of
        // truth — never schedule eviction or the data would be lost permanently.
        if (!sqliteCache.isAvailable()) return;
        clearTimeout(this._evictTimer);
        this._evictTimer = setTimeout(() => this._evictFromMemory(), env.DATA_MEMORY_TTL_MS);
    }

    private _startUpdateTimer() {
        if (this._updateTimer !== null) return; // already running — guard against double-start
        this._updateTimer = setInterval(() => {
            // Skip if circuit is open
            if (this._timerPausedUntil !== null && Date.now() < this._timerPausedUntil) return;

            this.updateData().then(() => {
                this._timerConsecutiveFailures = 0;
                this._timerPausedUntil = null;
            }).catch((e: any) => {
                this._timerConsecutiveFailures++;
                if (this._timerConsecutiveFailures >= 3) {
                    this._timerPausedUntil = Date.now() + 30 * 60_000; // pause 30 min
                    this.log.warn(`[TIMER] Circuit open after ${this._timerConsecutiveFailures} failures, pausing 30 min`);
                }
                this.log.error('[TIMER] Background update failed:', e.message);
            });
        }, env.UPDATE_INTERVAL_MS);
        // unref: don't prevent Node.js process exit if this is the only active handle
        if (typeof (this._updateTimer as any).unref === 'function') {
            (this._updateTimer as any).unref();
        }
    }

    _evictFromMemory() {
        clearTimeout(this._evictTimer);
        clearInterval(this._updateTimer);   // kill update timer
        this._updateTimer = null;           // allow GC and re-start check
        this._evictTimer = null;
        this.channels = [];
        this.channelMap = new Map();
        this.movies = [];
        this.movieMap = new Map();
        this.series = [];
        this.seriesMap = new Map();
        this.epgData = {};
        this.log.debug('Data evicted from RAM', { cacheKey: this.cacheKey });
    }

    async ensureDataLoaded() {
        if (this.channels.length > 0) {
            this._resetEvictTimer();
            return;
        }
        if (!CACHE_ENABLED) return;
        if (this._loadPromise) {
            await this._loadPromise;
            return;
        }
        this._loadPromise = this.loadChannelsFromCache().finally(() => { this._loadPromise = null; });
        await this._loadPromise;
        this._resetEvictTimer();
        this._startUpdateTimer();    // start/resume background updates
    }

    async getChannelsForCatalog() {
        await this.ensureDataLoaded();
        return this.channels;
    }
}

export { CACHE_ENABLED };
