import env from '../config/env';
import { addonBuilder } from 'stremio-addon-sdk';
import crypto from 'crypto';
import { createManifest } from './manifest';
import { M3UEPGAddon, createCacheKey, buildPromiseCache, CACHE_ENABLED } from './M3UEPGAddon';
import * as sqliteCache from '../utils/sqliteCache';
import { AddonConfig } from './M3UEPGAddon';

async function createAddon(config: AddonConfig) {
    config.instanceId = config.instanceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));

    // Compute the cacheKey/idPrefix from the ORIGINAL config (no forced flags),
    // matching what M3UEPGAddon does. This keeps the idPrefix stable so the
    // manifest's idPrefixes, the catalog/meta/stream ids, AND users' previously
    // saved items all agree. (The instance forces enableEpg=true afterwards.)
    const cacheKey = createCacheKey(config);
    const idPrefix = cacheKey.slice(0, 8);
    const manifest = createManifest(idPrefix, config.catalogName);
    const debugFlag = !!env.DEBUG;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { cacheKey, provider: config.provider || 'xtream' });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing build promise', cacheKey);
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadChannelsFromCache();
        try {
            if (!addonInstance.lastUpdate || (Date.now() - addonInstance.lastUpdate > addonInstance.updateInterval)) {
                await addonInstance.updateData(true);
            }
        } catch (e: any) {
            console.error('[ADDON] Initial update failed:', e.message);
        }
        addonInstance.buildGenresInManifest();
        // Only evict if a persistent backend exists to reload from. Without SQLite
        // (nodejs-mobile APK), RAM is the source of truth — evicting would lose data.
        if (CACHE_ENABLED && sqliteCache.isAvailable()) addonInstance._evictFromMemory();

        let iface: any;
        const _origBuildGenres = addonInstance.buildGenresInManifest.bind(addonInstance);
        addonInstance.buildGenresInManifest = () => {
            _origBuildGenres();
            if (iface) iface._cleanManifest = null;
        };

        builder.defineCatalogHandler(async (args) => {
            const start = Date.now();
            try {
                await addonInstance.refreshOnFirstCatalogRequest();
                const extra = args.extra || {};

                // A per-category catalog has id "<base>_g_<base64url(category)>".
                // Resolve it back to its base catalog + the category to filter by.
                let baseId = args.id;
                let categoryFilter: string | null = null;
                for (const base of ['nexotv_vod', 'nexotv_series', 'iptv_channels', 'iptv_org']) {
                    const pfx = base + '_g_';
                    if (args.id.startsWith(pfx)) {
                        baseId = base;
                        try { categoryFilter = M3UEPGAddon.decodeCategory(args.id.slice(pfx.length)); } catch { categoryFilter = null; }
                        break;
                    }
                }

                let items: any[] = [];
                let toMeta: (i: any) => any;
                if (args.type === 'tv' && args.id === 'nexotv_games') {
                    items = await addonInstance.getGamesForCatalog();
                    toMeta = (i: any) => addonInstance.generateGamePreview(i);
                } else if (args.type === 'movie' && baseId === 'nexotv_vod') {
                    items = await addonInstance.getMoviesForCatalog();
                    toMeta = (i: any) => addonInstance.generateMoviePreview(i);
                } else if (args.type === 'series' && baseId === 'nexotv_series') {
                    items = await addonInstance.getSeriesForCatalog();
                    toMeta = (i: any) => addonInstance.generateSeriesPreview(i);
                } else if (args.type === 'tv' && ['iptv_channels', 'iptv_org'].includes(baseId)) {
                    items = await addonInstance.getChannelsForCatalog();
                    toMeta = (i: any) => addonInstance.generateMetaPreview(i);
                } else {
                    return { metas: [] };
                }

                if (categoryFilter) {
                    items = items.filter((i: any) =>
                        (i.category && i.category === categoryFilter) ||
                        (i.attributes && i.attributes['group-title'] === categoryFilter)
                    );
                }

                if (extra.genre && extra.genre !== 'All Channels') {
                    // Options are shown accent-stripped, so compare accent-insensitively.
                    const g = M3UEPGAddon.stripAccents(extra.genre);
                    items = items.filter((i: any) =>
                        (i.category && M3UEPGAddon.stripAccents(i.category) === g) ||
                        (i.attributes && i.attributes['group-title'] && M3UEPGAddon.stripAccents(i.attributes['group-title']) === g)
                    );
                }
                if (extra.search) {
                    const q = extra.search.toLowerCase();
                    items = items.filter((i: any) => (i.name || '').toLowerCase().includes(q));
                }
                const PAGE_SIZE = env.CATALOG_PAGE_SIZE;
                const skip = parseInt(extra.skip || '0', 10) || 0;
                const metas = items.slice(skip, skip + PAGE_SIZE).map(toMeta);
                if (env.DEBUG) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        totalItems: items.length,
                        returned: metas.length,
                        ms: Date.now() - start
                    });
                }
                return { metas };
            } catch (e) {
                console.error('[CATALOG] Error', e);
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                const streams = await addonInstance.getStreams(id);
                if (!streams || streams.length === 0) return { streams: [] };
                if (env.DEBUG) {
                    console.log('[DEBUG] Stream request', { id, count: streams.length });
                }
                return { streams };
            } catch (e) {
                console.error('[STREAM] Error', e);
                return { streams: [] };
            }
        });

        builder.defineMetaHandler(async ({ type, id }) => {
            try {
                const meta = await addonInstance.getDetailedMeta(id);
                if (env.DEBUG) {
                    console.log('[DEBUG] Meta request', { id, type });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error', e);
                return { meta: null };
            }
        });

        iface = builder.getInterface();
        iface.addonInstance = addonInstance;
        return iface;
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } finally {
        // Keep promise cached
    }
}

export default createAddon;
