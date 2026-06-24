import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import type { AddonConfig, EngineOptions, NexoEngine } from '@nexotv/core';
import { createEngine, tmdbPoster } from './engineHost';

const LS_KEY = 'rajada.config.v1';

interface SavedConfig { config: AddonConfig; options: EngineOptions; }

function loadSaved(): SavedConfig | null {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

function Setup({ onSave }: { onSave: (s: SavedConfig) => void }) {
    const [mode, setMode] = useState<'xtream' | 'm3u'>('xtream');
    const [url, setUrl] = useState('');
    const [user, setUser] = useState('');
    const [pass, setPass] = useState('');
    const [m3u, setM3u] = useState('');
    const [epg, setEpg] = useState('');
    const [agenda, setAgenda] = useState('');
    const [tmdb, setTmdb] = useState('');
    const save = () => {
        const options: EngineOptions = { addonName: 'Rajada', sofascoreAgendaUrl: agenda.trim() || null, tmdbApiKey: tmdb.trim() || null };
        if (mode === 'xtream') {
            onSave({ config: { provider: 'xtream', xtreamUrl: url.trim(), xtreamUsername: user.trim(), xtreamPassword: pass.trim(), enableVod: true }, options });
        } else {
            onSave({ config: { provider: 'm3u', m3uUrl: m3u.trim(), epgUrl: epg.trim() || undefined }, options });
        }
    };
    return (
        <div className="setup">
            <h1 className="brand">RAJADA</h1>
            <div className="tabs">
                <button className={mode === 'xtream' ? 'on' : ''} onClick={() => setMode('xtream')}>Xtream</button>
                <button className={mode === 'm3u' ? 'on' : ''} onClick={() => setMode('m3u')}>Lista M3U</button>
            </div>
            {mode === 'xtream' ? (<>
                <input placeholder="URL (http://servidor.com)" value={url} onChange={e => setUrl(e.target.value)} />
                <input placeholder="Usuário" value={user} onChange={e => setUser(e.target.value)} />
                <input placeholder="Senha" type="password" value={pass} onChange={e => setPass(e.target.value)} />
            </>) : (<>
                <input placeholder="URL da lista M3U (http://…/get.php?…)" value={m3u} onChange={e => setM3u(e.target.value)} />
                <input placeholder="EPG URL (opcional)" value={epg} onChange={e => setEpg(e.target.value)} />
            </>)}
            <input placeholder="Agenda Futebol URL (opcional, Worker /agenda)" value={agenda} onChange={e => setAgenda(e.target.value)} />
            <input placeholder="TMDB API key (opcional, posters bonitos)" value={tmdb} onChange={e => setTmdb(e.target.value)} />
            <button onClick={save}>Entrar</button>
        </div>
    );
}

interface Row { id: string; type: string; name: string; metas: any[]; }
type Section = 'pick' | 'vod' | 'channels' | 'games';
// Lista plana de canais com divisores: 'header' marca o início de uma categoria,
// 'chan' é um canal. Permite zapear ↑↓ atravessando categorias (com divisor visível).
interface FlatItem { kind: 'header' | 'chan'; name: string; catId: string; meta?: any; }

function App() {
    const [saved, setSaved] = useState<SavedConfig | null>(loadSaved());
    const [engine, setEngine] = useState<NexoEngine | null>(null);
    const [status, setStatus] = useState('');
    const [section, setSection] = useState<Section>('pick');
    const [movieRows, setMovieRows] = useState<Row[]>([]);
    const [seriesRows, setSeriesRows] = useState<Row[]>([]);
    const [vodLoading, setVodLoading] = useState(false);
    const [chanCats, setChanCats] = useState<{ id: string; name: string; count: number; sample?: any }[]>([]);
    const [chanFlat, setChanFlat] = useState<FlatItem[]>([]);
    const [catFirst, setCatFirst] = useState<Record<string, number>>({});
    const [chanLoading, setChanLoading] = useState(false);
    const [gamesMetas, setGamesMetas] = useState<any[]>([]);
    const [gamesLoading, setGamesLoading] = useState(false);
    const [pickArt, setPickArt] = useState<{ vod?: string; tv?: string; live?: string }>({});
    const [picker, setPicker] = useState<{ title: string; options: { label: string; url: string }[] } | null>(null);
    const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
    const [cw, setCw] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem('rajada.cw.v1') || '[]'); } catch { return []; } });
    const homeRef = useRef<HTMLDivElement>(null);
    const builtRef = useRef({ vod: false, channels: false, games: false });

    const recordCw = (meta: any) => {
        setCw(prev => {
            const next = [{ id: meta.id, name: meta.name, poster: meta.poster, posterChain: meta.posterChain, posterShape: meta.posterShape, type: meta.type },
            ...prev.filter((x: any) => x.id !== meta.id)].slice(0, 20);
            localStorage.setItem('rajada.cw.v1', JSON.stringify(next));
            return next;
        });
    };
    const play = (url: string, title: string) => { setPicker(null); setPlaying({ url, title }); };

    // Filmes/séries: abre seletor de opções se houver mais de uma (tela cheia).
    const openItem = useCallback(async (meta: any) => {
        if (!engine) return;
        const streams = await engine.getStreams(meta.id);
        if (!streams.length) { setStatus('Sem stream disponível'); setTimeout(() => setStatus(''), 2500); return; }
        recordCw(meta);
        if (streams.length === 1) { play(streams[0].url, meta.name); return; }
        setPicker({ title: meta.name, options: streams.map((s: any) => ({ label: String(s.title || '').replace(/\s*-\s*Live$/i, '').trim() || meta.name, url: s.url })) });
    }, [engine]);

    // D-pad p/ as fileiras de filmes/séries (canais tem navegação própria).
    const onKey = useCallback((e: React.KeyboardEvent) => {
        const k = e.key;
        if (!k.startsWith('Arrow')) return;
        const root = homeRef.current; if (!root) return;
        const rowsEls = Array.from(root.querySelectorAll('.tiles')) as HTMLElement[];
        if (!rowsEls.length) return;
        const active = document.activeElement as HTMLElement;
        const focusIn = (row: HTMLElement, idx: number) => { const t = Array.from(row.querySelectorAll('.tile')) as HTMLElement[]; t[Math.max(0, Math.min(idx, t.length - 1))]?.focus(); };
        const ri = rowsEls.findIndex(r => r.contains(active));
        e.preventDefault();
        if (ri < 0) { focusIn(rowsEls[0], 0); }
        else {
            const tiles = Array.from(rowsEls[ri].querySelectorAll('.tile')) as HTMLElement[];
            const ci = tiles.indexOf(active);
            if (k === 'ArrowRight') tiles[Math.min(ci + 1, tiles.length - 1)]?.focus();
            else if (k === 'ArrowLeft') tiles[Math.max(ci - 1, 0)]?.focus();
            else if (k === 'ArrowDown') { if (rowsEls[ri + 1]) focusIn(rowsEls[ri + 1], ci); }
            else if (k === 'ArrowUp') { if (rowsEls[ri - 1]) focusIn(rowsEls[ri - 1], ci); }
        }
        setTimeout(() => (document.activeElement as HTMLElement)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), 0);
    }, []);

    // Liga a engine assim que há config salva.
    useEffect(() => {
        if (!saved || engine) return;
        let dead = false;
        (async () => {
            setStatus('Conectando…');
            try { const eng = await createEngine(saved.config, saved.options); if (!dead) { setEngine(eng); setStatus(''); } }
            catch (e: any) { if (!dead) setStatus('Erro: ' + (e?.message || e)); }
        })();
        return () => { dead = true; };
    }, [saved, engine]);

    const buildVod = useCallback(async (eng: NexoEngine, opts: EngineOptions) => {
        setVodLoading(true);
        const cats: any[] = eng.getManifest().catalogs;
        const pick = (id: string) => cats.find((c: any) => c.id === id);
        const buildRows = async (defs: any[]) => (await Promise.all(defs.filter(Boolean).map(async (c: any) => {
            try { const { metas } = await eng.getCatalog({ type: c.type, id: c.id }); return metas.length ? { id: c.id, type: c.type, name: c.name, metas: metas.slice(0, 30) } as Row : null; } catch { return null; }
        }))).filter(Boolean) as Row[];
        const mr = await buildRows([pick('nexotv_vod'), ...cats.filter((c: any) => c.id.startsWith('nexotv_vod_g_')).slice(0, 8)]);
        const sr = await buildRows([pick('nexotv_series'), ...cats.filter((c: any) => c.id.startsWith('nexotv_series_g_')).slice(0, 6)]);
        setMovieRows(mr); setSeriesRows(sr); setVodLoading(false);
        // Posters TMDB faltantes em 2º plano (estilo Stremio).
        if (opts.tmdbApiKey) {
            const targets: { id: string }[] = [];
            for (const r of [...mr, ...sr]) for (const m of r.metas) if (!m.poster || /placehold\.co/.test(m.poster)) targets.push({ id: m.id });
            let i = 0;
            const worker = async () => { while (i < targets.length) { const t = targets[i++]; const url = await eng.getTmdbPosterFor(t.id).catch(() => null); if (url) for (const r of [...mr, ...sr]) for (const m of r.metas) if (m.id === t.id) m.poster = url; } };
            await Promise.all(Array.from({ length: 4 }, worker));
            setMovieRows(mr.map(r => ({ ...r, metas: [...r.metas] }))); setSeriesRows(sr.map(r => ({ ...r, metas: [...r.metas] })));
        }
    }, []);

    const buildChannels = useCallback(async (eng: NexoEngine) => {
        setChanLoading(true);
        const cats: any[] = eng.getManifest().catalogs;
        // Só categorias de canais (os jogos têm seção própria agora).
        const defs = cats.filter((c: any) => c.id.startsWith('iptv_channels_g_'));
        const results = await Promise.all(defs.map(async (c: any) => {
            try { const { metas } = await eng.getCatalog({ type: c.type, id: c.id }); return { c, metas }; } catch { return { c, metas: [] as any[] }; }
        }));
        const flat: FlatItem[] = []; const first: Record<string, number> = {}; const cm: any[] = [];
        for (const { c, metas } of results) {
            if (!metas.length) continue;
            first[c.id] = flat.length;
            flat.push({ kind: 'header', name: c.name, catId: c.id });
            for (const m of metas) flat.push({ kind: 'chan', name: m.name, catId: c.id, meta: m });
            cm.push({ id: c.id, name: c.name, count: metas.length, sample: metas[0] });
        }
        setChanFlat(flat); setCatFirst(first); setChanCats(cm); setChanLoading(false);
    }, []);

    const buildGames = useCallback(async (eng: NexoEngine) => {
        setGamesLoading(true);
        try { const { metas } = await eng.getCatalog({ type: 'tv', id: 'nexotv_games' }); setGamesMetas(metas || []); }
        catch { setGamesMetas([]); }
        setGamesLoading(false);
    }, []);

    // Constrói a seção ao entrar nela (uma vez).
    useEffect(() => {
        if (!engine || !saved) return;
        if (section === 'vod' && !builtRef.current.vod) { builtRef.current.vod = true; buildVod(engine, saved.options); }
        if (section === 'channels' && !builtRef.current.channels) { builtRef.current.channels = true; buildChannels(engine); }
        if (section === 'games' && !builtRef.current.games) { builtRef.current.games = true; buildGames(engine); }
    }, [section, engine, saved, buildVod, buildChannels, buildGames]);

    // Arte cinematográfica dos cards (estilo Netflix): backdrop real de um filme da
    // biblioteca + foto de futebol (TMDB). Em 2º plano — cards mostram o gradiente até lá.
    useEffect(() => {
        if (!engine) return;
        let dead = false;
        (async () => {
            let vod: string | undefined;
            try {
                const cats: any[] = engine.getManifest().catalogs;
                const c = cats.find((x: any) => x.id === 'nexotv_vod');
                if (c) {
                    const { metas } = await engine.getCatalog({ type: c.type, id: c.id });
                    // pôster retrato real (encaixa no card 2:3)
                    const withP = metas.find((m: any) => m.poster && !/placehold/.test(m.poster));
                    if (withP) vod = withP.poster;
                    else if (metas[0]) vod = (await engine.getTmdbPosterFor(metas[0].id).catch(() => null)) || undefined;
                }
            } catch { /* fallback gradiente */ }
            const tv = (await tmdbPoster('jornal nacional').catch(() => null)) || (await tmdbPoster('telejornal').catch(() => null)) || undefined;
            const live = (await tmdbPoster('Pelé').catch(() => null)) || (await tmdbPoster('Ronaldo').catch(() => null))
                || (await tmdbPoster('Maradona').catch(() => null)) || (await tmdbPoster('Quero ser campeão').catch(() => null)) || undefined;
            if (!dead) setPickArt({ vod, tv, live });
        })();
        return () => { dead = true; };
    }, [engine]);

    const logout = () => { localStorage.removeItem(LS_KEY); setSaved(null); setEngine(null); setSection('pick'); builtRef.current = { vod: false, channels: false, games: false }; };

    if (!saved) return <Setup onSave={(s) => { localStorage.setItem(LS_KEY, JSON.stringify(s)); setSaved(s); }} />;
    if (section === 'pick') return <PickScreen onPick={setSection} onLogout={logout} status={!engine ? (status || 'Conectando…') : ''} art={pickArt} />;

    const cwAll = cw.filter((m: any) => m.type === 'movie' || m.type === 'series');

    return (
        <div className={`home ${section}`} ref={homeRef} onKeyDown={section === 'channels' ? undefined : onKey}>
            <header className="topbar">
                <button className="brand-sm" onClick={() => setSection('pick')}>RAJADA</button>
                <nav className="tabs-top">
                    <button className={section === 'vod' ? 'on' : ''} onClick={() => setSection('vod')}>Filmes e Séries</button>
                    <button className={section === 'channels' ? 'on' : ''} onClick={() => setSection('channels')}>Canais</button>
                    <button className={section === 'games' ? 'on' : ''} onClick={() => setSection('games')}>Jogos ao vivo</button>
                </nav>
                <button className="logout" onClick={logout}>sair</button>
            </header>

            {status && <div className="status">{status}</div>}

            {section === 'vod' && !engine && <div className="connecting"><span className="spin" /> Conectando ao provedor…</div>}
            {section === 'vod' && engine && (
                vodLoading && !movieRows.length && !seriesRows.length
                    ? <div className="connecting"><span className="spin" /> Carregando catálogo…</div>
                    : <VodView engine={engine} movieRows={movieRows} seriesRows={seriesRows} cwAll={cwAll} onOpen={openItem} />
            )}
            {section === 'channels' && (engine
                ? <ChannelsView engine={engine} cats={chanCats} flat={chanFlat} loading={chanLoading} />
                : <div className="connecting"><span className="spin" /> Conectando ao provedor…</div>)}
            {section === 'games' && (engine
                ? <GamesView engine={engine} metas={gamesMetas} loading={gamesLoading} />
                : <div className="connecting"><span className="spin" /> Conectando ao provedor…</div>)}

            {picker && (
                <div className="modal" onClick={() => setPicker(null)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <h3>{picker.title}</h3>
                        <p className="modal-sub">Escolha a opção</p>
                        <div className="opts">
                            {picker.options.map((o, i) => (<button key={i} className="opt" onClick={() => play(o.url, o.label)}>{o.label}</button>))}
                        </div>
                        <button className="modal-close" onClick={() => setPicker(null)}>fechar</button>
                    </div>
                </div>
            )}

            {playing && <Player url={playing.url} title={playing.title} onClose={() => setPlaying(null)} />}
        </div>
    );
}

