/**
 * NexoEngine — orquestra catálogos/meta/stream do Rajada, independente de servidor.
 * Porte do backend M3UEPGAddon, com deps injetadas (http/options) reusando o core.
 * v1: provedor Xtream (o usado). iptv-org/m3u podem ser adicionados depois.
 */
import { HttpClient } from '../http/HttpClient';
import { AddonConfig } from '../types';
import { createCacheKey, idPrefixFromCacheKey } from '../config/cacheKey';
import { stripAccents, normalizeTitle, cleanForSearch, compact } from '../text/normalize';
import { parseEPG, getCurrentProgram, getUpcomingPrograms } from '../parsers/epgParser';
import { parseM3U } from '../parsers/m3uParser';
import { fetchTmdbMeta, resolveTmdbTitles, resolveImdbTitle } from '../meta/titleMatch';
import { fetchSofascoreAgenda, AgendaConfig } from '../agenda/sofascoreAgenda';
import { fetchXtreamData, fetchVodInfo, fetchSeriesInfo, XtreamOpts } from '../providers/xtreamProvider';

export interface EngineOptions {
    tmdbApiKey?: string | null;
    /** Agenda: relay (Worker /agenda) — preferido no app. */
    sofascoreAgendaUrl?: string | null;
    /** Agenda: direto (RapidAPI). */
    sofascoreRapidApiKey?: string | null;
    sofascoreRapidApiHost?: string;
    catalogPageSize?: number;
    addonName?: string;
    userAgent?: string;
    epgFetchTimeoutMs?: number;
    fetchTimeoutMs?: number;
    epgMaxBytes?: number;
    /** Banco de logos opcional (compact(nome) → url) — fallback p/ canais sem logo. */
    logoBank?: Record<string, string> | null;
    log?: (level: 'debug' | 'warn' | 'error', msg: string, extra?: any) => void;
}

export interface EngineDeps {
    http: HttpClient;
    options?: EngineOptions;
}

export class NexoEngine {
    config: AddonConfig;
    http: HttpClient;
    options: EngineOptions;
    idPrefix: string;
    epgOffset: number;

    channels: any[] = [];
    channelMap = new Map<string, any>();
    movies: any[] = [];
    movieMap = new Map<string, any>();
    series: any[] = [];
    seriesMap = new Map<string, any>();
    epgData: Record<string, any[]> = {};

    movieTitleIndex = new Map<string, any>();
    movieTitleYearIndex = new Map<string, any>();
    seriesTitleIndex = new Map<string, any>();
    seriesTitleYearIndex = new Map<string, any>();
    private vodInfoCache = new Map<string, { data: any; ts: number }>();
    private seriesInfoCache = new Map<string, { data: any; ts: number }>();
    private infoTtl = 6 * 3600 * 1000;

    constructor(config: AddonConfig, deps: EngineDeps) {
        // Normaliza URLs (qualquer servidor): adiciona http:// se faltar e tira
        // barras finais — evita // duplicado e "host sem esquema".
        const norm = (u?: string) => {
            let s = (u || '').trim();
            if (!s) return s;
            if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
            return s.replace(/\/+$/, '');
        };
        config = { ...config, xtreamUrl: norm(config.xtreamUrl), m3uUrl: norm(config.m3uUrl), epgUrl: config.epgUrl ? norm(config.epgUrl) : config.epgUrl };
        this.config = config;
        this.http = deps.http;
        this.options = deps.options || {};
        // idPrefix a partir da config ORIGINAL (enableEpg não forçado aqui) → estável.
        this.idPrefix = idPrefixFromCacheKey(createCacheKey(config));
        let off = typeof config.epgOffsetHours === 'string' ? parseFloat(config.epgOffsetHours) : (config.epgOffsetHours as number);
        if (!isFinite(off) || Math.abs(off) > 48) off = 0;
        this.epgOffset = off || 0;
    }

    private get _xopts(): XtreamOpts {
        return {
            idPrefix: this.idPrefix,
            userAgent: this.options.userAgent,
            fetchTimeoutMs: this.options.fetchTimeoutMs,
            epgFetchTimeoutMs: this.options.epgFetchTimeoutMs,
            epgMaxBytes: this.options.epgMaxBytes,
            log: (l, m, e) => this.options.log?.(l, m, e),
        };
    }

    /** Carrega dados do provedor (canais/VOD/séries/EPG) e monta índices. */
    async load(): Promise<void> {
        const provider = this.config.provider || 'xtream';
        if (provider === 'm3u') {
            await this._loadM3U();
        } else {
            const data = await fetchXtreamData(this.http, { ...this.config, enableEpg: true }, this._xopts);
            this.channels = data.channels;
            this.movies = data.movies;
            this.series = data.series;
            this.epgData = data.epgData;
        }
        this.channelMap = new Map(this.channels.map(c => [c.id, c]));
        this.movieMap = new Map(this.movies.map(m => [m.id, m]));
        this.seriesMap = new Map(this.series.map(s => [s.id, s]));
        this._groupsMemo = null;
        this._logoIdx = null;
        this.buildTitleIndexes();
    }

    /** Provedor M3U (lista .m3u/.m3u8) — cobre IPTV que não usa Xtream. */
    private async _loadM3U(): Promise<void> {
        const url = this.config.m3uUrl;
        if (!url) throw new Error('m3uUrl ausente');
        const ua = { 'User-Agent': this.options.userAgent || 'VLC/3.0.20 LibVLC/3.0.20' };
        const r = await this.http.get(url, { headers: ua, timeoutMs: this.options.fetchTimeoutMs ?? 30000 });
        if (!r || !r.ok) throw new Error('M3U fetch failed');
        const { channels, epgUrl } = parseM3U(await r.text());
        this.channels = channels.map((c: any, i: number) => ({
            id: `xc${this.idPrefix}_${i}`,
            name: c.name, type: 'tv', url: c.url, logo: c.logo, category: c.group,
            epg_channel_id: c.tvgId, userAgent: c.userAgent, referrer: c.referrer,
            attributes: { 'tvg-logo': c.logo, 'tvg-id': c.tvgId, 'group-title': c.group },
        }));
        this.movies = []; this.series = []; this.epgData = {};
        const epgSrc = (this.config.epgUrl && String(this.config.epgUrl).trim()) || epgUrl;
        if (epgSrc) {
            try {
                const er = await this.http.get(epgSrc, { headers: ua, timeoutMs: this.options.epgFetchTimeoutMs ?? 60000 });
                if (er && er.ok) this.epgData = await parseEPG(await er.text(), { maxBytes: this.options.epgMaxBytes });
            } catch { /* EPG opcional */ }
        }
    }

    get loaded() { return this.channels.length > 0; }

    // ===================== MANIFEST =====================

