import { AddonConfig } from '../types';
import { md5 } from '../utils/md5';

function stableStringify(obj: any) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Chave de cache / namespace de ids de uma config. md5 puro (não Node crypto)
 * para gerar o MESMO valor no app e no server — o `idPrefix` (primeiros 8 chars)
 * precisa ser estável para itens salvos pelos usuários continuarem resolvendo.
 */
export function createCacheKey(config: AddonConfig): string {
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
            reformatLogos: !!config.reformatLogos,
        };
    }
    return md5(stableStringify(minimal));
}

export function idPrefixFromCacheKey(cacheKey: string): string {
    return cacheKey.slice(0, 8);
}