/** Tela inicial estilo Netflix: pirâmide invertida (2 billboards em cima + 1
 *  embaixo), cada um com BACKDROP real, gradiente forte e tipografia premium. */
function PickScreen({ onPick, onLogout, status, art }: { onPick: (s: Section) => void; onLogout: () => void; status: string; art: { vod?: string; tv?: string; live?: string } }) {
    const Card = (sec: Section, cls: string, bg: string | undefined, label: string, sub: string, ao: boolean) => (
        <button className={`pick-card ${cls}`} onClick={() => onPick(sec)} style={bg ? { backgroundImage: `url("${bg}")` } : undefined}>
            <div className="pc-grad" />
            {ao && <span className="pc-live">● AO VIVO</span>}
            <span className="pc-play">▶</span>
            <div className="pc-foot"><span className="pc-label">{label}</span><span className="pc-sub2">{sub}</span></div>
        </button>
    );
    return (
        <div className="pick">
            <header className="pick-top"><span className="brand-sm">RAJADA</span><button className="logout" onClick={onLogout}>sair</button></header>
            <div className="pick-body">
                <h2 className="pick-sub">O que você quer assistir?</h2>
                <div className="pick-cards">
                    {Card('vod', 'pc-vod', art.vod, 'Filmes e Séries', 'Catálogo completo', false)}
                    {Card('channels', 'pc-channels', art.tv, 'Canais', 'TV agora', false)}
                    {Card('games', 'pc-games', art.live, 'Jogos ao vivo', 'Acontecendo e próximos', true)}
                </div>
                {status && <div className="status">{status}</div>}
            </div>
        </div>
    );
}