    getManifest() {
        const p = this.idPrefix;
        const name = this.options.addonName || 'Rajada';
        const catalogs: any[] = [
            { type: 'tv', id: 'nexotv_games', name: 'Futebol Ao Vivo', extra: [{ name: 'skip' }], genres: [] },
            { type: 'tv', id: 'iptv_channels', name, extra: [{ name: 'genre', isRequired: false, options: [] }, { name: 'search', isRequired: false }, { name: 'skip' }], genres: [] },
            { type: 'movie', id: 'nexotv_vod', name: 'Filmes', extra: [{ name: 'genre', isRequired: false, options: [] }, { name: 'search', isRequired: false }, { name: 'skip' }], genres: [] },
            { type: 'series', id: 'nexotv_series', name: 'Series', extra: [{ name: 'genre', isRequired: false, options: [] }, { name: 'search', isRequired: false }, { name: 'skip' }], genres: [] },
        ];
        // catálogos por categoria
        const mk = (type: string, base: string, category: string) => ({
            type, id: `${base}_g_${this.encodeCategory(category)}`, name: stripAccents(category), extra: [{ name: 'skip' }], genres: [],
        });
        const addCats = (type: string, base: string, items: any[], getCat: (i: any) => string | undefined) => {
            const cats = [...new Set(items.map(getCat).filter(Boolean).map((s: any) => s.trim()))].sort((a: any, b: any) => a.localeCompare(b));
            for (const c of cats) catalogs.push(mk(type, base, c as string));
        };
        addCats('movie', 'nexotv_vod', this.movies, (i: any) => i.category);
        addCats('series', 'nexotv_series', this.series, (i: any) => i.category);
        addCats('tv', 'iptv_channels', this.channels, (c: any) => c.category || c.attributes?.['group-title']);

        return {
            id: 'community.nexotv',
            version: '2.0.0',
            name,
            description: 'Rajada',
            resources: ['catalog', 'stream', 'meta'],
            types: ['tv', 'movie', 'series'],
            catalogs,
            idPrefixes: ['tt', `xc${p}_`, `vod${p}_`, `ser${p}_`, `epi${p}_`, `io${p}_`, `m3${p}_`, `game${p}_`, `chg${p}_`],
            behaviorHints: { configurable: true, configurationRequired: false },
        };
    }

    encodeCategory(name: string) {
        const b64 = (typeof Buffer !== 'undefined')
            ? Buffer.from(name, 'utf8').toString('base64')
            : btoa(unescape(encodeURIComponent(name)));
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    decodeCategory(b64: string) {
        let s = b64.replace(/-/g, '+').replace(/_/g, '/');
        const pad = (4 - (s.length % 4)) % 4; if (pad) s += '='.repeat(pad);
        return (typeof Buffer !== 'undefined')
            ? Buffer.from(s, 'base64').toString('utf8')
            : decodeURIComponent(escape(atob(s)));
    }

    // ===================== CATALOG =====================

    async getCatalog(args: { type: string; id: string; extra?: { skip?: any; genre?: string; search?: string } }) {
        const extra = args.extra || {};
        let baseId = args.id;
        let categoryFilter: string | null = null;
        for (const base of ['nexotv_vod', 'nexotv_series', 'iptv_channels']) {
            const pfx = base + '_g_';
            if (args.id.startsWith(pfx)) {
                baseId = base;
                try { categoryFilter = this.decodeCategory(args.id.slice(pfx.length)); } catch { categoryFilter = null; }
                break;
            }
        }

        let items: any[] = [];
        let toMeta: (i: any) => any;
        if (args.type === 'tv' && args.id === 'nexotv_games') {
            items = await this.getGamesForCatalog();
            toMeta = (i) => this.generateGamePreview(i);
        } else if (args.type === 'movie' && baseId === 'nexotv_vod') {
            items = this.movies; toMeta = (i) => this.generateMoviePreview(i);
        } else if (args.type === 'series' && baseId === 'nexotv_series') {
            items = this.series; toMeta = (i) => this.generateSeriesPreview(i);
        } else if (args.type === 'tv' && baseId === 'iptv_channels') {
            items = this.getChannelGroups(); toMeta = (i) => this.generateChannelGroupPreview(i);
        } else {
            return { metas: [] };
        }

        if (categoryFilter) {
            items = items.filter((i: any) =>
                (i.category && i.category === categoryFilter) ||
                (i.attributes && i.attributes['group-title'] === categoryFilter));
        }
        if (extra.genre && extra.genre !== 'All Channels') {
            const g = stripAccents(extra.genre);
            items = items.filter((i: any) =>
                (i.category && stripAccents(i.category) === g) ||
                (i.attributes && i.attributes['group-title'] && stripAccents(i.attributes['group-title']) === g));
        }
        if (extra.search) {
            const q = extra.search.toLowerCase();
            items = items.filter((i: any) => (i.name || '').toLowerCase().includes(q));
        }
        // Filmes/séries: colapsa repetidos (mesmo título+ano: dublado/legendado/4K…)
        // num tile só — limpa o "Mulan, Mulan / Ruas da Glória x2".
        if (args.type === 'movie' || args.type === 'series') items = this._dedupTitles(items);
        const PAGE = this.options.catalogPageSize ?? 100;
        const skip = parseInt(extra.skip || '0', 10) || 0;
        return { metas: items.slice(skip, skip + PAGE).map(toMeta) };
    }

    // Colapsa filmes/séries repetidos por título+ano (prefere o que tem poster).
    _dedupTitles(items: any[]) {
        const seen = new Map<string, any>();
        for (const it of items) {
            const k = normalizeTitle(it.name) + '|' + (it.year ? String(it.year).slice(0, 4) : '');
            const ex = seen.get(k);
            if (!ex) { seen.set(k, it); continue; }
            // mantém o que tem poster (capa) — visual melhor.
            if (!ex.poster && it.poster) seen.set(k, it);
        }
        return [...seen.values()];
    }

    // ===================== CHANNELS =====================

    // Paleta escura (Netflix-ish) p/ o card gerado quando o canal não tem logo.
    static _LOGO_PALETTE = ['1f3a5f', '3a1f5f', '5f1f2e', '1f5f3a', '5f4a1f', '2e1f5f', '1f5f5a', '5f1f4a', '24304a', '402a2a'];
    _logoCardColor(name: string) {
        let h = 0; const s = name || 'TV';
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return NexoEngine._LOGO_PALETTE[h % NexoEngine._LOGO_PALETTE.length];
    }

    // Índice de logos do PRÓPRIO provedor (sem banco externo): por nome-base e por
    // 1ª palavra (marca). Permite emprestar o logo de um canal irmão pra quem não tem.
    private _logoIdx: { byBase: Map<string, string>; byWord: Map<string, string> } | null = null;
    private _ensureLogoIndex() {
        if (this._logoIdx) return this._logoIdx;
        const byBase = new Map<string, string>();
        const wordCount = new Map<string, Map<string, number>>();
        for (const c of this.channels) {
            const logo = (c.attributes?.['tvg-logo'] || c.logo || '').trim();
            if (!logo) continue;
            const base = this._channelBaseName(c.name).toLowerCase();
            if (base && !byBase.has(base)) byBase.set(base, logo);
            const word = (base.split(' ')[0] || '');
            if (word.length >= 3) {
                if (!wordCount.has(word)) wordCount.set(word, new Map());
                const m = wordCount.get(word)!; m.set(logo, (m.get(logo) || 0) + 1);
            }
        }
        const byWord = new Map<string, string>();
        for (const [w, m] of wordCount) { let best = ''; let max = 0; for (const [lg, n] of m) if (n > max) { max = n; best = lg; } if (best) byWord.set(w, best); }
        this._logoIdx = { byBase, byWord };
        return this._logoIdx;
    }
    // Banco curado (iptv-org): PNGs transparentes de estilo uniforme. Preferi-lo
    // ao tvg-logo do provedor (fundos brancos/escuros aleatórios) deixa o visual
    // consistente sozinho pros canais conhecidos.
    private _findBankLogo(name: string): string | null {
        const bank = this.options.logoBank;
        if (!bank) return null;
        const base = this._channelBaseName(name).toLowerCase();
        const cb = compact(base) || compact(name);
        return (cb && bank[cb]) ? bank[cb] : null;
    }
    private _findProviderLogo(name: string): string | null {
        const idx = this._ensureLogoIndex();
        const base = this._channelBaseName(name).toLowerCase();
        if (idx.byBase.has(base)) return idx.byBase.get(base)!;
        const bank = this._findBankLogo(name);
        if (bank) return bank;
        const w = base.split(' ')[0] || '';
        if (w.length >= 3 && idx.byWord.has(w)) return idx.byWord.get(w)!;
        return null;
    }

    deriveFallbackLogoUrl(item: any) {
        const own = item.attributes?.['tvg-logo'] || item.logo;
        // Ordem (visual consistente sozinho):
        // 1) banco curado iptv-org (transparente, estilo uniforme) p/ canal conhecido
        // 2) logo do próprio canal; 3) logo de irmão da mesma marca (índice do provedor)
        let finalUrl = this._findBankLogo(item.name || '')
            || ((own && own.trim()) ? own.trim() : this._findProviderLogo(item.name || ''));
        if (finalUrl) {
            if (finalUrl.includes('imgur.com')) finalUrl = `https://proxy.duckduckgo.com/iu/?u=${encodeURIComponent(finalUrl)}`;
            // trim=10 corta bordas/margens uniformes (logos preenchem melhor); bg igual
            // ao card (#15151b) pra logos transparentes blendarem sem moldura visível.
            return `https://wsrv.nl/?url=${encodeURIComponent(finalUrl)}&w=320&h=320&fit=contain&we&trim=10&bg=15151b`;
        }
        // 3) sem nada → card colorido gerado (cor determinística pelo nome) — sem banco.
        const base = this._channelBaseName(item.name) || item.name || 'TV';
        return `https://placehold.co/320x320/${this._logoCardColor(base)}/FFFFFF.png?text=${encodeURIComponent(base)}&font=oswald`;
    }

    generateMetaPreview(item: any) {
        const logoUrl = this.deriveFallbackLogoUrl(item);
        return {
            id: item.id, type: 'tv', name: item.name,
            poster: logoUrl, background: logoUrl, posterShape: 'square',
            genres: item.category ? [item.category] : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live',
        };
    }

    // ===================== CANAIS estilo TV PAGA (dedup de qualidades) =====================

    // Nome-base do canal: tira [tags] e tokens de qualidade soltos → 1 entrada por
    // emissora ("ADULT SWIM [FHD][H265]" e "ADULT SWIM [SD]" → "ADULT SWIM").
    // Redes com MUITAS afiliadas regionais → agrupa todas sob a marca ("GLOBO TV
    // BAHIA", "GLOBO SP" → "Globo"). Reduz o "monte de Globo/SBT" no grid.
    static NETWORK_BRANDS = ['GLOBO', 'SBT', 'RECORD', 'BAND', 'REDE TV', 'REDETV', 'CNT', 'TV BRASIL'];

    _channelBaseName(name: string) {
        let base = (name || '')
            .replace(/\[[^\]]*\]/g, ' ')                              // [FHD], [H265]…
            .replace(/\b(FHD|HD|SD|4K|UHD|H265|H264|HEVC|FULLHD)\b/gi, ' ')
            .replace(/\s+/g, ' ').trim()
            .replace(/\s+\d{1,2}$/, '')                               // família numerada: "Apple TV 4" → "Apple TV"
            .trim();
        const up = base.toUpperCase();
        for (const b of NexoEngine.NETWORK_BRANDS) {
            if (up === b || up.startsWith(b + ' ')) {                 // 1ª palavra = marca de rede
                return b.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
            }
        }
        return base;
    }

