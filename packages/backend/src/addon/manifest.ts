import env from '../config/env';

export function createManifest(idPrefix?: string, catalogName?: string) {
    return {
        id: 'community.nexotv',
        version: '2.0.0',
        name: env.ADDON_NAME,
        description: env.ADDON_DESCRIPTION,
        resources: ['catalog', 'stream', 'meta'],
        types: ['tv', 'movie', 'series'],
        catalogs: [
            {
                type: 'tv',
                id: 'nexotv_games',
                name: 'Futebol Ao Vivo',
                extra: [
                    { name: 'skip' }
                ],
                genres: []
            },
            {
                type: 'tv',
                id: 'iptv_channels',
                name: catalogName || env.ADDON_NAME,
                extra: [
                    { name: 'genre', isRequired: false, options: [] },
                    { name: 'search', isRequired: false },
                    { name: 'skip' }
                ],
                genres: []
            },
            {
                type: 'movie',
                id: 'nexotv_vod',
                name: catalogName ? `${catalogName} Filmes` : 'Filmes',
                extra: [
                    { name: 'genre', isRequired: false, options: [] },
                    { name: 'search', isRequired: false },
                    { name: 'skip' }
                ],
                genres: []
            },
            {
                type: 'series',
                id: 'nexotv_series',
                name: catalogName ? `${catalogName} Series` : 'Series',
                extra: [
                    { name: 'genre', isRequired: false, options: [] },
                    { name: 'search', isRequired: false },
                    { name: 'skip' }
                ],
                genres: []
            }
        ],
        // 'tt' lets Stremio route IMDB stream requests (from Cinemeta home/search)
        // to us, so IPTV shows up as a source on the standard movie/series pages.
        idPrefixes: idPrefix
            ? ['tt', `xc${idPrefix}_`, `vod${idPrefix}_`, `ser${idPrefix}_`, `epi${idPrefix}_`, `io${idPrefix}_`, `m3${idPrefix}_`, `game${idPrefix}_`]
            : ['tt', 'xc', 'vod', 'ser', 'epi', 'io', 'm3', 'game'],
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        },
        ...(env.ADDON_LOGO_URL ? { logo: env.ADDON_LOGO_URL } : {}),
        ...(env.ADDON_BACKGROUND_URL ? { background: env.ADDON_BACKGROUND_URL } : {}),
    };
}