// --- Jogos: parsing + visual estilo Netflix --------------------------------
// Extrai os dados de um jogo do meta (name="Home x Away", releaseInfo="QUANDO - canal").
function parseGame(m: any): { home: string; away: string; comp: string; live: boolean; when: string; chans: string[] } {
    const raw = (m.name || '').replace(/^\[AO VIVO\]\s*/i, '').trim();
    const parts = raw.split(/\s+x\s+/i);
    const home = (parts[0] || raw).trim();
    const away = (parts[1] || '').trim();
    const info = (m.releaseInfo || m.description || '').split('\n')[0];
    const segs = info.split(' - ');
    const when = (segs[0] || '').trim();
    const tail = (segs.slice(1).join(' - ') || '').trim();
    const clean = (s: string) => s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
    const chans = (Array.isArray(m.genres) && m.genres.length ? m.genres.filter(Boolean)
        : (tail && !/transmiss/i.test(tail) ? [tail] : [])).map(clean).filter(Boolean);
    return { home, away, comp: (m.tournament || '').trim(), live: !!m.live, when, chans };
}
// Sigla de 3 letras a partir do nome do time (fallback de escudo).
function teamSigla(name: string): string {
    const words = (name || '').replace(/[^A-Za-zÀ-ÿ ]/g, '').split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}