    _encodeChannelGroupId(key: string) {
        const b64 = (typeof Buffer !== 'undefined' ? Buffer.from(key, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(key))))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `chg${this.idPrefix}_${b64}`;
    }
    _decodeChannelGroupId(id: string): string | null {
        try {
            let b64 = id.slice(`chg${this.idPrefix}_`.length).replace(/-/g, '+').replace(/_/g, '/');
            const pad = (4 - (b64.length % 4)) % 4; if (pad) b64 += '='.repeat(pad);
            return (typeof Buffer !== 'undefined') ? Buffer.from(b64, 'base64').toString('utf8') : decodeURIComponent(escape(atob(b64)));
        } catch { return null; }
    }

    private _groupsMemo: any[] | null = null;

    /** Agrupa canais por emissora (dedup de qualidades + famílias + redes), IGNORANDO
     * categoria — assim "Globo" vira UM tile só (não um por categoria). A categoria
     * do grupo é a mais comum entre as variantes (define em qual fileira ele entra). */
    getChannelGroups(src?: any[]) {
        if (!src && this._groupsMemo) return this._groupsMemo;
        const channels = src || this.channels;
        const groups = new Map<string, { base: string; catCount: Map<string, number>; attributes: any; channels: any[] }>();
        for (const c of channels) {
            const base = this._channelBaseName(c.name) || c.name;
            const key = base.toLowerCase();
            if (!groups.has(key)) groups.set(key, { base, catCount: new Map(), attributes: c.attributes, channels: [] });
            const g = groups.get(key)!;
            g.channels.push(c);
            const cat = c.category || (c.attributes && c.attributes['group-title']) || '';
            if (cat) g.catCount.set(cat, (g.catCount.get(cat) || 0) + 1);
        }
        const out: any[] = [];
        for (const g of groups.values()) {
            g.channels.sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a));
            // categoria mais frequente entre as variantes
            let category = ''; let max = 0;
            for (const [cat, n] of g.catCount) if (n > max) { max = n; category = cat; }
            out.push({ base: g.base, name: g.base, category, attributes: g.attributes, channels: g.channels });
        }
        if (!src) this._groupsMemo = out;
        return out;
    }

    private _channelsForGroupKey(key: string) {
        // key = nome-base do grupo (sem categoria — agrupa a marca toda).
        const base = key;
        const baseLc = base.toLowerCase();
        const all = this.channels.filter(c => this._channelBaseName(c.name).toLowerCase() === baseLc);
        // 1 opção por sub-canal (ex: "Premiere 2"), na MELHOR qualidade — sem repetir
        // FHD/HD/SD. subKey = nome sem tags de qualidade (mantém o número).
        const subKey = (n: string) => (n || '').replace(/\[[^\]]*\]/g, ' ').replace(/\b(FHD|HD|SD|4K|UHD|H265|H264|HEVC|FULLHD)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        all.sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a));
        const best = new Map<string, any>();
        for (const c of all) { const k = subKey(c.name); if (!best.has(k)) best.set(k, c); }
        const variants = [...best.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
        return { base, variants };
    }

    // Escolhe a variante com logo (qualquer uma), pra não cair no card só porque a
    // melhor qualidade veio sem logo.
    _repWithLogo(channels: any[]) {
        return channels.find(c => ((c.attributes?.['tvg-logo'] || c.logo || '').trim())) || channels[0] || {};
    }

    generateChannelGroupPreview(g: any) {
        const rep = this._repWithLogo(g.channels);
        const logo = this.deriveFallbackLogoUrl(rep);
        const epgId = (g.channels[0] || {}).attributes?.['tvg-id'] || (g.channels[0] || {}).epg_channel_id;
        const cur = getCurrentProgram(this.epgData, epgId, this.epgOffset);
        const agora = cur ? `Agora: ${stripAccents(cur.title)}` : undefined;
        return {
            id: this._encodeChannelGroupId(g.base), type: 'tv', name: g.base,
            poster: logo, background: logo, posterShape: 'square',
            description: agora, releaseInfo: agora,
            genres: g.category ? [g.category] : ['Live TV'],
        };
    }

    _getChannelGroupMeta(id: string) {
        const key = this._decodeChannelGroupId(id);
        if (!key) return null;
        const { base, variants } = this._channelsForGroupKey(key);
        if (!variants.length) return null;
        const rep = variants[0];
        const logoRep = this._repWithLogo(variants);
        const epgId = rep.attributes?.['tvg-id'] || rep.attributes?.['tvg-name'] || rep.epg_channel_id;
        const cur = getCurrentProgram(this.epgData, epgId, this.epgOffset);
        const upcoming = getUpcomingPrograms(this.epgData, epgId, 4, this.epgOffset);
        const hhmm = (dt: any) => dt ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : '';
        let description = stripAccents(base);
        if (cur) {
            const s = hhmm(cur.startTime), e = hhmm(cur.stopTime);
            description += `\n\nAGORA: ${stripAccents(cur.title)}${s && e ? ` (${s}-${e})` : ''}`;
            if (cur.description) description += `\n\n${stripAccents(cur.description)}`;
        }
        if (upcoming.length) { description += '\n\nA SEGUIR:\n'; for (const p of upcoming) description += `${hhmm(p.startTime)} - ${stripAccents(p.title)}\n`; }
        const logo = this.deriveFallbackLogoUrl(logoRep);
        return {
            id, type: 'tv', name: base, poster: logo, background: logo, posterShape: 'square',
            description, genres: rep.category ? [rep.category] : ['Live TV'], runtime: 'Live',
        };
    }

    // ===================== MOVIES / SERIES previews =====================

    private _posterOrPlaceholder(url: string | undefined, name: string) {
        if (url && url.trim()) return url;
        return `https://placehold.co/250x375/2b2b2b/FFFFFF.png?text=${encodeURIComponent(name || 'VOD')}`;
    }

    generateMoviePreview(m: any) {
        return {
            id: m.id, type: 'movie', name: m.name,
            poster: this._posterOrPlaceholder(m.poster, m.name), posterShape: 'poster',
            releaseInfo: m.year || undefined, imdbRating: m.rating || undefined,
            description: (m.plot && String(m.plot).trim()) || undefined,
            genres: m.category ? [m.category] : undefined,
        };
    }
    generateSeriesPreview(s: any) {
        return {
            id: s.id, type: 'series', name: s.name,
            poster: this._posterOrPlaceholder(s.poster, s.name), posterShape: 'poster',
            releaseInfo: s.year || undefined, imdbRating: s.rating || undefined,
            description: (s.plot && String(s.plot).trim()) || undefined,
            genres: s.category ? [s.category] : undefined,
        };
    }

    // ===================== GAMES (futebol) =====================

    _isFootballMatch(title: string) {
        if (!title) return false;
        const t = title.toLowerCase().trim();
        if (!/ x /.test(t)) return false;
        if (/^vt\s*-?\s/.test(t)) return false;
        const REPLAY = ['reprise', 'compacto', 'melhores momentos', 'best of', '(r)', 'replay', 'gols de', 'resenha'];
        for (const r of REPLAY) if (t.includes(r)) return false;
        const EXCLUDE = ['mlb', 'nba', 'nfl', 'nhl', 'ufc', 'boxe', 'boxing', 'luta', 'mma', 'knockout', 'tênis', 'tenis', 'tennis', 'vôlei', 'volei', 'basquete', 'f1', 'fórmula', 'formula', 'nascar', 'beisebol', 'hóquei', 'hoquei', 'wwe', 'golfe', 'atletismo', 'e-sports', 'esports', 'league of legends', 'valorant', 'counter', 'lbf', 'nbb'];
        for (const e of EXCLUDE) if (t.includes(e)) return false;
        return true;
    }
    _isSportsChannel(ch: any) {
        const s = ((ch.name || '') + ' ' + (ch.category || '') + ' ' + (ch.attributes?.['group-title'] || '')).toLowerCase();
        const KW = ['esporte', 'sport', 'espn', 'sportv', 'premiere', 'dazn', 'combate', 'goat', 'caze', 'cazé', 'futebol', 'eurosport', 'tnt', 'fox sport', 'nsports', 'globo', 'record', 'sbt', 'band', 'rede tv', 'cnt', 'tv brasil', 'desimpedido'];
        return KW.some(k => s.includes(k));
    }
    _channelQualityRank(ch: any) {
        const n = (ch?.name || '').toUpperCase();
        if (/\b(4K|UHD)\b/.test(n)) return 4;
        if (/\bFHD\b/.test(n)) return 3;
        if (/\bHD\b/.test(n)) return 2;
        if (/\bSD\b/.test(n)) return 1;
        return 0;
    }
    static GAME_BROADCASTERS = ['SPORTV', 'PREMIERE', 'PREMIER', 'ESPN', 'TNT SPORTS', 'TNT', 'SPACE', 'DAZN', 'CAZE', 'CAZÉ', 'NSPORTS', 'N SPORTS', 'EUROSPORT', 'GOAT', 'DISNEY', 'STAR', 'PARAMOUNT', 'GLOBO', 'SBT', 'RECORD', 'BAND', 'REDE TV', 'CNT', 'TV BRASIL'];
    _gameStationKey(name: string) {
        const clean = (name || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
        for (const b of NexoEngine.GAME_BROADCASTERS) if (clean.includes(b)) return b;
        return clean;
    }
    _dedupGameChannels(channels: any[], cap = 15) {
        const byStation = new Map<string, any[]>();
        for (const c of channels) {
            const k = this._gameStationKey(c.name || '');
            if (!byStation.has(k)) byStation.set(k, []);
            byStation.get(k)!.push(c);
        }
        const picked: { key: string; chans: any[] }[] = [];
        for (const [key, list] of byStation) {
            list.sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a));
            const seenTier = new Set<number>(); const chans: any[] = [];
            for (const c of list) { const t = this._channelQualityRank(c); if (seenTier.has(t)) continue; seenTier.add(t); chans.push(c); }
            picked.push({ key, chans });
        }
        const prio = (k: string) => { const i = NexoEngine.GAME_BROADCASTERS.indexOf(k); return i === -1 ? 999 : i; };
        picked.sort((a, b) => prio(a.key) - prio(b.key) || a.key.localeCompare(b.key));
        const out: any[] = [];
        for (const s of picked) for (const c of s.chans) { out.push(c); if (out.length >= cap) return out; }
        return out;
    }
    _teamsFromTitle(title: string): { a: string; b: string } | null {
        const t = (title || '').replace(/\s*-?\s*ao vivo/i, '').trim();
        const parts = t.split(/\s+x\s+/i);
        if (parts.length < 2) return null;
        const a = compact(parts[0]); const b = compact(parts[parts.length - 1]);
        if (a.length < 3 || b.length < 3) return null;
        return { a, b };
    }
    _teamTokens(title: string) {
        return (title || '').split(/\s+x\s+/i).map(s => compact(s)).filter(t => t.length >= 3);
    }
    _teamsOverlap(a: string[], b: string[]) {
        for (const x of a) for (const y of b) if (x === y || x.includes(y) || y.includes(x)) return true;
        return false;
    }
    _channelNameIsReplay(name: string) {
        return /^vt\b|reprise|replay|compacto|melhores momentos|\(r\)|gols de/.test((name || '').toLowerCase());
    }
    _isGameLive(g: { start: number; stop?: number }, now = Date.now()) {
        if (!g || !g.start) return false;
        const end = g.stop && g.stop > g.start ? g.stop : g.start + 2.5 * 3600 * 1000;
        return now >= g.start && now <= end;
    }
    _gameTileImage(matchName: string, statusLine: string, live: boolean) {
        const bg = live ? 'b3261e' : '14532d';
        const text = encodeURIComponent(`${matchName}\n${statusLine}`);
        return `https://placehold.co/640x360/${bg}/FFFFFF.png?text=${text}&font=oswald`;
    }
    _gameDayLabel(d: Date) {
        const now = new Date(); const tomorrow = new Date(now.getTime() + 86400000);
        if (d.toDateString() === now.toDateString()) return 'Hoje';
        if (d.toDateString() === tomorrow.toDateString()) return 'Amanha';
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    _encodeGameId(g: any) {
        const payload = JSON.stringify({ cs: (g.channels || []).map((c: any) => c.id), s: g.start, e: g.stop || 0, n: g.title });
        const b64 = (typeof Buffer !== 'undefined' ? Buffer.from(payload, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(payload))))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `game${this.idPrefix}_${b64}`;
    }
    _decodeGameId(id: string): { cs: string[]; s: number; e?: number; n: string } | null {
        try {
            let b64 = id.slice(`game${this.idPrefix}_`.length).replace(/-/g, '+').replace(/_/g, '/');
            const pad = (4 - (b64.length % 4)) % 4; if (pad) b64 += '='.repeat(pad);
            const json = (typeof Buffer !== 'undefined') ? Buffer.from(b64, 'base64').toString('utf8') : decodeURIComponent(escape(atob(b64)));
            const o = JSON.parse(json);
            if (o && !o.cs && o.c) o.cs = [o.c];
            return o;
        } catch { return null; }
    }
    _iptvBase(name: string) {
        return stripAccents(name || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/\b(fhd|hd|sd|4k|uhd|h265|h264)\b/g, ' ').replace(/\s+/g, ' ').trim();
    }
    _matchSofaToIptv(sofaName: string, baseList: { c: any; base: string }[]) {
        const want = this._iptvBase(sofaName);
        let cands: { c: any; base: string }[];
        if (want.includes('globo')) cands = baseList.filter(x => x.base.includes('globo'));
        else if (want === 'dazn') cands = baseList.filter(x => x.base === 'dazn' || x.base.startsWith('dazn '));
        else if (want === 'premiere') cands = baseList.filter(x => x.base === 'premiere' || x.base.startsWith('premiere clube'));
        else if (want === 'sbt' || want === '+sbt') cands = baseList.filter(x => x.base === 'sbt' || x.base.startsWith('sbt '));
        else if (want.includes('paramount')) cands = baseList.filter(x => x.base.includes('paramount'));
        else if (want.includes('disney')) cands = baseList.filter(x => x.base.includes('disney plus') || x.base.includes('disney+'));
        else if (want.includes('caze')) cands = baseList.filter(x => x.base.includes('caze'));
        else cands = baseList.filter(x => x.base === want);
        const seen = new Set<number>(); const out: any[] = [];
        for (const x of cands.sort((a, b) => this._channelQualityRank(b.c) - this._channelQualityRank(a.c))) {
            const t = this._channelQualityRank(x.c); if (seen.has(t)) continue; seen.add(t); out.push(x.c);
        }
        return out;
    }
    static _TEAM_PT: Record<string, string> = {
        'brazil': 'Brasil', 'norway': 'Noruega', 'senegal': 'Senegal', 'england': 'Inglaterra', 'ghana': 'Gana', 'scotland': 'Escocia', 'czechia': 'Tchequia', 'czech republic': 'Tchequia', 'mexico': 'Mexico', 'jordan': 'Jordania', 'algeria': 'Argelia', 'france': 'Franca', 'iraq': 'Iraque', 'argentina': 'Argentina', 'austria': 'Austria', 'portugal': 'Portugal', 'uzbekistan': 'Uzbequistao', 'colombia': 'Colombia', 'switzerland': 'Suica', 'canada': 'Canada', 'spain': 'Espanha', 'germany': 'Alemanha', 'italy': 'Italia', 'netherlands': 'Holanda', 'belgium': 'Belgica', 'croatia': 'Croacia', 'uruguay': 'Uruguai', 'ukraine': 'Ucrania', 'united states': 'Estados Unidos', 'usa': 'Estados Unidos', 'south korea': 'Coreia do Sul', 'japan': 'Japao', 'morocco': 'Marrocos', 'denmark': 'Dinamarca', 'poland': 'Polonia', 'bulgaria': 'Bulgaria', 'congo dr': 'RD Congo', 'dr congo': 'RD Congo', 'south africa': 'Africa do Sul', 'sweden': 'Suecia', 'turkey': 'Turquia', 'turkiye': 'Turquia', 'qatar': 'Catar', 'haiti': 'Haiti', 'panama': 'Panama', 'ivory coast': 'Costa do Marfim', 'curacao': 'Curacao', 'bosnia & herzegovina': 'Bosnia e Herzegovina', 'bosnia and herzegovina': 'Bosnia e Herzegovina',
    };
    _translateTeam(name: string) {
        const k = stripAccents(name || '').toLowerCase().trim();
        return NexoEngine._TEAM_PT[k] || name;
    }

    private _agendaConfig(): AgendaConfig {
        return {
            agendaUrl: this.options.sofascoreAgendaUrl || null,
            rapidApiKey: this.options.sofascoreRapidApiKey || null,
            rapidApiHost: this.options.sofascoreRapidApiHost,
        };
    }

    async _buildSofaGames() {
        const agenda = await fetchSofascoreAgenda(this.http, this._agendaConfig());
        if (!agenda.length) return [];
        const baseList = this.channels.map(c => ({ c, base: this._iptvBase(c.name) }));
        const out: any[] = [];
        for (const ag of agenda) {
            const chMap = new Map<string, any>();
            for (const sofaName of ag.channels) for (const c of this._matchSofaToIptv(sofaName, baseList)) chMap.set(c.id, c);
            if (!chMap.size) continue;
            const channels = [...chMap.values()].sort((a, b) => this._channelQualityRank(b) - this._channelQualityRank(a)).slice(0, 15);
            out.push({ title: `${this._translateTeam(ag.home)} x ${this._translateTeam(ag.away)}`, start: ag.startMs, stop: ag.stopMs, channels });
        }
        return out;
    }

    async getGamesForCatalog() {
        if (!this.epgData || Object.keys(this.epgData).length === 0) {
            // sem EPG, ainda tenta a agenda (relay)
        }
        const chByEpg = new Map<string, any[]>();
        for (const c of this.channels) {
            const epgId = c.attributes?.['tvg-id'] || c.epg_channel_id;
            if (!epgId) continue;
            if (!chByEpg.has(epgId)) chByEpg.set(epgId, []);
            chByEpg.get(epgId)!.push(c);
        }
        const now = Date.now();
        const minStart = now - 2 * 3600 * 1000;
        const horizon = now + 5 * 24 * 3600 * 1000;
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
        const allChans = this.channels.map(c => ({ c, n: compact(c.name) }));
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
            epgOut.push({ title: g.title, start: g.start, stop: g.stop, channels: this._dedupGameChannels([...g.chans.values()]) });
        }
        let merged = epgOut;
        try {
            const sofaGames = await this._buildSofaGames();
            if (sofaGames.length) {
                for (const sg of sofaGames) {
                    const st = this._teamTokens(sg.title);
                    for (const eg of epgOut) {
                        if (Math.abs(sg.start - eg.start) > 3 * 3600 * 1000) continue;
                        if (!this._teamsOverlap(st, this._teamTokens(eg.title))) continue;
                        const ids = new Set(sg.channels.map((c: any) => c.id));
                        for (const c of eg.channels) if (!ids.has(c.id)) sg.channels.push(c);
                    }
                    sg.channels = sg.channels.sort((a: any, b: any) => this._channelQualityRank(b) - this._channelQualityRank(a)).slice(0, 20);
                }
                merged = sofaGames;
            }
        } catch (e: any) { this.options.log?.('warn', '[GAMES] sofa merge failed', e?.message); }
        merged.sort((a, b) => (this._isGameLive(b, now) ? 1 : 0) - (this._isGameLive(a, now) ? 1 : 0) || a.start - b.start);
        return merged;
    }

    generateGamePreview(g: any) {
        const d = new Date(g.start);
        const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
        const dayLabel = this._gameDayLabel(d);
        const primary = (g.channels && g.channels[0]) || {};
        const matchName = g.title.replace(/\s*-?\s*ao vivo/i, '').trim();
        const live = this._isGameLive(g);
        const img = this._gameTileImage(matchName, live ? 'AO VIVO AGORA' : `${dayLabel} ${hh}:${mm}`, live);
        const n = (g.channels || []).length;
        const opts = n > 1 ? `${n} transmissoes` : stripAccents(primary.name || '');
        const safeMatch = stripAccents(matchName);
        const when = live ? 'AO VIVO' : `${dayLabel} ${hh}:${mm}`;
        return {
            id: this._encodeGameId(g), type: 'tv', name: live ? `[AO VIVO] ${safeMatch}` : safeMatch,
            poster: img, background: img, posterShape: 'landscape',
            description: `${when} - ${opts}`, releaseInfo: `${when} - ${opts}`,
            genres: [stripAccents(primary.name || '')].filter(Boolean),
        };
    }

    _getGameMeta(id: string) {
        const info = this._decodeGameId(id);
        if (!info) return null;
        const channels = (info.cs || []).map(cid => this.channelMap.get(cid)).filter(Boolean);
        const d = new Date(info.s);
        const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
        const dayLabel = this._gameDayLabel(d);
        const rawMatch = info.n.replace(/\s*-?\s*ao vivo/i, '').trim();
        const matchName = stripAccents(rawMatch);
        const live = this._isGameLive({ start: info.s, stop: info.e });
        const img = this._gameTileImage(rawMatch, live ? 'AO VIVO AGORA' : `${dayLabel} ${hh}:${mm}`, live);
        const chList = channels.length ? channels.map((c: any) => `- ${stripAccents(c.name)}`).join('\n') : '- (canal indisponivel)';
        const statusLine = live ? '*** AO VIVO AGORA ***' : `${dayLabel} as ${hh}:${mm}`;
        return {
            id, type: 'tv', name: live ? `[AO VIVO] ${matchName}` : matchName,
            poster: img, background: img, posterShape: 'landscape',
            releaseInfo: live ? 'AO VIVO' : `${dayLabel} ${hh}:${mm}`,
            description: `${matchName}\n\n${statusLine}\n\nTransmissoes (escolha a qualidade ao assistir):\n${chList}`,
            genres: channels.map((c: any) => stripAccents(c.name)).filter(Boolean),
        };
    }

    // ===================== META =====================

    async getMeta(type: string, id: string) {
        return { meta: await this.getDetailedMeta(id) };
    }

    async getDetailedMeta(id: string) {
        if (id.startsWith('tt')) return null;
        if (id.startsWith(`game${this.idPrefix}_`)) return this._getGameMeta(id);
        if (id.startsWith(`chg${this.idPrefix}_`)) return this._getChannelGroupMeta(id);
        if (id.startsWith(`vod${this.idPrefix}_`)) return this.getMovieMeta(id);
        if (id.startsWith(`ser${this.idPrefix}_`)) return this.getSeriesMeta(id);
        const item = this.channelMap.get(id);
        if (!item) return null;
        const epgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = getCurrentProgram(this.epgData, epgId, this.epgOffset);
        const upcoming = getUpcomingPrograms(this.epgData, epgId, 3, this.epgOffset);
        const hhmm = (dt: any) => dt ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : '';
        let description = stripAccents(item.name);
        if (current) {
            const s = hhmm(current.startTime), e = hhmm(current.stopTime);
            description += `\n\nAGORA: ${stripAccents(current.title)}${s && e ? ` (${s}-${e})` : ''}`;
            if (current.description) description += `\n\n${stripAccents(current.description)}`;
        }
        if (upcoming.length) {
            description += '\n\nA SEGUIR:\n';
            for (const p of upcoming) description += `${hhmm(p.startTime)} - ${stripAccents(p.title)}\n`;
        }
        const logoUrl = this.deriveFallbackLogoUrl(item);
        return {
            id: item.id, type: 'tv', name: item.name, poster: logoUrl, background: logoUrl, posterShape: 'square',
            description,
            genres: item.category ? [item.category] : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live',
        };
    }

    /** Poster do TMDB para um filme/série (preenche capas faltantes, estilo Stremio). */
    async getTmdbPosterFor(id: string): Promise<string | null> {
        let item: any = null; let type: 'movie' | 'tv' | null = null;
        if (id.startsWith(`vod${this.idPrefix}_`)) { item = this.movieMap.get(id); type = 'movie'; }
        else if (id.startsWith(`ser${this.idPrefix}_`)) { item = this.seriesMap.get(id); type = 'tv'; }
        if (!item || !type) return null;
        try {
            const t = await fetchTmdbMeta(this.http, this.options.tmdbApiKey, item.name, item.year, type);
            return t?.poster || null;
        } catch { return null; }
    }

    async getMovieMeta(id: string) {
        const m = this.movieMap.get(id);
        if (!m) return null;
        let info: any = null;
        const cached = this.vodInfoCache.get(id);
        if (cached && Date.now() - cached.ts < this.infoTtl) info = cached.data;
        else { info = await fetchVodInfo(this.http, this.config, m.streamId, this._xopts); if (info) this.vodInfoCache.set(id, { data: info, ts: Date.now() }); }
        let cast = info?.cast ? String(info.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;
        const backdrop = Array.isArray(info?.backdrop_path) ? info.backdrop_path[0] : undefined;
        let description = info?.plot || info?.description || '';
        let tmdb: any = null;
        try { tmdb = await fetchTmdbMeta(this.http, this.options.tmdbApiKey, m.name, m.year, 'movie'); } catch { }
        if (tmdb) { if (!description) description = tmdb.overview || ''; if (!cast || !cast.length) cast = tmdb.cast?.length ? tmdb.cast : cast; }
        const poster = this._posterOrPlaceholder(m.poster || tmdb?.poster, m.name);
        const links = tmdb?.imdb ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${tmdb.imdb}` }] : undefined;
        return {
            id: m.id, type: 'movie', name: m.name, poster, posterShape: 'poster',
            background: backdrop || tmdb?.background || m.poster || tmdb?.poster, description,
            releaseInfo: m.year || info?.releasedate || tmdb?.year || undefined,
            imdbRating: m.rating || info?.rating || tmdb?.rating || undefined,
            genres: m.category ? [m.category] : (info?.genre ? [info.genre] : (tmdb?.genres?.length ? tmdb.genres : undefined)),
            runtime: info?.duration || tmdb?.runtime || undefined, cast, director: info?.director || undefined, links,
        };
    }

    async getSeriesInfoCached(id: string, seriesId: string | number) {
        const cached = this.seriesInfoCache.get(id);
        if (cached && Date.now() - cached.ts < this.infoTtl) return cached.data;
        const data = await fetchSeriesInfo(this.http, this.config, seriesId, this._xopts);
        if (data) this.seriesInfoCache.set(id, { data, ts: Date.now() });
        return data;
    }

    async getSeriesMeta(id: string) {
        const s = this.seriesMap.get(id);
        if (!s) return null;
        const data = await this.getSeriesInfoCached(id, s.seriesId);
        const videos: any[] = [];
        if (data?.episodes) {
            for (const seasonNum of Object.keys(data.episodes)) {
                for (const ep of (data.episodes[seasonNum] || [])) {
                    const ext = (ep.container_extension || 'mp4').replace(/^\./, '');
                    const seasN = Number(seasonNum) || 1; const epNum = Number(ep.episode_num) || (videos.length + 1);
                    let released: string | undefined;
                    if (ep.info?.releasedate) released = ep.info.releasedate;
                    else if (ep.added) { const t = Number(ep.added); if (isFinite(t) && t > 0) released = new Date(t * 1000).toISOString(); }
                    videos.push({ id: `epi${this.idPrefix}_${ep.id}__${ext}`, title: ep.title || `S${seasN}E${epNum}`, season: seasN, episode: epNum, thumbnail: ep.info?.movie_image || ep.info?.cover_big || s.poster || undefined, overview: ep.info?.plot || ep.info?.overview || undefined, released });
                }
            }
        }
        videos.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
        const backdrop = Array.isArray(data?.info?.backdrop_path) ? data.info.backdrop_path[0] : undefined;
        let description = s.plot || data?.info?.plot || '';
        let cast = s.cast ? String(s.cast).split(',').map((x: string) => x.trim()).filter(Boolean) : undefined;
        let tmdb: any = null;
        try { tmdb = await fetchTmdbMeta(this.http, this.options.tmdbApiKey, s.name, s.year, 'tv'); } catch { }
        if (tmdb) { if (!description) description = tmdb.overview || ''; if (!cast || !cast.length) cast = tmdb.cast?.length ? tmdb.cast : cast; }
        const links = tmdb?.imdb ? [{ name: 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${tmdb.imdb}` }] : undefined;
        return {
            id: s.id, type: 'series', name: s.name, poster: this._posterOrPlaceholder(s.poster || tmdb?.poster, s.name), posterShape: 'poster',
            background: backdrop || tmdb?.background || s.poster, description, releaseInfo: s.year || tmdb?.year || undefined,
            imdbRating: s.rating || data?.info?.rating || tmdb?.rating || undefined,
            genres: s.category ? [s.category] : (s.genre ? [s.genre] : (tmdb?.genres?.length ? tmdb.genres : undefined)),
            cast, director: s.director || undefined, links, videos,
        };
    }

    // ===================== STREAMS =====================

    buildTitleIndexes() {
        this.movieTitleIndex = new Map(); this.movieTitleYearIndex = new Map();
        this.seriesTitleIndex = new Map(); this.seriesTitleYearIndex = new Map();
        for (const m of this.movies) {
            const key = normalizeTitle(m.name); if (!key) continue;
            if (!this.movieTitleIndex.has(key)) this.movieTitleIndex.set(key, m);
            const y = m.year ? String(m.year).slice(0, 4) : null;
            if (y) { const yk = `${key}|${y}`; if (!this.movieTitleYearIndex.has(yk)) this.movieTitleYearIndex.set(yk, m); }
        }
        for (const s of this.series) {
            const key = normalizeTitle(s.name); if (!key) continue;
            if (!this.seriesTitleIndex.has(key)) this.seriesTitleIndex.set(key, s);
            const y = s.year ? String(s.year).slice(0, 4) : null;
            if (y) { const yk = `${key}|${y}`; if (!this.seriesTitleYearIndex.has(yk)) this.seriesTitleYearIndex.set(yk, s); }
        }
    }

    private _lookupByTitle(byTitle: Map<string, any>, byTitleYear: Map<string, any>, items: any[], name: string, year: string | null) {
        const key = normalizeTitle(name); if (!key) return null;
        if (year) for (const y of [year, String(Number(year) + 1), String(Number(year) - 1)]) { const hit = byTitleYear.get(`${key}|${y}`); if (hit) return hit; }
        const exact = byTitle.get(key); if (exact) return exact;
        let best: any = null, bestLen = Infinity, bestYearMatch = false;
        for (const it of items) {
            const t = normalizeTitle(it.name); if (!t) continue;
            const isPrefix = t === key || t.startsWith(key + ' ') || key.startsWith(t + ' '); if (!isPrefix) continue;
            const ym = !!(year && it.year && String(it.year).slice(0, 4) === year);
            if (ym && !bestYearMatch) { best = it; bestLen = t.length; bestYearMatch = true; continue; }
            if (ym === bestYearMatch && t.length < bestLen) { best = it; bestLen = t.length; }
        }
        return best;
    }

    private async _imdbTitleCandidates(type: 'movie' | 'series', ttId: string) {
        const out: { name: string; year: string | null }[] = [];
        const apiKey = this.options.tmdbApiKey;
        if (apiKey) { const tmdb = await resolveTmdbTitles(this.http, type, ttId, apiKey); if (tmdb) for (const n of tmdb.names) out.push({ name: n, year: tmdb.year }); }
        const cine = await resolveImdbTitle(this.http, type, ttId); if (cine?.name) out.push({ name: cine.name, year: cine.year });
        return out;
    }

    async getStreams(id: string) {
        if (id.startsWith('tt')) {
            const parts = id.split(':');
            if (parts.length >= 3) return this.getSeriesStreamsByImdb(parts[0], parseInt(parts[1], 10), parseInt(parts[2], 10));
            return this.getMovieStreamsByImdb(parts[0]);
        }
        if (id.startsWith(`game${this.idPrefix}_`)) {
            const info = this._decodeGameId(id);
            if (!info?.cs?.length) return [];
            const all: any[] = [];
            for (const cid of info.cs) for (const s of await this.getStreams(cid)) all.push(s);
            return all;
        }
        if (id.startsWith(`chg${this.idPrefix}_`)) {
            const key = this._decodeChannelGroupId(id);
            if (!key) return [];
            const { variants } = this._channelsForGroupKey(key);
            const all: any[] = [];
            for (const c of variants) for (const s of await this.getStreams(c.id)) all.push(s);
            return all;
        }
        if (id.startsWith(`vod${this.idPrefix}_`)) return this.getMovieStreams(id);
        if (id.startsWith(`epi${this.idPrefix}_`)) return this.getEpisodeStreams(id);
        const item = this.channelMap.get(id);
        if (!item) return [];
        const behaviorHints: any = { notWebReady: true };
        if (item.userAgent || item.referrer) {
            behaviorHints.proxyHeaders = { request: {} as Record<string, string> };
            if (item.userAgent) behaviorHints.proxyHeaders.request['User-Agent'] = item.userAgent;
            if (item.referrer) behaviorHints.proxyHeaders.request['Referer'] = item.referrer;
        }
        if (item.urls && item.urls.length) {
            return item.urls.map((url: string, i: number) => ({ url, title: item.urls.length > 1 ? `${item.name} - Link ${i + 1}` : `${item.name} - Live`, behaviorHints }));
        }
        const streams = [{ url: item.url, title: `${item.name} - Live`, behaviorHints }];
        const xtreamRe = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(\d+)$/;
        if (xtreamRe.test(item.url)) streams.unshift({ url: item.url + '.m3u8', title: `${item.name} - HLS`, behaviorHints });
        return streams;
    }

    getMovieStreams(id: string) {
        const m = this.movieMap.get(id); if (!m) return [];
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${m.streamId}.${m.ext || 'mp4'}`;
        return [{ url, title: `${m.name}${m.year ? ` (${m.year})` : ''}`, behaviorHints: { bingeGroup: `nexotv-vod-${this.idPrefix}` } }];
    }

    getEpisodeStreams(id: string) {
        const prefix = `epi${this.idPrefix}_`; const rest = id.slice(prefix.length);
        const sep = rest.lastIndexOf('__');
        const episodeId = sep >= 0 ? rest.slice(0, sep) : rest; const ext = sep >= 0 ? rest.slice(sep + 2) : 'mp4';
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${episodeId}.${ext}`;
        return [{ url, title: 'Assistir', behaviorHints: { bingeGroup: `nexotv-series-${this.idPrefix}` } }];
    }

    async getMovieStreamsByImdb(ttId: string) {
        const candidates = await this._imdbTitleCandidates('movie', ttId);
        let m: any = null;
        for (const c of candidates) { m = this._lookupByTitle(this.movieTitleIndex, this.movieTitleYearIndex, this.movies, c.name, c.year); if (m) break; }
        if (!m) return [];
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/movie/${xtreamUsername}/${xtreamPassword}/${m.streamId}.${m.ext || 'mp4'}`;
        return [{ url, title: `IPTV${m.year ? ` (${m.year})` : ''}`, behaviorHints: { bingeGroup: `nexotv-vod-${this.idPrefix}` } }];
    }

    async getSeriesStreamsByImdb(ttId: string, season: number, episode: number) {
        const candidates = await this._imdbTitleCandidates('series', ttId);
        let s: any = null;
        for (const c of candidates) { s = this._lookupByTitle(this.seriesTitleIndex, this.seriesTitleYearIndex, this.series, c.name, c.year); if (s) break; }
        if (!s) return [];
        const data = await this.getSeriesInfoCached(s.id, s.seriesId);
        const eps = data?.episodes?.[String(season)] || [];
        const ep = eps.find((e: any) => Number(e.episode_num) === episode);
        if (!ep) return [];
        const ext = (ep.container_extension || 'mp4').replace(/^\./, '');
        const { xtreamUrl, xtreamUsername, xtreamPassword } = this.config as any;
        const url = `${xtreamUrl}/series/${xtreamUsername}/${xtreamPassword}/${ep.id}.${ext}`;
        return [{ url, title: `IPTV — S${season}E${episode}`, behaviorHints: { bingeGroup: `nexotv-series-${this.idPrefix}` } }];
    }
}
