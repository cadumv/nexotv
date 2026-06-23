import crypto from 'crypto';
import LRUCache from '../utils/lruCache';
import * as sqliteCache from '../utils/sqliteCache';
import { makeLogger } from '../utils/logger';
import { parseEPG, getCurrentProgram, getUpcomingPrograms } from '../parsers/epgParser';
import env from '../config/env';
import * as xtreamProvider from '../providers/xtreamProvider';
import * as iptvOrgProvider from '../providers/iptvOrgProvider';
import * as m3uProvider from '../providers/m3uProvider';
import { normalizeTitle, resolveImdbTitle, resolveTmdbTitles, fetchTmdbMeta } from '../utils/titleMatch';
import { fetchSofascoreAgenda } from '../utils/sofascoreAgenda';

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
        // Compute the id namespace BEFORE forcing any feature flags, so the
        // idPrefix stays stable (= the value users' saved Library / Continue-
        // Watching items already reference). Forcing enableEpg first would shift
        // the hash and orphan those items ("no information found about this").
        this.cacheKey = createCacheKey(config);
        this.idPrefix = this.cacheKey.slice(0, 8);
        // Now force EPG on (powers the "Futebol Ao Vivo" catalog + programming).
        this.config.enableEpg = true;
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

        // Always normalize channel logos (wsrv, fit=contain → square, letterboxed)
        // so non-square logos don't get stretched/distorted in the square tile.
        this.config.reformatLogos = true;

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
        // nodejs-mobile ships without full ICU, so String.normalize('NFD') is a
        // no-op there (accents are NOT decomposed) and the old NFD+combining-mark
        // approach silently left accents in — which Stremio Android then renders
        // as "�". Use an explicit map so it works regardless of ICU.
        if (!s) return s;
        const MAP: Record<string, string> = {
            'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
            'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
            'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
            'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
            'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
            'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
            'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
            'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
            'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
            'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
            'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
            'Ç': 'C', 'Ñ': 'N',
        };
        let out = '';
        for (const ch of s) out += (MAP[ch] !== undefined ? MAP[ch] : ch);
        return out;
    }

    // Expose every provider category as its own Stremio catalog (one row each),
    // in addition to the three base catalogs. Idempotent: strips previously-added
    // category catalogs before re-appending so repeated builds don't duplicate.
    _appendCategoryCatalogs() {
        if (!this.manifestRef) return;
        const BASE = new Set(['nexotv_games', 'iptv_channels', 'nexotv_vod', 'nexotv_series']);
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
            finalUrl = `https://placehold.co/320x320/2b2b2b/FFFFFF.png?text=${encodeURIComponent(item.name || 'TV')}`;
        }

        if (this.config.reformatLogos && finalUrl.startsWith('http') && !finalUrl.includes('wsrv.nl') && !finalUrl.includes('placehold.co')) {
            if (finalUrl.includes('imgur.com')) {
                finalUrl = `https://proxy.duckduckgo.com/iu/?u=${encodeURIComponent(finalUrl)}`;
            }
            return `https://wsrv.nl/?url=${encodeURIComponent(finalUrl)}&w=320&h=320&fit=contain&we&bg=2b2b2b`;
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
            posterShape: 'square',
            genres: item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live'
        };
    }

    // ---------- ⚽ Próximos Jogos (futebol, via EPG) ----------

    // Title looks like a football match ("Time A x Time B"), excluding other sports.
    _isFootballMatch(title: string) {
        if (!title) return false;
        const t = title.toLowerCase().trim();
        if (!/ x /.test(t)) return false; // "Time x Time"
        // Replays / reruns / highlights — not upcoming games.
        if (/^vt\s*-?\s/.test(t)) return false;
        const REPLAY = ['reprise', 'compacto', 'melhores momentos', 'best of', '(r)', 'replay', 'gols de', 'resenha'];
        for (const r of REPLAY) if (t.includes(r)) return false;
        // Other sports.
        const EXCLUDE = [
            'mlb', 'nba', 'nfl', 'nhl', 'ufc', 'boxe', 'boxing', 'luta', 'mma', 'knockout',
            'tênis', 'tenis', 'tennis', 'vôlei', 'volei', 'basquete', 'f1', 'fórmula',
            'formula', 'nascar', 'beisebol', 'hóquei', 'hoquei', 'wwe', 'golfe', 'atletismo',
            'e-sports', 'esports', 'league of legends', 'valorant', 'counter'
        ];
        for (const e of EXCLUDE) if (t.includes(e)) return false;
        return true;
    }

    // Only count matches on channels that actually carry football, to avoid false
    // positives like "Spy x Family" (anime) or "Século X X I" (show).
    _isSportsChannel(ch: any) {
        const s = ((ch.name || '') + ' ' + (ch.category || '') + ' ' + (ch.attributes?.['group-title'] || '')).toLowerCase();
        const KW = ['esporte', 'sport', 'espn', 'sportv', 'premiere', 'dazn', 'combate',
            'goat', 'caze', 'cazé', 'futebol', 'eurosport', 'tnt', 'fox sport', 'nsports',
            'globo', 'record', 'sbt', 'band', 'rede tv', 'cnt', 'tv brasil', 'desimpedido'];
        return KW.some(k => s.includes(k));
    }

    // Rank a channel by broadcast quality (from its name), so the best variant
    // (4K/FHD) is offered first and used for the tile.
    _channelQualityRank(ch: any) {
        const n = (ch?.name || '').toUpperCase();
        if (/\b(4K|UHD)\b/.test(n)) return 4;
        if (/\bFHD\b/.test(n)) return 3;
        if (/\bHD\b/.test(n)) return 2;
        if (/\bSD\b/.test(n)) return 1;
        return 0;
    }

    // Major broadcasters, in display priority order. Used to (a) collapse the
    // dozens of regional affiliates that carry the same national feed (every
    // "GLOBO TV <city>" → one "GLOBO") and (b) order the broadcasters sensibly.
    static GAME_BROADCASTERS = [
        'SPORTV', 'PREMIERE', 'PREMIER', 'ESPN', 'TNT SPORTS', 'TNT', 'SPACE', 'DAZN',
        'CAZE', 'CAZÉ', 'NSPORTS', 'N SPORTS', 'EUROSPORT', 'GOAT', 'DISNEY', 'STAR',
        'PARAMOUNT', 'GLOBO', 'SBT', 'RECORD', 'BAND', 'REDE TV', 'CNT', 'TV BRASIL',
    ];

    _gameStationKey(name: string) {
        const clean = (name || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
        for (const b of M3UEPGAddon.GAME_BROADCASTERS) if (clean.includes(b)) return b;
        return clean;
    }

    // Collapse a match's channel list down to one entry per broadcaster per
    // quality tier (so regional affiliates don't flood the list with 100+
    // identical streams), ordered by broadcaster priority then quality.
    _dedupGameChannels(channels: any[], cap = 15) {
        const byStation = new Map<string, any[]>();
        for (const c of channels) {
            const k = this._gameStationKey(c.name || '');
            if (!byStation.has(k)) byStation.set(k, []);
            byStation.get(k)!.push(c);
        }
        const pickedPerStation: { key: string; chans: any[] }[] = [];
        for (const [key, list] of byStation) {
            list.sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a));
            const seenTier = new Set<number>();
            const chans: any[] = [];
            for (const c of list) {
                const tier = this._channelQualityRank(c);
                if (seenTier.has(tier)) continue;   // one channel per quality tier
                seenTier.add(tier);
                chans.push(c);
            }
            pickedPerStation.push({ key, chans });
        }
        // Order: known broadcasters by priority, then the rest alphabetically.
        const prio = (k: string) => {
            const i = M3UEPGAddon.GAME_BROADCASTERS.indexOf(k);
            return i === -1 ? 999 : i;
        };
        pickedPerStation.sort((a, b) => prio(a.key) - prio(b.key) || a.key.localeCompare(b.key));
        const out: any[] = [];
        for (const s of pickedPerStation) {
            for (const c of s.chans) { out.push(c); if (out.length >= cap) return out; }
        }
        return out;
    }

    // Compact a string to lowercase alphanumerics (accent-free) for fuzzy
    // substring matching of team names against channel names.
    static _compact(s: string) {
        return M3UEPGAddon.stripAccents(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    // Extract the two teams from a "Team A x Team B" title, compacted.
    _teamsFromTitle(title: string): { a: string; b: string } | null {
        const t = (title || '').replace(/\s*-?\s*ao vivo/i, '').trim();
        const parts = t.split(/\s+x\s+/i);
        if (parts.length < 2) return null;
        const a = M3UEPGAddon._compact(parts[0]);
        const b = M3UEPGAddon._compact(parts[parts.length - 1]);
        if (a.length < 3 || b.length < 3) return null;
        return { a, b };
    }

    _channelNameIsReplay(name: string) {
        const t = (name || '').toLowerCase();
        return /^vt\b|reprise|replay|compacto|melhores momentos|\(r\)|gols de/.test(t);
    }

    // Base name of an IPTV channel: accent-free, lowercased, without [quality] tags
    // and bare quality words — for matching against Sofascore channel names.
    _iptvBase(name: string) {
        return M3UEPGAddon.stripAccents(name || '').toLowerCase()
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\b(fhd|hd|sd|4k|uhd|h265|h264)\b/g, ' ')
            .replace(/\s+/g, ' ').trim();
    }

    // Map a Sofascore channel display name (e.g. "Premiere 2", "TV Globo", "DAZN")
    // to the user's matching IPTV channels — one per quality tier (best first).
    _matchSofaToIptv(sofaName: string, baseList: { c: any; base: string }[]) {
        const want = this._iptvBase(sofaName);
        let cands: { c: any; base: string }[];
        if (want.includes('globo')) cands = baseList.filter(x => x.base.includes('globo'));
        else if (want === 'dazn') cands = baseList.filter(x => x.base === 'dazn' || x.base.startsWith('dazn '));
        else if (want === 'premiere') cands = baseList.filter(x => x.base === 'premiere' || x.base.startsWith('premiere clube'));
        else if (want === 'sbt' || want === '+sbt') cands = baseList.filter(x => x.base === 'sbt' || x.base.startsWith('sbt '));
        else if (want.includes('paramount')) cands = baseList.filter(x => x.base.includes('paramount'));
        // Disney+ only — NOT "Desenhos Disney" and other Disney-branded channels.
        else if (want.includes('disney')) cands = baseList.filter(x => x.base.includes('disney plus') || x.base.includes('disney+'));
        else if (want.includes('caze')) cands = baseList.filter(x => x.base.includes('caze'));
        else cands = baseList.filter(x => x.base === want);
        const seen = new Set<number>();
        const out: any[] = [];
        for (const x of cands.sort((a, b) => this._channelQualityRank(b.c) - this._channelQualityRank(a.c))) {
            const t = this._channelQualityRank(x.c);
            if (seen.has(t)) continue;
            seen.add(t);
            out.push(x.c);
        }
        return out;
    }

    // Sofascore uses English national-team names; show them in pt-BR. Club names
    // already come localized, so anything not in the dict passes through.
    static _TEAM_PT: Record<string, string> = {
        'brazil': 'Brasil', 'norway': 'Noruega', 'senegal': 'Senegal', 'england': 'Inglaterra',
        'ghana': 'Gana', 'scotland': 'Escocia', 'czechia': 'Tchequia', 'czech republic': 'Tchequia',
        'mexico': 'Mexico', 'jordan': 'Jordania', 'algeria': 'Argelia', 'france': 'Franca',
        'iraq': 'Iraque', 'argentina': 'Argentina', 'austria': 'Austria', 'portugal': 'Portugal',
        'uzbekistan': 'Uzbequistao', 'colombia': 'Colombia', 'switzerland': 'Suica', 'canada': 'Canada',
        'spain': 'Espanha', 'germany': 'Alemanha', 'italy': 'Italia', 'netherlands': 'Holanda',
        'belgium': 'Belgica', 'croatia': 'Croacia', 'uruguay': 'Uruguai', 'ukraine': 'Ucrania',
        'united states': 'Estados Unidos', 'usa': 'Estados Unidos', 'south korea': 'Coreia do Sul',
        'japan': 'Japao', 'morocco': 'Marrocos', 'denmark': 'Dinamarca', 'poland': 'Polonia',
        'bulgaria': 'Bulgaria', 'congo dr': 'RD Congo', 'dr congo': 'RD Congo',
        'south africa': 'Africa do Sul', 'sweden': 'Suecia', 'turkey': 'Turquia', 'turkiye': 'Turquia',
        'qatar': 'Catar', 'haiti': 'Haiti', 'panama': 'Panama', 'ivory coast': 'Costa do Marfim',
        'curacao': 'Curacao', 'bosnia & herzegovina': 'Bosnia e Herzegovina', 'bosnia and herzegovina': 'Bosnia e Herzegovina',
        'wales': 'Pais de Gales', 'ireland': 'Irlanda', 'greece': 'Grecia',
        'serbia': 'Servia', 'hungary': 'Hungria', 'finland': 'Finlandia',
        'paraguay': 'Paraguai', 'ecuador': 'Equador', 'peru': 'Peru', 'chile': 'Chile', 'bolivia': 'Bolivia',
        'saudi arabia': 'Arabia Saudita', 'egypt': 'Egito', 'nigeria': 'Nigeria', 'cameroon': 'Camaroes',
        'australia': 'Australia', 'new zealand': 'Nova Zelandia', 'costa rica': 'Costa Rica', 'honduras': 'Honduras',
    };
    _translateTeam(name: string) {
        const k = M3UEPGAddon.stripAccents(name || '').toLowerCase().trim();
        return M3UEPGAddon._TEAM_PT[k] || name;
    }

    // Build game entries from the Sofascore agenda, mapping each match's BR
    // broadcasters to the user's IPTV channels. Games with no channel the user
    // actually has are dropped (can't be watched).
    async _buildSofaGames(allowNetwork: boolean) {
        const agenda = await fetchSofascoreAgenda(allowNetwork);
        if (!agenda.length) return [];
        const baseList = (this.channels || []).map(c => ({ c, base: this._iptvBase(c.name) }));
        const out: any[] = [];
        for (const ag of agenda) {
            const chMap = new Map<string, any>();
            for (const sofaName of ag.channels) {
                for (const c of this._matchSofaToIptv(sofaName, baseList)) chMap.set(c.id, c);
            }
            if (!chMap.size) continue;
            const channels = [...chMap.values()]
                .sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a))
                .slice(0, 15);
            const title = `${this._translateTeam(ag.home)} x ${this._translateTeam(ag.away)}`;
            out.push({ title, start: ag.startMs, stop: ag.stopMs, channels, _sofa: true });
        }
        return out;
    }

    async getGamesForCatalog() {
        await this.ensureDataLoaded();
        await this.ensureEpgLoaded();
        if (!this.epgData || Object.keys(this.epgData).length === 0) return [];

        // One EPG id (tvg-id) is usually shared by several physical channels —
        // the SD, HD and FHD variants of the same station. Map each EPG id to ALL
        // of them so a match can offer every quality, not just the first one.
        const chByEpg = new Map<string, any[]>();
        for (const c of this.channels) {
            const epgId = c.attributes?.['tvg-id'] || c.epg_channel_id;
            if (!epgId) continue;
            if (!chByEpg.has(epgId)) chByEpg.set(epgId, []);
            chByEpg.get(epgId)!.push(c);
        }

        const now = Date.now();
        const minStart = now - 2 * 3600 * 1000;          // jogos em andamento (até 2h atrás)
        const horizon = now + 5 * 24 * 3600 * 1000;      // hoje + ~5 dias
        // Group the same match (across SD/HD/FHD channels AND across stations) into
        // a single entry that carries every channel that broadcasts it.
        const groups = new Map<string, { title: string; start: number; stop: number; chans: Map<string, any> }>();
        for (const [epgId, progs] of Object.entries(this.epgData)) {
            const chans = (chByEpg.get(epgId) || []).filter(c => this._isSportsChannel(c));
            if (chans.length === 0) continue;
            for (const p of (progs as any[])) {
                if (!p || p.start < minStart || p.start > horizon) continue;
                const title = (p.title || '').trim();
                if (!this._isFootballMatch(title)) continue;
                const norm = title.toLowerCase().replace(/\s*-?\s*ao vivo/i, '').replace(/\s+/g, ' ').trim();
                const d = new Date(p.start);
                const key = `${norm}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                if (!groups.has(key)) groups.set(key, { title, start: p.start, stop: p.stop || 0, chans: new Map() });
                const g = groups.get(key)!;
                if (p.start < g.start) g.start = p.start;
                if ((p.stop || 0) > g.stop) g.stop = p.stop || 0;
                for (const c of chans) if (!g.chans.has(c.id)) g.chans.set(c.id, c);
            }
        }
        // Augment each match with channels whose NAME contains both teams (event/
        // PPV channels named after the match), even when their EPG doesn't list it.
        // This is how we pick up providers the guide misses. Precompute compacted
        // names once; require BOTH team names present to avoid false positives.
        const allChans = (this.channels || []).map(c => ({ c, n: M3UEPGAddon._compact(c.name) }));
        for (const g of groups.values()) {
            const teams = this._teamsFromTitle(g.title);
            if (!teams) continue;
            for (const x of allChans) {
                if (!x.n.includes(teams.a) || !x.n.includes(teams.b)) continue;
                if (this._channelNameIsReplay(x.c.name)) continue;
                if (!g.chans.has(x.c.id)) g.chans.set(x.c.id, x.c);
            }
        }

        const epgOut: any[] = [];
        for (const g of groups.values()) {
            const channels = this._dedupGameChannels([...g.chans.values()]);
            epgOut.push({ title: g.title, start: g.start, stop: g.stop, channels });
        }

        // Sofascore agenda fills the EPG's blind spots (Premiere/DAZN games it omits)
        // and gives the EXACT broadcaster. To save the free-tier quota, only spend a
        // request when a match is live or starts within SOFASCORE_PREFETCH_MIN — judged
        // from the (free) EPG. Idle periods => allowNetwork=false => zero requests.
        const prefetchMs = (env.SOFASCORE_PREFETCH_MIN as number) * 60000;
        const allowNetwork = epgOut.some(g =>
            now >= (g.start - prefetchMs) && now <= (g.stop || g.start + 2.5 * 3600 * 1000));
        let merged = epgOut;
        try {
            // Sofascore is the better source when available: it already lists every
            // BR broadcaster per game (incl. the Premiere/DAZN/Caze the EPG misses),
            // with consistent names and no false positives (e.g. basketball). So when
            // we have it, use it as the SOLE source — avoids the EPG-vs-Sofascore name
            // mismatch duplicates ("America-MG" vs "America Mineiro"). EPG stays the
            // fallback for idle windows / no key / quota exhausted.
            const sofaGames = await this._buildSofaGames(allowNetwork);
            if (sofaGames.length) merged = sofaGames;
        } catch (e: any) {
            this.log.warn?.('[GAMES] Sofascore agenda failed', e?.message);
        }

        // Live matches first (most useful right now), then by kickoff time.
        merged.sort((a, b) => (this._isGameLive(b, now) ? 1 : 0) - (this._isGameLive(a, now) ? 1 : 0) || a.start - b.start);
        return merged;
    }

    // A game tile must have a UNIQUE id (several games air on the same channel —
    // reusing the channel id makes Stremio dedup them down to one tile and the
    // meta page shows the channel, not the match). We encode the match details
    // into a self-contained id so meta/stream can resolve back without state.
    // A match counts as live now if we're between its start and stop. When the
    // guide has no stop, assume a ~2.5h window from kickoff.
    _isGameLive(g: { start: number; stop?: number }, now = Date.now()) {
        if (!g || !g.start) return false;
        const end = g.stop && g.stop > g.start ? g.stop : g.start + 2.5 * 3600 * 1000;
        return now >= g.start && now <= end;
    }

    // The tile image shows the MATCH (team names + status) instead of a provider
    // logo, so every game looks distinct. placehold.co renders the text server-
    // side, so accents are safe here (it's a rasterized image, not Stremio text).
    // Live games get a red banner; upcoming ones a dark-green pitch tone.
    _gameTileImage(matchName: string, statusLine: string, live: boolean) {
        const bg = live ? 'b3261e' : '14532d';
        const text = encodeURIComponent(`${matchName}\n${statusLine}`);
        return `https://placehold.co/640x360/${bg}/FFFFFF.png?text=${text}&font=oswald`;
    }

    _encodeGameId(g: any) {
        const payload = JSON.stringify({ cs: (g.channels || []).map((c: any) => c.id), s: g.start, e: g.stop || 0, n: g.title });
        const b64 = Buffer.from(payload, 'utf8').toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `game${this.idPrefix}_${b64}`;
    }

    _decodeGameId(id: string): { cs: string[]; s: number; e?: number; n: string } | null {
        try {
            const b64 = id.slice(`game${this.idPrefix}_`.length).replace(/-/g, '+').replace(/_/g, '/');
            const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            // Back-compat with the earlier single-channel encoding ({ c }).
            if (o && !o.cs && o.c) o.cs = [o.c];
            return o;
        } catch { return null; }
    }

    // A square channel logo stretched into a landscape tile looks awful, so build
    // a 16:9 image with the logo contained on a dark background (no distortion).
    _gameLandscapeImage(channel: any, matchName: string) {
        const raw = channel.attributes?.['tvg-logo'] || channel.logo || '';
        if (raw && raw.startsWith('http')) {
            let u = raw;
            if (u.includes('imgur.com')) u = `https://proxy.duckduckgo.com/iu/?u=${encodeURIComponent(u)}`;
            return `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=640&h=360&fit=contain&we&bg=0b0b0b`;
        }
        return `https://placehold.co/640x360/0b0b0b/FFFFFF.png?text=${encodeURIComponent(matchName)}`;
    }

    _gameDayLabel(d: Date) {
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 86400000);
        if (d.toDateString() === now.toDateString()) return 'Hoje';
        if (d.toDateString() === tomorrow.toDateString()) return 'Amanha';
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    generateGamePreview(g: any) {
        const d = new Date(g.start);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const dayLabel = this._gameDayLabel(d);
        const primary = (g.channels && g.channels[0]) || {};
        const matchName = g.title.replace(/\s*-?\s*ao vivo/i, '').trim();
        const live = this._isGameLive(g);
        // The image keeps accents (rendered server-side); the time line on it.
        const img = this._gameTileImage(matchName, live ? 'AO VIVO AGORA' : `${dayLabel} ${hh}:${mm}`, live);
        const n = (g.channels || []).length;
        const opts = n > 1 ? `${n} transmissoes` : M3UEPGAddon.stripAccents(primary.name || '');
        const safeMatch = M3UEPGAddon.stripAccents(matchName);
        const when = live ? 'AO VIVO' : `${dayLabel} ${hh}:${mm}`;
        return {
            id: this._encodeGameId(g),
            type: 'tv',
            // Signal live in the title too, so it stands out in the grid.
            name: live ? `[AO VIVO] ${safeMatch}` : safeMatch,
            poster: img,
            background: img,
            posterShape: 'landscape',
            // No emoji/non-ASCII: Stremio Android mis-renders multibyte UTF-8.
            description: `${when} - ${opts}`,
            // releaseInfo renders as the subtitle line under the tile in the grid,
            // so the status/options show *before* opening the match.
            releaseInfo: `${when} - ${opts}`,
            genres: [M3UEPGAddon.stripAccents(primary.name || '')].filter(Boolean)
        };
    }

    // Build the detail (meta) page for a game tile, resolving all its channels.
    _getGameMeta(id: string) {
        const info = this._decodeGameId(id);
        if (!info) return null;
        const channels = (info.cs || []).map(cid => this.channelMap.get(cid)).filter(Boolean);
        const d = new Date(info.s);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const dayLabel = this._gameDayLabel(d);
        const rawMatch = info.n.replace(/\s*-?\s*ao vivo/i, '').trim();
        const matchName = M3UEPGAddon.stripAccents(rawMatch);
        const live = this._isGameLive({ start: info.s, stop: info.e });
        const img = this._gameTileImage(rawMatch, live ? 'AO VIVO AGORA' : `${dayLabel} ${hh}:${mm}`, live);
        const chList = channels.length
            ? channels.map((c: any) => `- ${M3UEPGAddon.stripAccents(c.name)}`).join('\n')
            : '- (canal indisponivel)';
        const statusLine = live ? '*** AO VIVO AGORA ***' : `${dayLabel} as ${hh}:${mm}`;
        return {
            id,
            type: 'tv',
            name: live ? `[AO VIVO] ${matchName}` : matchName,
            poster: img,
            background: img,
            posterShape: 'landscape',
            releaseInfo: live ? 'AO VIVO' : `${dayLabel} ${hh}:${mm}`,
            description: `${matchName}\n\n${statusLine}\n\nTransmissoes (escolha a qualidade ao assistir):\n${chList}`,
            genres: channels.map((c: any) => M3UEPGAddon.stripAccents(c.name)).filter(Boolean)
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
            // Shown in the focused-item preview pane before opening the detail page.
            description: (m.plot && String(m.plot).trim()) || undefined,
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
            // Series lists from Xtream usually include a plot — show it on focus.
            description: (s.plot && String(s.plot).trim()) || undefined,
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
        let cast = info?.cast ? String(info.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;
        const backdrop = Array.isArray(info?.backdrop_path) ? info.backdrop_path[0] : undefined;
        let description = info?.plot || info?.description || '';

        // Enrich from TMDB (pt-BR) — fills the many titles the provider leaves blank.
        let tmdb: any = null;
        try { tmdb = await fetchTmdbMeta(env.TMDB_API_KEY, m.name, m.year, 'movie'); } catch { /* ignore */ }
        if (tmdb) {
            if (!description) description = tmdb.overview || '';
            if (!cast || !cast.length) cast = tmdb.cast && tmdb.cast.length ? tmdb.cast : cast;
        }

        const poster = this._posterOrPlaceholder(m.poster || tmdb?.poster, m.name);
        const links = tmdb?.imdb ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${tmdb.imdb}` }] : undefined;
        return {
            id: m.id,
            type: 'movie',
            name: m.name,
            poster,
            posterShape: 'poster',
            background: backdrop || tmdb?.background || m.poster || tmdb?.poster,
            description,
            releaseInfo: m.year || info?.releasedate || tmdb?.year || undefined,
            imdbRating: m.rating || info?.rating || tmdb?.rating || undefined,
            genres: m.category ? [m.category] : (info?.genre ? [info.genre] : (tmdb?.genres?.length ? tmdb.genres : undefined)),
            runtime: info?.duration || tmdb?.runtime || undefined,
            cast,
            director: info?.director || undefined,
            links,
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
        let description = s.plot || data?.info?.plot || '';
        let cast = s.cast ? String(s.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;

        // Enrich from TMDB (pt-BR) for series missing description/IMDB from the provider.
        let tmdb: any = null;
        try { tmdb = await fetchTmdbMeta(env.TMDB_API_KEY, s.name, s.year, 'tv'); } catch { /* ignore */ }
        if (tmdb) {
            if (!description) description = tmdb.overview || '';
            if (!cast || !cast.length) cast = tmdb.cast && tmdb.cast.length ? tmdb.cast : cast;
        }
        const links = tmdb?.imdb ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${tmdb.imdb}` }] : undefined;
        return {
            id: s.id,
            type: 'series',
            name: s.name,
            poster: this._posterOrPlaceholder(s.poster || tmdb?.poster, s.name),
            posterShape: 'poster',
            background: backdrop || tmdb?.background || s.poster,
            description,
            releaseInfo: s.year || tmdb?.year || undefined,
            imdbRating: s.rating || data?.info?.rating || tmdb?.rating || undefined,
            genres: s.category ? [s.category] : (s.genre ? [s.genre] : (tmdb?.genres?.length ? tmdb.genres : undefined)),
            cast,
            director: s.director || undefined,
            links,
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
        if (id.startsWith(`game${this.idPrefix}_`)) {
            const info = this._decodeGameId(id);
            if (!info?.cs?.length) return [];
            // Offer every channel that carries the match (FHD/HD/SD) as a stream,
            // best quality first (ids were encoded already sorted by quality).
            const all: any[] = [];
            for (const cid of info.cs) {
                const ss = await this.getStreams(cid);
                for (const s of ss) all.push(s);
            }
            return all;
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
        if (id.startsWith(`game${this.idPrefix}_`)) { await this.ensureEpgLoaded(); return this._getGameMeta(id); }
        if (id.startsWith(`vod${this.idPrefix}_`)) return this.getMovieMeta(id);
        if (id.startsWith(`ser${this.idPrefix}_`)) return this.getSeriesMeta(id);
        await this.ensureEpgLoaded();
        const item = this.channelMap.get(id);
        if (!item) return null;
        const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = getCurrentProgram(this.epgData, epgId, this.config.epgOffsetHours as number);
        const upcoming = getUpcomingPrograms(this.epgData, epgId, 3, this.config.epgOffsetHours as number);
        // nodejs-mobile lacks full ICU, so toLocaleTimeString is unreliable — format manually.
        const hhmm = (dt: any) => dt ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : '';
        const sa = M3UEPGAddon.stripAccents;
        // No emoji / non-ASCII: Stremio Android mis-renders multibyte UTF-8.
        let description = sa(item.name);
        if (current) {
            const start = hhmm(current.startTime);
            const end = hhmm(current.stopTime);
            description += `\n\nAGORA: ${sa(current.title)}${start && end ? ` (${start}-${end})` : ''}`;
            if (current.description) description += `\n\n${sa(current.description)}`;
        }
        if (upcoming.length) {
            description += '\n\nA SEGUIR:\n';
            for (const p of upcoming) {
                description += `${hhmm(p.startTime)} - ${sa(p.title)}\n`;
            }
        }
        const logoUrl = this.deriveFallbackLogoUrl(item);
        return {
            id: item.id,
            type: 'tv',
            name: item.name,
            poster: logoUrl,
            background: logoUrl,
            posterShape: 'square',
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