// Cor determinística por time (gradiente do escudo) — variedade consistente.
function teamColor(name: string): string {
    let h = 0; for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 62% 42%)`;
}
function Crest({ name }: { name: string }) {
    const c = teamColor(name);
    return <span className="g-crest" style={{ background: `linear-gradient(145deg, ${c}, rgba(0,0,0,.55))` }}>{teamSigla(name)}</span>;
}
function GameCard({ meta, onPlay, hero }: { meta: any; onPlay: () => void; hero?: boolean }) {
    const g = parseGame(meta);
    return (
        <button className={'game-card' + (hero ? ' g-hero' : '') + (g.live ? ' live' : '')} onClick={onPlay} title={meta.name}>
            <span className="g-top">
                {g.comp && <span className="g-comp">{g.comp}</span>}
                {g.live ? <span className="g-livepill"><i /> AO VIVO</span> : <span className="g-when">{g.when}</span>}
            </span>
            <span className="g-match">
                <span className="g-team"><Crest name={g.home} /><b>{g.home}</b></span>
                <span className="g-vs">VS</span>
                <span className="g-team"><Crest name={g.away} /><b>{g.away || '—'}</b></span>
            </span>
            <span className="g-bottom">
                {g.chans.length ? g.chans.slice(0, 3).map((c, i) => <span className="g-chan" key={i}>{c}</span>)
                    : <span className="g-chan ghost">Transmissão</span>}
                {hero && <span className="g-watch">{g.live ? '▶ Assistir agora' : '▶ Detalhes'}</span>}
            </span>
        </button>
    );
}
// Emoji por competição (toque visual nos títulos das fileiras).
function compEmoji(name: string): string {
    const n = name.toLowerCase();
    if (/copa do mundo|world cup/.test(n)) return '🏆';
    if (/copa am[eé]rica/.test(n)) return '🌎';
    if (/libertadores/.test(n)) return '🥇';
    if (/sul-?americana/.test(n)) return '🏅';
    if (/champions|liga dos campe/.test(n)) return '⭐';
    if (/brasileir|série a|serie a/.test(n)) return '🇧🇷';
    if (/premier|inglesa/.test(n)) return '🏴';
    if (/espanhol|la liga/.test(n)) return '🇪🇸';
    return '⚽';
}

// Marca do provedor a partir do título cru (ex.: "Globo Bahia Santa Cruz [FHD]"
// → "Globo", "CAZE TV 1 [HD]" → "CazeTV", "Premiere 2" → "Premiere"). Agrupa
// variantes regionais e qualidades numa opção só, limpando a barra.
const PROVIDER_BRANDS = ['Premiere', 'SporTV', 'Combate', 'Globoplay', 'Globo+', 'Globo', 'SBT', 'CazeTV', 'Caze', 'ESPN', 'DAZN', 'Disney+', 'Star+', 'Paramount+', 'TNT Sports', 'TNT', 'Record', 'Band', 'Amazon', 'Apple'];
function providerBrand(title: string): string {
    const s = String(title || '').replace(/\[[^\]]*\]/g, '').replace(/\s*-\s*Live$/i, '').trim();
    const low = s.toLowerCase().replace(/\s+/g, '');
    for (const b of PROVIDER_BRANDS) if (low.includes(b.toLowerCase().replace(/\s+/g, ''))) return b === 'Caze' ? 'CazeTV' : b;
    return s.split(/\s+/)[0] || s || 'Opção';
}
function qualityRank(title: string): number {
    const t = String(title || '');
    if (/fhd|1080/i.test(t)) return 3; if (/\bhd\b|720/i.test(t)) return 2; if (/\bsd\b|480/i.test(t)) return 1; return 0;
}
// Agrupa streams por marca, MAS mantém todos os feeds de cada marca (ordenados
// pela melhor qualidade) — viram a cadeia de fallback automático do player.
function dedupStreams(streams: any[]): { label: string; urls: string[] }[] {
    const groups = new Map<string, { label: string; items: { url: string; q: number }[] }>();
    for (const s of streams || []) {
        if (!s?.url) continue;
        const b = providerBrand(s.title || '');
        if (!groups.has(b)) groups.set(b, { label: b, items: [] });
        groups.get(b)!.items.push({ url: s.url, q: qualityRank(s.title || '') });
    }
    return [...groups.values()].map(g => ({
        label: g.label,
        urls: [...new Set(g.items.sort((a, b) => b.q - a.q).map(x => x.url))],
    }));
}
// Rola o chip focado pra dentro da vista (D-pad na TV / Tab na web).
const focusScroll = (e: React.FocusEvent) => e.currentTarget.scrollIntoView({ inline: 'center', block: 'nearest' });

// Agrupa os jogos: ao vivo → próximos (hoje+amanhã) → por competição. Tudo
// ordenado por data (mais cedo primeiro); competição ordenada pelo jogo + cedo.
function groupGames(metas: any[]): { live: any[]; upcoming: any[]; ordered: [string, any[]][] } {
    const now = Date.now();
    const byTime = (a: any, b: any) => (a.startMs || 0) - (b.startMs || 0);
    // Próximo primeiro: jogos por vir (por data), e os já passados no fim.
    const byNextFirst = (a: any, b: any) => {
        const pa = (a.startMs || 0) < now ? 1 : 0, pb = (b.startMs || 0) < now ? 1 : 0;
        return pa - pb || byTime(a, b);
    };
    const live = metas.filter(m => m.live);
    const rest = metas.filter(m => !m.live);
    // Janela "próximos": de hoje 00h até o fim de amanhã.
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const from = today0.getTime(); const to = from + 2 * 86400000;
    const upcoming = rest.filter(m => (m.startMs || 0) >= from && (m.startMs || 0) < to).sort(byTime);
    const groups = new Map<string, any[]>();
    for (const m of rest) { const k = (m.tournament || '').trim() || 'Outros jogos'; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(m); }
    for (const list of groups.values()) list.sort(byNextFirst);
    // Chave de ordenação da competição = data do PRÓXIMO jogo dela (ignora os que
    // já passaram); se todos passaram, usa o último.
    const nextOf = (list: any[]) => { const f = list.find(m => (m.startMs || 0) >= now); return f ? f.startMs : (list[list.length - 1]?.startMs || 0); };
    const ordered = [...groups.entries()].sort((a, b) => {
        if (a[0] === 'Outros jogos') return 1; if (b[0] === 'Outros jogos') return -1;
        return nextOf(a[1]) - nextOf(b[1]);
    });
    return { live, upcoming, ordered };
}

/** Jogos ao vivo: grade (hero + fileiras por competição) → ao clicar, abre o
 *  GameStage (player + lista lateral pra trocar de jogo), igual aos Canais. */
function GamesView({ engine, metas, loading }: { engine: NexoEngine; metas: any[]; loading: boolean }) {
    const [watch, setWatch] = useState<any | null>(null);
    if (loading && !metas.length) return <div className="status">Carregando jogos…</div>;
    if (!loading && !metas.length) return <div className="status">Nenhum jogo encontrado agora. Confira mais tarde.</div>;
    if (watch) return <GameStage engine={engine} metas={metas} start={watch} onBack={() => setWatch(null)} />;
    const { live, upcoming, ordered } = groupGames(metas);
    const featured = live[0] || upcoming[0] || metas[0];   // hero: ao vivo, senão o mais cedo
    const liveRest = featured && featured.live ? live.slice(1) : live;
    const up = upcoming.filter((m: any) => m !== featured);
    const grpFiltered = ordered.map(([n, l]) => [n, l.filter((m: any) => m !== featured)] as [string, any[]]).filter(([, l]) => l.length);
    return (
        <div className="games-grid">
            {featured && (
                <div className="games-hero">
                    <GameCard meta={featured} onPlay={() => setWatch(featured)} hero />
                </div>
            )}
            {liveRest.length > 0 && (
                <section className="row"><h2><span className="dot-live" /> Ao vivo agora</h2>
                    <div className="tiles">{liveRest.map((m: any) => <GameCard key={m.id} meta={m} onPlay={() => setWatch(m)} />)}</div>
                </section>
            )}
            {up.length > 0 && (
                <section className="row"><h2>⏰ Próximos jogos</h2>
                    <div className="tiles">{up.map((m: any) => <GameCard key={'up' + m.id} meta={m} onPlay={() => setWatch(m)} />)}</div>
                </section>
            )}
            {grpFiltered.map(([name, list]) => (
                <section className="row" key={name}><h2>{compEmoji(name)} {name}</h2>
                    <div className="tiles">{list.map((m: any) => <GameCard key={m.id} meta={m} onPlay={() => setWatch(m)} />)}</div>
                </section>
            ))}
        </div>
    );
}

// Linha de jogo na lista lateral do GameStage (escudos + times + status).
function GameRow({ meta }: { meta: any }) {
    const g = parseGame(meta);
    return (
        <span className="gr-body">
            <Crest name={g.home} />
            <span className="gr-info">
                <span className="gr-teams">{g.home} <i>×</i> {g.away || '—'}</span>
                <span className="gr-meta">{g.live ? <em className="gr-live">● AO VIVO</em> : g.when}{g.comp ? ' · ' + g.comp : ''}</span>
            </span>
        </span>
    );
}

/** Player de jogo + lista lateral pra trocar de jogo (zapping ↑↓) e de
 *  transmissão (qualidade/canal). Mesmo layout dos Canais. */
function GameStage({ engine, metas, start, onBack }: { engine: NexoEngine; metas: any[]; start: any; onBack: () => void }) {
    const [idx, setIdx] = useState(-1);
    const [sources, setSources] = useState<string[]>([]); // cadeia de fontes da marca atual (failover)
    const [title, setTitle] = useState('');
    const [opts, setOpts] = useState<any[]>([]);
    const [note, setNote] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const timer = useRef<any>(null);
    const started = useRef(false);

    // Lista plana com divisores (ao vivo + por competição) — espelha a dos canais.
    const gflat = useMemo(() => {
        const { live, upcoming, ordered } = groupGames(metas);
        const out: { kind: 'header' | 'game'; name: string; meta?: any; live?: boolean; icon?: string }[] = [];
        if (live.length) { out.push({ kind: 'header', name: 'Ao vivo agora', live: true }); live.forEach(m => out.push({ kind: 'game', name: m.name, meta: m })); }
        if (upcoming.length) { out.push({ kind: 'header', name: 'Próximos jogos', icon: '⏰' }); upcoming.forEach(m => out.push({ kind: 'game', name: m.name, meta: m })); }
        ordered.forEach(([name, list]) => { out.push({ kind: 'header', name }); list.forEach(m => out.push({ kind: 'game', name: m.name, meta: m })); });
        return out;
    }, [metas]);
    const gameIdxs = useMemo(() => { const a: number[] = []; gflat.forEach((f, i) => { if (f.kind === 'game') a.push(i); }); return a; }, [gflat]);

    const loadStream = useCallback(async (i: number) => {
        const it = gflat[i]; if (!it || it.kind !== 'game') return;
        const g = parseGame(it.meta);
        setTitle(`${g.home} × ${g.away || ''}`.trim()); setNote('');
        try {
            const streams = await engine.getStreams(it.meta.id);
            setOpts(streams); setSources(dedupStreams(streams)[0]?.urls || []);
            if (!streams.length) setNote(g.live ? 'Transmissão indisponível no momento.' : `Começa ${g.when}.`);
        } catch { setOpts([]); setSources([]); setNote('Não foi possível carregar a transmissão.'); }
    }, [engine, gflat]);

    const select = useCallback((i: number, now = false) => {
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 380);
        setTimeout(() => scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }, [loadStream]);

    // Entra já no jogo clicado.
    useEffect(() => {
        if (started.current || !gflat.length) return;
        started.current = true;
        const si = gflat.findIndex(f => f.kind === 'game' && f.meta === start);
        select(si >= 0 ? si : (gameIdxs[0] ?? 0), true);
    }, [gflat, gameIdxs, start, select]);

    const move = (dir: 1 | -1) => {
        const pos = gameIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(gameIdxs.length - 1, pos + dir));
        select(gameIdxs[np]);
    };
    const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); onBack(); }
    };

    return (
        <div className="chan-live" ref={stageRef} tabIndex={0} onKeyDown={onKey}>
            <aside className="chan-list">
                <div className="chan-list-head">
                    <button className="back" onClick={onBack}>‹ Voltar</button>
                    <span className="cur-cat">Jogos</span>
                </div>
                <div className="chan-scroll" ref={scrollRef}>
                    {gflat.map((f, i) => f.kind === 'header' ? (
                        <div className="chan-divider" key={'h' + i}><span>{f.live ? <><span className="dot-live" /> {f.name}</> : <>{f.icon || compEmoji(f.name)} {f.name}</>}</span></div>
                    ) : (
                        <button key={i} data-i={i} className={`chan-row game-row${i === idx ? ' on' : ''}`} onClick={() => select(i, true)}>
                            <GameRow meta={f.meta} />
                        </button>
                    ))}
                </div>
            </aside>
            <main className="chan-stage">
                <LivePlayer sources={sources} title={title} />
                <div className="chan-now">
                    <span className="now-title">{title || 'Selecione um jogo'}{note && <em className="now-note"> — {note}</em>}</span>
                    {(() => { const ds = dedupStreams(opts); return ds.length > 1 && (
                        <div className="now-opts">
                            {ds.map((o, i) => (
                                <button key={i} className={`now-opt${o.urls[0] === sources[0] ? ' on' : ''}`} onClick={() => setSources(o.urls)} onFocus={focusScroll}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    ); })()}
                </div>
            </main>
        </div>
    );
}

// Histórico local de canais assistidos (pra seção "Mais assistidos").
const WATCH_KEY = 'rajada.chanwatch.v1';
function loadWatch(): Record<string, number> { try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '{}'); } catch { return {}; } }
// Ranking de popularidade (semente p/ "Mais assistidos" sem histórico). O 1º = mais
// popular. O uso real do usuário (watch) sobrepõe isso com o tempo.
const POPULAR_CHANNELS = [
    'globo', 'sportv', 'premiere', 'espn', 'sbt', 'record', 'band', 'globonews', 'cnn', 'multishow',
    'telecine', 'tnt', 'combate', 'cazetv', 'caze', 'dazn', 'disney', 'hbo', 'max', 'warner',
    'discovery', 'national geographic', 'natgeo', 'history', 'cartoon', 'gloob', 'fox', 'paramount', 'star', 'a&e',
];
function popularRank(name: string): number {
    const n = (name || '').toLowerCase();
    for (let k = 0; k < POPULAR_CHANNELS.length; k++) if (n.includes(POPULAR_CHANNELS[k])) return POPULAR_CHANNELS.length - k;
    return 0;
}

/** Canais ao vivo: escolhe categoria → lista de canais + player ao lado. Zapeia
 *  ↑↓ atravessando categorias (divisor mostra onde cada uma acaba). Voltar volta
 *  pras categorias. */
function ChannelsView({ engine, cats, flat, loading }: {
    engine: NexoEngine; cats: { id: string; name: string; count: number; sample?: any }[]; flat: FlatItem[]; loading: boolean;
}) {
    const [mode, setMode] = useState<'cats' | 'channels'>('channels'); // entra nos canais (já tocando)
    const [idx, setIdx] = useState(-1);          // índice (no vflat) do canal selecionado
    const [sources, setSources] = useState<string[]>([]); // cadeia de fontes da marca atual (failover)
    const [title, setTitle] = useState('');
    const [opts, setOpts] = useState<any[]>([]);
    const [watch] = useState<Record<string, number>>(loadWatch); // snapshot do histórico (não reembaralha na sessão)
    const scrollRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const timer = useRef<any>(null);
    const started = useRef(false);

    const label = (n: string) => (n || '').replace(/^Canais\s*\|\s*/i, '').trim() || n;

    // Lista de exibição: prepend "Mais assistidos" (pelo histórico local) se houver.
    const { vflat, vcats, vCatFirst } = useMemo(() => {
        // score = uso real (peso alto) + popularidade conhecida (semente)
        const score = (f: FlatItem) => (watch[f.meta.name] || 0) * 1000 + popularRank(f.meta.name);
        const seen = new Set<string>(); const top: FlatItem[] = [];
        flat.filter(f => f.kind === 'chan')
            .slice().sort((a, b) => score(b) - score(a))
            .forEach(f => { if (score(f) > 0 && !seen.has(f.meta.name) && top.length < 12) { seen.add(f.meta.name); top.push(f); } });
        let vflat = flat; let vcats = cats;
        if (top.length) {
            vflat = [{ kind: 'header', name: 'Mais assistidos', catId: '__top' } as FlatItem, ...top, ...flat];
            vcats = [{ id: '__top', name: 'Mais assistidos', count: top.length }, ...cats];
        }
        const vCatFirst: Record<string, number> = {};
        vflat.forEach((f, i) => { if (f.kind === 'header' && !(f.catId in vCatFirst)) vCatFirst[f.catId] = i; });
        return { vflat, vcats, vCatFirst };
    }, [flat, cats, watch]);

    const chanIdxs = useMemo(() => { const a: number[] = []; vflat.forEach((f, i) => { if (f.kind === 'chan') a.push(i); }); return a; }, [vflat]);

    const loadStream = useCallback(async (i: number) => {
        const it = vflat[i]; if (!it || it.kind !== 'chan') return;
        setTitle(it.meta.name);
        // conta como assistido (histórico p/ "Mais assistidos") — persiste sem reembaralhar agora
        try { const w = loadWatch(); w[it.meta.name] = (w[it.meta.name] || 0) + 1; localStorage.setItem(WATCH_KEY, JSON.stringify(w)); } catch { }
        try { const streams = await engine.getStreams(it.meta.id); setOpts(streams); setSources(dedupStreams(streams)[0]?.urls || []); }
        catch { setOpts([]); setSources([]); }
    }, [engine, vflat]);

    const select = useCallback((i: number, now = false) => {
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 380);  // debounce no zapping
        setTimeout(() => scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }, [loadStream]);

    // Entra já tocando o 1º canal (o mais assistido, se houver histórico).
    useEffect(() => {
        if (started.current || !chanIdxs.length) return;
        started.current = true; select(chanIdxs[0], true);
    }, [chanIdxs, select]);

    const pickCat = (catId: string) => {
        const h = vCatFirst[catId]; if (h == null) return;
        let fc = -1;
        for (let i = h + 1; i < vflat.length; i++) { if (vflat[i].kind === 'chan') { fc = i; break; } if (vflat[i].kind === 'header') break; }
        setMode('channels');
        if (fc >= 0) select(fc, true);
        setTimeout(() => stageRef.current?.focus(), 30);
    };

    const move = (dir: 1 | -1) => {
        const pos = chanIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(chanIdxs.length - 1, pos + dir));
        select(chanIdxs[np]);
    };
    const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); setMode('cats'); }
    };

    const curCatName = idx >= 0 ? label(vcats.find(c => c.id === vflat[idx]?.catId)?.name || '') : '';

    if (loading && !flat.length) return <div className="status">Carregando canais…</div>;
    if (!loading && !flat.length) return <div className="status">Nenhum canal (provedor fora do ar?)</div>;

    const inCats = mode === 'cats';
    return (
        <div className="chan-live" ref={stageRef} tabIndex={0} onKeyDown={onKey}>
            <aside className="chan-list">
                <div className="chan-list-head">
                    <button className={`back${inCats ? ' on' : ''}`} onClick={() => setMode(inCats ? 'channels' : 'cats')}>
                        {inCats ? '‹ Voltar' : '☰ Categorias'}
                    </button>
                    <span className="cur-cat">{inCats ? 'Escolha uma categoria' : curCatName}</span>
                </div>
                <div className="chan-scroll" ref={scrollRef}>
                    {inCats ? (
                        vcats.map(c => (
                            <button key={c.id} className={`cat-row${vflat[idx]?.catId === c.id ? ' on' : ''}`} onClick={() => pickCat(c.id)}>
                                <span className="cat-row-name">{label(c.name)}</span>
                                <span className="cat-row-count">{c.count}</span>
                            </button>
                        ))
                    ) : (
                        vflat.map((f, i) => f.kind === 'header' ? (
                            <div className="chan-divider" key={'h' + i}><span>{label(f.name)}</span></div>
                        ) : (
                            <button key={i} data-i={i} className={`chan-row${i === idx ? ' on' : ''}`} onClick={() => select(i, true)}>
                                <img className="chan-ico" alt="" loading="lazy"
                                    src={(Array.isArray(f.meta.posterChain) && f.meta.posterChain[0]) || f.meta.poster || cardFor(f.meta.name)}
                                    onError={(e) => { const c = cardFor(f.meta.name); if (e.currentTarget.src !== c) e.currentTarget.src = c; }} />
                                <span className="chan-name">{f.meta.name}</span>
                            </button>
                        ))
                    )}
                </div>
            </aside>
            <main className="chan-stage">
                <LivePlayer sources={sources} title={title} />
                <div className="chan-now">
                    <span className="now-title">{title || 'Selecione um canal'}</span>
                    {(() => { const ds = dedupStreams(opts); return ds.length > 1 && (
                        <div className="now-opts">
                            {ds.map((o, i) => (
                                <button key={i} className={`now-opt${o.urls[0] === sources[0] ? ' on' : ''}`} onClick={() => setSources(o.urls)} onFocus={focusScroll}>
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    ); })()}
                </div>
            </main>
        </div>
    );
}

/** Player embutido (canais/jogos ao vivo): recebe a CADEIA de fontes daquela
 *  marca (várias regionais/qualidades) e faz failover automático — se uma falha,
 *  já tenta a próxima sozinho. Troca de fonte ao zapear, sem fechar. */
function LivePlayer({ sources, title }: { sources: string[]; title: string }) {
    const ref = useRef<HTMLVideoElement>(null);
    const [i, setI] = useState(0);          // fonte atual dentro da cadeia
    const [dead, setDead] = useState(false); // todas as fontes falharam
    // Nova seleção (canal/jogo/marca) → recomeça da melhor fonte.
    useEffect(() => { setI(0); setDead(false); }, [sources]);
    const url = sources[i] || '';
    useEffect(() => {
        const v = ref.current; if (!v || !url) return;
        let cancelled = false;
        const next = () => { if (cancelled) return; if (i < sources.length - 1) setI(i + 1); else setDead(true); };
        const isHls = /\.m3u8(\?|$)|\.ts(\?|$)/i.test(url) || url.includes('/live/');
        let hls: Hls | null = null;
        if (isHls && Hls.isSupported()) {
            hls = new Hls({ enableWorker: true, lowLatencyMode: false });
            hls.loadSource(url); hls.attachMedia(v);
            hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) next(); });
        } else { v.src = url; v.addEventListener('error', next, { once: true }); }
        const p = v.play(); if (p && p.catch) p.catch(() => { });
        return () => { cancelled = true; try { hls?.destroy(); } catch { } };
    }, [url, i, sources]);
    const trying = i > 0 && !dead;
    return (
        <div className="live-player">
            <video ref={ref} controls autoPlay playsInline className="live-video" />
            {!sources.length && <div className="live-empty">▶ Selecione um canal na lista</div>}
            {trying && <div className="live-fallback">Fonte instável — tentando alternativa {i + 1}/{sources.length}…</div>}
            {dead && sources.length > 0 && (<div className="player-err">Nenhuma fonte respondeu.<button onClick={() => window.open(sources[sources.length - 1], '_blank')}>Abrir externo</button></div>)}
        </div>
    );
}

/** Player em tela cheia: HLS via hls.js; senão <video> nativo; fallback "abrir externo". */
function Player({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
    const ref = useRef<HTMLVideoElement>(null);
    const [err, setErr] = useState(false);
    useEffect(() => {
        const v = ref.current; if (!v) return;
        const isHls = /\.m3u8(\?|$)|\.ts(\?|$)/i.test(url) || url.includes('/live/');
        let hls: Hls | null = null;
        if (isHls && Hls.isSupported()) {
            hls = new Hls({ enableWorker: true, lowLatencyMode: false });
            hls.loadSource(url);
            hls.attachMedia(v);
            hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setErr(true); });
        } else {
            v.src = url; // mp4 / Safari-HLS nativo
            v.addEventListener('error', () => setErr(true), { once: true });
        }
        const p = v.play(); if (p && p.catch) p.catch(() => { });
        return () => { try { hls?.destroy(); } catch { } };
    }, [url]);
    return (
        <div className="player" onClick={onClose}>
            <div className="player-box" onClick={e => e.stopPropagation()}>
                <div className="player-bar"><span>{title}</span><button onClick={onClose}>✕</button></div>
                <video ref={ref} controls autoPlay playsInline className="player-video" />
                {err && (
                    <div className="player-err">
                        Não consegui tocar aqui.
                        <button onClick={() => window.open(url, '_blank')}>Abrir externo</button>
                    </div>
                )}
            </div>
        </div>
    );
}

// Forma decidida pelo TIPO de conteúdo (não confia só no posterShape, que pode vir
// faltando): canal/tv = quadrado, jogo = landscape, filme/série = pôster 2:3.
function shapeFor(meta: any): 'square' | 'landscape' | 'poster' {
    if (meta.posterShape === 'square' || meta.posterShape === 'landscape' || meta.posterShape === 'poster') return meta.posterShape;
    if (meta.type === 'tv') return 'square';
    if (typeof meta.id === 'string' && meta.id.startsWith('game')) return 'landscape';
    return 'poster';
}
// Card gerado (cor determinística pelo nome) como último recurso se a imagem falhar.
function cardFor(name: string) {
    const s = name || 'TV'; let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const pal = ['1f3a5f', '3a1f5f', '5f1f2e', '1f5f3a', '5f4a1f', '2e1f5f', '1f5f5a', '5f1f4a', '24304a', '402a2a'];
    return `https://placehold.co/320x320/${pal[h % pal.length]}/FFFFFF.png?text=${encodeURIComponent(s)}&font=oswald`;
}
// Nota IMDb numérica (string "7.8" → 7.8) p/ ordenar destaques.
function ratingNum(m: any): number { const r = parseFloat(m?.imdbRating); return isFinite(r) ? r : 0; }

/** Filmes e Séries estilo Netflix + board estilo Stremio: ao focar um título,
 *  o board do topo mostra backdrop, nota IMDb, ano, duração, gêneros, sinopse e
 *  elenco (detalhes sob demanda, com cache). Fileira "Em alta" + auto-rotação. */
function VodView({ engine, movieRows, seriesRows, cwAll, onOpen }: {
    engine: NexoEngine; movieRows: Row[]; seriesRows: Row[]; cwAll: any[]; onOpen: (m: any) => void;
}) {
    const [focused, setFocused] = useState<any | null>(null);
    const [detail, setDetail] = useState<any | null>(null);
    const cache = useRef<Map<string, any>>(new Map());
    const timer = useRef<any>(null);
    const interacted = useRef(false);
    const [spin, setSpin] = useState(0); // índice da auto-rotação (billboard ocioso)

    // Destaques: bem avaliados (nota desc), únicos. Semeia o board e a fileira.
    const featured = useMemo(() => {
        const all = [...movieRows, ...seriesRows].flatMap(r => r.metas);
        const seen = new Set<string>(); const list: any[] = [];
        all.filter(m => ratingNum(m) > 0).sort((a, b) => ratingNum(b) - ratingNum(a))
            .forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); list.push(m); } });
        // Se quase nada tem nota, cai pros primeiros do catálogo (mais novos).
        if (list.length < 6) for (const m of all) { if (!seen.has(m.id)) { seen.add(m.id); list.push(m); } if (list.length >= 12) break; }
        return list.slice(0, 14);
    }, [movieRows, seriesRows]);

    // Busca detalhes (backdrop/elenco/duração) sob demanda, com cache + debounce.
    const focus = useCallback((m: any) => {
        interacted.current = true; setFocused(m);
        clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            if (cache.current.has(m.id)) { setDetail(cache.current.get(m.id)); return; }
            setDetail(null);
            try { const d = await engine.getDetailedMeta(m.id); if (d) { cache.current.set(m.id, d); setDetail(d); } }
            catch { /* mantém o que veio do catálogo */ }
        }, 180);
    }, [engine]);

    // Billboard ocioso: roda entre os destaques a cada 6s até o usuário interagir.
    useEffect(() => {
        if (!featured.length) return;
        const t = setInterval(() => { if (!interacted.current) setSpin(s => (s + 1) % Math.min(5, featured.length)); }, 6000);
        return () => clearInterval(t);
    }, [featured]);

    // Item exibido no board: o focado; senão o destaque da rotação.
    const board = focused || featured[spin] || featured[0] || null;
    // Detalhe enriquecido só vale se for do mesmo item.
    const D = detail && board && detail.id === board.id ? { ...board, ...detail } : board;
    useEffect(() => { if (board && !focused) { /* pré-carrega o do billboard */ if (cache.current.has(board.id)) setDetail(cache.current.get(board.id)); } }, [board, focused]);

    if (!board) return <div className="connecting"><span className="spin" /> Carregando catálogo…</div>;

    const year = D.releaseInfo || '';
    const genres: string[] = Array.isArray(D.genres) ? D.genres : [];
    const cast: string[] = Array.isArray(D.cast) ? D.cast : [];
    const bg = D.background || D.poster;

    const rows: { id: string; name: string; metas: any[] }[] = [];
    if (cwAll.length) rows.push({ id: '__cw', name: 'Continuar assistindo', metas: cwAll });
    if (featured.length) rows.push({ id: '__feat', name: '⭐ Em alta · Bem avaliados', metas: featured });

    return (
        <div className="vod-view">
            <div className="vod-board" style={bg ? { backgroundImage: `url("${bg}")` } : undefined}>
                <div className="vb-grad" />
                <div className="vb-info">
                    <span className="vb-kind">{D.type === 'series' ? 'SÉRIE' : 'FILME'}</span>
                    <h1 className="vb-title">{D.name}</h1>
                    <div className="vb-meta">
                        {ratingNum(D) > 0 && <span className="vb-imdb">★ {D.imdbRating}</span>}
                        {year && <span>{year}</span>}
                        {D.runtime && <span>{D.runtime} min</span>}
                        {genres.length > 0 && <span className="vb-genres">{genres.slice(0, 3).join(' · ')}</span>}
                    </div>
                    {D.description && <p className="vb-desc">{D.description}</p>}
                    {cast.length > 0 && <div className="vb-cast"><b>Elenco:</b> {cast.slice(0, 4).join(', ')}</div>}
                    <button className="vb-play" onClick={() => onOpen(D)}>▶ Assistir</button>
                </div>
            </div>
            <div className="vod-rows">
                {rows.map(r => (
                    <section className="row" key={r.id}><h2>{r.name}</h2>
                        <div className="tiles">{r.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} />)}</div>
                    </section>
                ))}
                {movieRows.length > 0 && <div className="sec-head">Filmes</div>}
                {movieRows.map(row => (
                    <section className="row" key={row.id}><h2>{row.name}</h2>
                        <div className="tiles">{row.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} />)}</div>
                    </section>
                ))}
                {seriesRows.length > 0 && <div className="sec-head">Séries</div>}
                {seriesRows.map(row => (
                    <section className="row" key={row.id}><h2>{row.name}</h2>
                        <div className="tiles">{row.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} />)}</div>
                    </section>
                ))}
            </div>
        </div>
    );
}

function Tile({ meta, onPlay, onFocusItem }: { meta: any; onPlay: () => void; onFocusItem?: (m: any) => void }) {
    const shape = shapeFor(meta);
    // Cascata de logos (banco → próprio → irmão → card). Se uma falhar, o onError
    // avança pra próxima sozinho — nunca fica vazio.
    const chain: string[] = (Array.isArray(meta.posterChain) && meta.posterChain.length)
        ? meta.posterChain
        : [meta.poster || cardFor(meta.name)];
    const [idx, setIdx] = useState(0);
    const [fill, setFill] = useState(false); // logo com fundo opaco → preenche o tile (vira card limpo)
    const card = cardFor(meta.name);
    const src = chain[Math.min(idx, chain.length - 1)] || card;
    const isProxyLogo = src.includes('/img?u=');
    const onErr = (e: React.SyntheticEvent<HTMLImageElement>) => {
        if (idx < chain.length - 1) setIdx(idx + 1);
        else if (e.currentTarget.src !== card) e.currentTarget.src = card;
    };
    const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        if (shape !== 'square' || !isProxyLogo) return;
        const img = e.currentTarget;
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        try {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true } as any); if (!ctx) return;
            ctx.drawImage(img, 0, 0);
            const pts = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [w >> 1, 1], [1, h >> 1]];
            let opaque = 0, transp = 0, lum = 0;
            for (const [x, y] of pts) {
                const d = ctx.getImageData(x, y, 1, 1).data;
                if (d[3] > 240) { opaque++; lum += 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]; }
                else if (d[3] < 24) transp++;
            }
            if (transp === 0 && opaque >= pts.length - 1 && lum / opaque > 48) setFill(true);
        } catch { /* tainted (sem CORS) → mantém contain */ }
    };
    return (
        <button className={`tile ${shape}${fill ? ' fill' : ''}`} onClick={onPlay} aria-label={meta.name}
            onFocus={onFocusItem ? () => onFocusItem(meta) : undefined}
            onMouseEnter={onFocusItem ? () => onFocusItem(meta) : undefined}>
            <img src={src} alt={meta.name} loading="lazy" crossOrigin={isProxyLogo ? 'anonymous' : undefined}
                onError={onErr} onLoad={onLoad} />
            <span className="tile-name">{meta.name}</span>
        </button>
    );
}

export default App;
