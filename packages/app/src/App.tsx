import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import { attachAdaptive } from './player';
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

// --- Navegação por D-pad (controle de TV): movimento espacial do foco -----------
// Elementos focáveis VISÍVEIS na tela.
function navFocusables(): HTMLElement[] {
    const sel = 'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], input:not([disabled])';
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
        .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0 && el.getClientRects().length > 0);
}
// Move o foco pro elemento mais próximo na direção da seta (geometria).
function spatialMove(dir: string): boolean {
    const cur = document.activeElement as HTMLElement | null;
    const els = navFocusables();
    if (!els.length) return false;
    if (!cur || !els.includes(cur)) { els[0].focus(); return true; }
    const c = cur.getBoundingClientRect();
    const ccx = (c.left + c.right) / 2, ccy = (c.top + c.bottom) / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of els) {
        if (el === cur) continue;
        const r = el.getBoundingClientRect();
        const dx = (r.left + r.right) / 2 - ccx, dy = (r.top + r.bottom) / 2 - ccy;
        let primary = 0, cross = 0, ok = false;
        if (dir === 'ArrowRight') { ok = r.left >= c.right - 4; primary = dx; cross = Math.abs(dy); }
        else if (dir === 'ArrowLeft') { ok = r.right <= c.left + 4; primary = -dx; cross = Math.abs(dy); }
        else if (dir === 'ArrowDown') { ok = r.top >= c.bottom - 4; primary = dy; cross = Math.abs(dx); }
        else if (dir === 'ArrowUp') { ok = r.bottom <= c.top + 4; primary = -dy; cross = Math.abs(dx); }
        if (!ok || primary <= 0) continue;
        const score = primary + cross * 2.5;          // prioriza alinhamento na direção
        if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; }
    return false;
}

// Navegação por D-pad no stage de Canais/Jogos (controle remoto):
//  - foco na LISTA (stage): ↑↓ zapeia o canal/jogo, → vai pro player, Voltar = onBack.
//  - foco no PLAYER/PROVEDORES: setas = navegação espacial (↓ do player chega nos
//    provedores), e se cair na lista volta pro modo zap; Voltar volta pra lista.
function stageNav(e: React.KeyboardEvent, stage: HTMLElement | null, move: (d: 1 | -1) => void, onBack: () => void) {
    const a = document.activeElement as HTMLElement | null;
    const onList = !a || a === stage;
    if (onList) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); (stage?.querySelector('.live-player') as HTMLElement | null)?.focus(); }
        else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); onBack(); }
    } else {
        if (e.key.startsWith('Arrow')) {
            e.preventDefault(); spatialMove(e.key);
            const na = document.activeElement as HTMLElement | null;
            if (na && na.closest('.chan-list')) stage?.focus();  // caiu na lista → volta pro zap
        } else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); stage?.focus(); }
    }
}

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
    const [playing, setPlaying] = useState<{ url: string; title: string; key?: string; resumeFrom?: number } | null>(null);
    const [details, setDetails] = useState<any | null>(null); // tela de detalhes (filme/série)
    const [search, setSearch] = useState(false);              // overlay de busca
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
    const play = (url: string, title: string, key?: string, resumeFrom?: number) => { setPicker(null); setPlaying({ url, title, key, resumeFrom }); };
    // Abre a tela de detalhes (filme/série) e registra em "Continuar assistindo".
    const openDetails = useCallback((meta: any) => { recordCw(meta); setDetails(meta); }, []);

    // Filmes/séries: abre seletor de opções se houver mais de uma (tela cheia).
    const openItem = useCallback(async (meta: any) => {
        if (!engine) return;
        const streams = await engine.getStreams(meta.id);
        if (!streams.length) { setStatus('Sem stream disponível'); setTimeout(() => setStatus(''), 2500); return; }
        recordCw(meta);
        if (streams.length === 1) { play(streams[0].url, meta.name); return; }
        setPicker({ title: meta.name, options: streams.map((s: any) => ({ label: String(s.title || '').replace(/\s*-\s*Live$/i, '').trim() || meta.name, url: s.url })) });
    }, [engine]);

    // D-pad GLOBAL (controle de TV): setas movem o foco pelo elemento mais próximo.
    // Exceções: inputs (texto) e o stage de Canais/Jogos (.chan-live tem zapping ↑↓).
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!e.key.startsWith('Arrow')) return;
            const a = document.activeElement as HTMLElement | null;
            if (a && (a.tagName === 'INPUT' || a.closest('.chan-live'))) return;
            if (spatialMove(e.key)) e.preventDefault();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    // Foco inicial ao entrar numa seção (ponto de partida pro D-pad).
    useEffect(() => {
        if (section === 'pick' || section === 'channels') return;
        const t = setTimeout(() => {
            const a = document.activeElement as HTMLElement | null;
            if (a && a !== document.body && a.closest('.home')) return; // já há foco no conteúdo
            (document.querySelector('.home .vod-cat, .home .game-card, .home .tile') as HTMLElement | null)?.focus();
        }, 220);
        return () => clearTimeout(t);
    }, [section]);

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
        // Categorias da que tem MENOS conteúdo pra que tem MAIS (as gigantes ficam
        // no fim, pra não obrigar a rolar logo de cara).
        results.sort((a, b) => a.metas.length - b.metas.length);
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
        <div className={`home ${section}`} ref={homeRef}>
            <header className="topbar">
                <button className="brand-sm" onClick={() => setSection('pick')}>RAJADA</button>
                <nav className="tabs-top">
                    <button className={section === 'vod' ? 'on' : ''} onClick={() => setSection('vod')}>Filmes e Séries</button>
                    <button className={section === 'channels' ? 'on' : ''} onClick={() => setSection('channels')}>Canais</button>
                    <button className={section === 'games' ? 'on' : ''} onClick={() => setSection('games')}>Jogos ao vivo</button>
                </nav>
                <div className="topbar-right">
                    <button className="search-btn" onClick={() => { setSearch(true); if (engine && !builtRef.current.games) { builtRef.current.games = true; buildGames(engine); } }} aria-label="Buscar">🔍</button>
                    <button className="logout" onClick={logout}>sair</button>
                </div>
            </header>

            {status && <div className="status">{status}</div>}

            {section === 'vod' && !engine && <div className="connecting"><span className="spin" /> Conectando ao provedor…</div>}
            {section === 'vod' && engine && (
                vodLoading && !movieRows.length && !seriesRows.length
                    ? <div className="connecting"><span className="spin" /> Carregando catálogo…</div>
                    : <VodView engine={engine} movieRows={movieRows} seriesRows={seriesRows} cwAll={cwAll} onOpen={openDetails} />
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

            {search && engine && <SearchView engine={engine} context={section} games={gamesMetas}
                onClose={() => setSearch(false)}
                onDetails={(m) => { setSearch(false); openDetails(m); }}
                onPlayChannel={async (m) => { try { const s = await engine.getStreams(m.id); if (s[0]?.url) { setSearch(false); play(s[0].url, m.name); } } catch { } }}
                onPlayGame={async (m) => { try { const s = await engine.getStreams(m.id); if (s[0]?.url) { setSearch(false); play(s[0].url, m.name); } } catch { } }} />}
            {details && engine && <DetailsView engine={engine} meta={details} onClose={() => setDetails(null)} onPlay={(u, t, k, r) => { setDetails(null); play(u, t, k, r); }} />}
            {playing && <Player url={playing.url} title={playing.title} contentKey={playing.key} resumeFrom={playing.resumeFrom} onClose={() => setPlaying(null)} />}
        </div>
    );
}

/** Tela inicial estilo Netflix: pirâmide invertida (2 billboards em cima + 1
 *  embaixo), cada um com BACKDROP real, gradiente forte e tipografia premium. */
function PickScreen({ onPick, onLogout, status, art }: { onPick: (s: Section) => void; onLogout: () => void; status: string; art: { vod?: string; tv?: string; live?: string } }) {
    useEffect(() => { const t = setTimeout(() => (document.querySelector('.pick-card') as HTMLElement | null)?.focus(), 150); return () => clearTimeout(t); }, []);
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
const isTimeTok = (w: string) => /^\d{1,2}[:h.]\d{0,2}$/.test(w) || /^\d{1,4}$/.test(w);
function providerBrand(title: string): string {
    let s = String(title || '').replace(/\[[^\]]*\]/g, '').replace(/\s*-\s*Live$/i, '').trim();
    // Remove horário no começo (ex.: "16:00", "16h00", "16h") — vinha virando rótulo.
    s = s.replace(/^\s*\d{1,2}[:h.]\d{0,2}\b\s*/i, '').trim();
    const low = s.toLowerCase().replace(/\s+/g, '');
    for (const b of PROVIDER_BRANDS) if (low.includes(b.toLowerCase().replace(/\s+/g, ''))) return b === 'Caze' ? 'CazeTV' : b;
    // Fallback: 1ª palavra que NÃO seja hora/número (senão, rótulo genérico).
    const words = s.split(/\s+/).filter(Boolean);
    return words.find(w => !isTimeTok(w)) || 'Transmissão';
}
function qualityRank(title: string): number {
    const t = String(title || '');
    if (/fhd|1080/i.test(t)) return 3; if (/\bhd\b|720/i.test(t)) return 2; if (/\bsd\b|480/i.test(t)) return 1; return 0;
}
// Opções de stream distintas (por URL), p/ CANAIS: cada variante (FHD/HD/SD,
// feeds) vira um chip selecionável. Mantém todas como fallback ao escolher uma.
function streamOptions(streams: any[]): { label: string; url: string }[] {
    const seen = new Set<string>(); const out: { label: string; url: string }[] = [];
    for (const s of streams || []) {
        if (!s?.url || seen.has(s.url)) continue; seen.add(s.url);
        const label = String(s.title || '').replace(/\s*-\s*Live$/i, '').trim() || ('Opção ' + (out.length + 1));
        out.push({ label, url: s.url });
    }
    return out;
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
        if (now && i === idx) { stageRef.current?.focus(); return; }  // já é o jogo atual → não recarrega
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 380);
        setTimeout(() => { scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }); stageRef.current?.focus(); }, 0);
    }, [loadStream, idx]);

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
    const onKey = (e: React.KeyboardEvent) => stageNav(e, stageRef.current, move, onBack);

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
                <LivePlayer sources={sources} title={title}
                    options={dedupStreams(opts).map(o => ({ label: o.label, urls: o.urls }))}
                    onPick={(urls) => setSources(urls)} />
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
    const [favVer, setFavVer] = useState(0);                     // versão dos favoritos (reativo ao favoritar)
    const [epg, setEpg] = useState<{ now: string; next: string }>({ now: '', next: '' });
    const [topCat, setTopCat] = useState('');   // categoria no topo da rolagem (cabeçalho "sticky" via barra fixa externa)
    const scrollRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const timer = useRef<any>(null);
    const watchTimer = useRef<any>(null); // só conta "assistido" após 10 min no canal
    const curIdRef = useRef<string>('');  // id do canal tocando (re-sincroniza índice após reordenar)
    const started = useRef(false);

    const label = (n: string) => (n || '').replace(/^Canais\s*\|\s*/i, '').trim() || n;

    // Limpa o timer de "assistido" ao sair da tela.
    useEffect(() => () => clearTimeout(watchTimer.current), []);

    // Lista de exibição: prepend "Mais assistidos" (pelo histórico local) se houver.
    const { vflat, vcats, vCatFirst } = useMemo(() => {
        // score = uso real (peso alto) + popularidade conhecida (semente)
        const score = (f: FlatItem) => (watch[f.meta.name] || 0) * 1000 + popularRank(f.meta.name);
        const seen = new Set<string>(); const top: FlatItem[] = [];
        flat.filter(f => f.kind === 'chan')
            .slice().sort((a, b) => score(b) - score(a))
            .forEach(f => { if (score(f) > 0 && !seen.has(f.meta.name) && top.length < 12) { seen.add(f.meta.name); top.push(f); } });
        // Favoritos (reativo): canais marcados que existem na lista atual, sem duplicar
        // (um mesmo canal pode aparecer em várias categorias).
        const favMap = loadFav();
        const favSeen = new Set<string>(); const favs: FlatItem[] = [];
        for (const f of flat) { if (f.kind === 'chan' && favMap[f.meta.id] && !favSeen.has(f.meta.id)) { favSeen.add(f.meta.id); favs.push(f); } }
        let vflat = flat; let vcats = cats;
        const prefixFlat: FlatItem[] = []; const prefixCats: any[] = [];
        if (favs.length) {
            prefixFlat.push({ kind: 'header', name: '★ Favoritos', catId: '__fav' } as FlatItem, ...favs);
            prefixCats.push({ id: '__fav', name: '★ Favoritos', count: favs.length });
        }
        if (top.length) {
            prefixFlat.push({ kind: 'header', name: 'Mais assistidos', catId: '__top' } as FlatItem, ...top);
            prefixCats.push({ id: '__top', name: 'Mais assistidos', count: top.length });
        }
        if (prefixFlat.length) { vflat = [...prefixFlat, ...flat]; vcats = [...prefixCats, ...cats]; }
        const vCatFirst: Record<string, number> = {};
        vflat.forEach((f, i) => { if (f.kind === 'header' && !(f.catId in vCatFirst)) vCatFirst[f.catId] = i; });
        return { vflat, vcats, vCatFirst };
    }, [flat, cats, watch, favVer]);

    const chanIdxs = useMemo(() => { const a: number[] = []; vflat.forEach((f, i) => { if (f.kind === 'chan') a.push(i); }); return a; }, [vflat]);

    // Ao (des)favoritar, a lista reordena → reaponta o índice pro canal que está tocando.
    useEffect(() => {
        if (!curIdRef.current) return;
        const ni = vflat.findIndex(f => f.kind === 'chan' && f.meta.id === curIdRef.current);
        if (ni >= 0) { setIdx(ni); setTimeout(() => scrollRef.current?.querySelector(`[data-i="${ni}"]`)?.scrollIntoView({ block: 'nearest' }), 0); }
    }, [favVer]);

    const loadStream = useCallback(async (i: number) => {
        const it = vflat[i]; if (!it || it.kind !== 'chan') return;
        curIdRef.current = it.meta.id;
        setTitle(it.meta.name);
        // "Mais assistidos": só conta depois de 10 min CONTÍNUOS no canal (zapear não
        // conta). O timer reinicia a cada troca; sai antes dos 10 min → não registra.
        clearTimeout(watchTimer.current);
        const name = it.meta.name;
        watchTimer.current = setTimeout(() => {
            try { const w = loadWatch(); w[name] = (w[name] || 0) + 1; localStorage.setItem(WATCH_KEY, JSON.stringify(w)); } catch { }
        }, 10 * 60 * 1000);
        // Agora / a seguir (EPG) — fallback "AO VIVO" quando o canal não tem EPG.
        setEpg({ now: '', next: '' });
        engine.getDetailedMeta(it.meta.id).then((dm: any) => setEpg(parseEpgDesc(dm?.description))).catch(() => { });
        try { const streams = await engine.getStreams(it.meta.id); setOpts(streams); setSources(dedupStreams(streams)[0]?.urls || []); }
        catch { setOpts([]); setSources([]); }
    }, [engine, vflat]);

    const select = useCallback((i: number, now = false) => {
        const it = vflat[i];
        // Clicar/OK no canal que JÁ está tocando não recarrega (evita "sempre carregando"
        // em cliques repetidos). Só devolve o foco pro stage (modo zapping).
        if (now && it?.kind === 'chan' && it.meta.id === curIdRef.current) { stageRef.current?.focus(); return; }
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 200);  // debounce no zapping
        // Mantém o foco no stage (não na linha) → ↑↓ zapeia e → vai pro player.
        setTimeout(() => { scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }); stageRef.current?.focus(); }, 0);
    }, [loadStream, vflat]);

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
        // Rola o cabeçalho da categoria escolhida pro TOPO da lista (não pro fim).
        // Espera a lista renderizar e alinha pelo bounding rect (sticky-safe).
        setTimeout(() => {
            const sc = scrollRef.current; const el = sc?.querySelector(`[data-h="${h}"]`) as HTMLElement | null;
            if (sc && el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
            stageRef.current?.focus();
        }, 140);
    };

    // "Sticky" sem buraco: a categoria do topo da rolagem é refletida na BARRA FIXA
    // externa (.chan-list-head), não num elemento dentro da lista. Os divisores ficam
    // inline (não-sticky) → impossível gerar vão/corte. Calcula qual seção está no topo.
    const recalcTopCat = useCallback(() => {
        const sc = scrollRef.current; if (!sc) return;
        const top = sc.getBoundingClientRect().top + 1;
        const divs = sc.querySelectorAll<HTMLElement>('.chan-divider[data-h]');
        let name = '';
        for (const d of Array.from(divs)) {
            if (d.getBoundingClientRect().top <= top) name = d.textContent || '';
            else break;
        }
        if (!name && divs.length) name = divs[0].textContent || '';
        setTopCat(prev => (prev === name ? prev : name));
    }, []);

    // Recalcula ao trocar a lista e logo após montar.
    useEffect(() => { const t = setTimeout(recalcTopCat, 60); return () => clearTimeout(t); }, [vflat, recalcTopCat, mode]);

    const move = (dir: 1 | -1) => {
        const pos = chanIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(chanIdxs.length - 1, pos + dir));
        select(chanIdxs[np]);
    };
    // Navegação LISA da lista de categorias: ↑↓ move o foco entre as categorias
    // (roving focus + scroll), Enter seleciona (onClick do botão), Voltar volta.
    const catsKey = (e: React.KeyboardEvent) => {
        const rows = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('.cat-row') || []);
        if (!rows.length) return;
        const cur = rows.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); const n = rows[cur < 0 ? 0 : Math.min(rows.length - 1, cur + 1)]; n.focus(); n.scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); const n = rows[cur <= 0 ? 0 : cur - 1]; n.focus(); n.scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); setMode('channels'); }
        // Enter/OK: o onClick do botão focado dispara pickCat naturalmente.
    };
    const onKey = (e: React.KeyboardEvent) => {
        if (mode === 'cats') catsKey(e);
        else stageNav(e, stageRef.current, move, () => setMode('cats'));
    };

    // Ao entrar nas categorias, foca a categoria atual (ou a 1ª) — começa já posicionado.
    useEffect(() => {
        if (mode !== 'cats') return;
        const t = setTimeout(() => {
            const sc = scrollRef.current; if (!sc) return;
            const curId = vflat[idx]?.catId;
            const target = (curId && sc.querySelector<HTMLElement>(`.cat-row[data-cid="${curId}"]`)) || sc.querySelector<HTMLElement>('.cat-row');
            target?.focus(); target?.scrollIntoView({ block: 'center' });
        }, 60);
        return () => clearTimeout(t);
    }, [mode]);

    const curCatName = idx >= 0 ? label(vcats.find(c => c.id === vflat[idx]?.catId)?.name || '') : '';
    const curMeta = vflat[idx]?.meta;

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
                    <span className="cur-cat">{inCats ? 'Escolha uma categoria' : (topCat || curCatName)}</span>
                </div>
                <div className="chan-scroll" ref={scrollRef} onScroll={recalcTopCat}>
                    {inCats ? (
                        vcats.map(c => (
                            <button key={c.id} data-cid={c.id} className={`cat-row${vflat[idx]?.catId === c.id ? ' on' : ''}`} onClick={() => pickCat(c.id)} onFocus={focusScroll}>
                                <span className="cat-row-name">{label(c.name)}</span>
                                <span className="cat-row-count">{c.count}</span>
                            </button>
                        ))
                    ) : (
                        // Agrupa por seção: cada cabeçalho + suas linhas num container, pra o
                        // sticky ficar preso à seção e NÃO empilhar com o próximo (o "buraco").
                        (() => {
                            const secs: { hi: number; header: FlatItem; items: { f: FlatItem; i: number }[] }[] = [];
                            vflat.forEach((f, i) => {
                                if (f.kind === 'header') secs.push({ hi: i, header: f, items: [] });
                                else if (secs.length) secs[secs.length - 1].items.push({ f, i });
                            });
                            return secs.map(sec => (
                                <div className="chan-section" key={'s' + sec.hi}>
                                    <div className="chan-divider" data-h={sec.hi}><span>{label(sec.header.name)}</span></div>
                                    {sec.items.map(({ f, i }) => (
                                        <button key={i} data-i={i} className={`chan-row${i === idx ? ' on' : ''}`} onClick={() => select(i, true)}>
                                            <img className="chan-ico" alt="" loading="lazy"
                                                src={(Array.isArray(f.meta.posterChain) && f.meta.posterChain[0]) || f.meta.poster || cardFor(f.meta.name)}
                                                onError={(e) => { const c = cardFor(f.meta.name); if (e.currentTarget.src !== c) e.currentTarget.src = c; }} />
                                            <span className="chan-name">{f.meta.name}</span>
                                        </button>
                                    ))}
                                </div>
                            ));
                        })()
                    )}
                </div>
            </aside>
            <main className="chan-stage">
                <LivePlayer sources={sources} title={title}
                    options={streamOptions(opts).map(o => ({ label: o.label, urls: [o.url] }))}
                    onPick={(urls) => { const all = streamOptions(opts).map(o => o.url); setSources([urls[0], ...all.filter(u => u !== urls[0])]); }} />
                <div className="chan-now">
                    <div className="now-head">
                        {curMeta && (
                            <button className={`now-fav${isFav(curMeta.id) ? ' on' : ''}`} title="Favoritar canal"
                                onClick={() => { toggleFav(curMeta); setFavVer(v => v + 1); }}>{isFav(curMeta.id) ? '★' : '☆'}</button>
                        )}
                        <span className="now-title">{title || 'Selecione um canal'}</span>
                        {epg.now
                            ? <span className="now-epg"><b>AGORA:</b> {epg.now}{epg.next ? <> <span className="now-epg-next">· a seguir: {epg.next}</span></> : ''}</span>
                            : title ? <span className="now-epg dim">● AO VIVO</span> : null}
                    </div>
                    {(() => {
                        const list = streamOptions(opts); if (list.length <= 1) return null;
                        const others = list.map(o => o.url);
                        return (
                            <div className="now-opts">
                                {list.map((o, i) => (
                                    <button key={i} className={`now-opt${o.url === sources[0] ? ' on' : ''}`} onFocus={focusScroll}
                                        onClick={() => setSources([o.url, ...others.filter(u => u !== o.url)])}>
                                        {o.label}
                                    </button>
                                ))}
                            </div>
                        );
                    })()}
                </div>
            </main>
        </div>
    );
}

/** Player embutido (canais/jogos ao vivo): recebe a CADEIA de fontes daquela
 *  marca (várias regionais/qualidades) e faz failover automático — se uma falha,
 *  já tenta a próxima sozinho. Troca de fonte ao zapear, sem fechar. */
function LivePlayer({ sources, title, options, onPick }: {
    sources: string[]; title: string;
    options?: { label: string; urls: string[] }[];   // fontes alternativas (p/ trocar em tela cheia)
    onPick?: (urls: string[]) => void;
}) {
    const ref = useRef<HTMLVideoElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const idxRef = useRef(0);                 // fonte atual na cadeia
    const srcRef = useRef<string[]>(sources);
    const recoverRef = useRef(0);
    const [alt, setAlt] = useState(0);        // fonte em uso (p/ aviso "tentando alternativa")
    const [dead, setDead] = useState(false);  // todas as fontes falharam
    const [loading, setLoading] = useState(false); // bufferizando (feedback ao zapear)
    const [fs, setFs] = useState(false);      // tela cheia (CSS — funciona em qualquer TV)
    const [showCtrl, setShowCtrl] = useState(true);  // barra de controles visível (auto-some)
    const [paused, setPaused] = useState(false);
    const [muted, setMuted] = useState(false);
    const showRef = useRef(true);
    const hideTimer = useRef<any>(null);
    const ctrlRef = useRef<HTMLDivElement>(null);
    srcRef.current = sources;

    // Toca a fonte i. hls.js é uma instância PERSISTENTE: trocar de canal/fonte só faz
    // loadSource (rápido), sem destruir/recriar — e recupera travadas sozinho.
    const playAt = useCallback((i: number) => {
        const v = ref.current; const url = srcRef.current[i];
        if (!v || !url) return;
        idxRef.current = i; setAlt(i); setLoading(true);
        const nextSrc = () => { const ni = idxRef.current + 1; if (ni < srcRef.current.length) { recoverRef.current = 0; playAt(ni); } else setDead(true); };
        if (Hls.isSupported()) {
            let hls = hlsRef.current;
            if (!hls) {
                hls = new Hls({
                    enableWorker: true, lowLatencyMode: false, startFragPrefetch: true,
                    // Começa perto da borda ao vivo (menos segmentos pra bufferizar = zap rápido).
                    liveSyncDurationCount: 2, maxBufferLength: 12, maxMaxBufferLength: 40, backBufferLength: 15,
                    manifestLoadingTimeOut: 8000, fragLoadingTimeOut: 20000,
                    manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6,
                });
                hls.attachMedia(v);
                hls.on(Hls.Events.ERROR, (_e, d) => {
                    if (!d.fatal) return;
                    const h = hlsRef.current; if (!h) return;
                    // Recupera sem trocar de fonte (rede/mídia) algumas vezes.
                    if (d.type === Hls.ErrorTypes.NETWORK_ERROR && recoverRef.current < 4) { recoverRef.current++; try { h.startLoad(); } catch { } return; }
                    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recoverRef.current < 4) { recoverRef.current++; try { h.recoverMediaError(); } catch { } return; }
                    nextSrc(); // irrecuperável → próxima fonte
                });
                hlsRef.current = hls;
            }
            recoverRef.current = 0;
            hls.loadSource(url);
            v.play().catch(() => { });
        } else {
            // Sem MSE (TVs antigas) → player nativo.
            v.src = url;
            v.onerror = nextSrc;
            v.play().catch(() => { });
        }
    }, []);

    // Troca de canal/marca → recomeça da 1ª fonte (loadSource na MESMA instância).
    useEffect(() => { setDead(false); recoverRef.current = 0; playAt(0); }, [sources, playAt]);

    // Vigia de travadas: se está tocando mas o tempo não anda por ~3s, cutuca o hls.
    useEffect(() => {
        const v = ref.current; if (!v) return;
        let last = -1, stuck = 0;
        const iv = setInterval(() => {
            if (v.paused || v.readyState < 2) return;
            if (v.currentTime === last) { if (++stuck >= 3) { stuck = 0; try { hlsRef.current?.startLoad(); } catch { } v.play().catch(() => { }); } }
            else { stuck = 0; last = v.currentTime; }
        }, 1000);
        return () => clearInterval(iv);
    }, []);

    // Feedback de "carregando": some quando o vídeo realmente começa.
    useEffect(() => {
        const v = ref.current; if (!v) return;
        const done = () => setLoading(false);
        const wait = () => setLoading(true);
        v.addEventListener('playing', done); v.addEventListener('canplay', done);
        v.addEventListener('waiting', wait);
        return () => { v.removeEventListener('playing', done); v.removeEventListener('canplay', done); v.removeEventListener('waiting', wait); };
    }, []);

    // Destrói a instância ao desmontar.
    useEffect(() => () => { try { hlsRef.current?.destroy(); } catch { } hlsRef.current = null; }, []);
    // ---- Controlador da barra de tela cheia (some sozinha, reaparece em qualquer ação) ----
    const setShow = useCallback((v: boolean) => { showRef.current = v; setShowCtrl(v); }, []);
    const reveal = useCallback(() => {
        setShow(true);
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setShow(false), 4000);  // some após 4s parado
    }, [setShow]);
    const ctrlButtons = () => Array.from(ctrlRef.current?.querySelectorAll<HTMLElement>('button') || []);
    const focusCtrl = (idx = 0) => { const b = ctrlButtons(); (b[Math.max(0, Math.min(b.length - 1, idx))])?.focus(); };
    const moveCtrl = (dir: 1 | -1) => { const b = ctrlButtons(); if (!b.length) return; const cur = b.indexOf(document.activeElement as HTMLElement); const ni = cur < 0 ? 0 : Math.max(0, Math.min(b.length - 1, cur + dir)); b[ni].focus(); };
    const togglePlay = () => { const v = ref.current; if (!v) return; if (v.paused) v.play().catch(() => { }); else v.pause(); reveal(); };
    const toggleMute = () => { const v = ref.current; if (!v) return; v.muted = !v.muted; reveal(); };

    // Mantém os ícones de play/mudo sincronizados com o vídeo.
    useEffect(() => {
        const v = ref.current; if (!v) return;
        const sync = () => { setPaused(v.paused); setMuted(v.muted); };
        v.addEventListener('play', sync); v.addEventListener('pause', sync); v.addEventListener('volumechange', sync);
        return () => { v.removeEventListener('play', sync); v.removeEventListener('pause', sync); v.removeEventListener('volumechange', sync); };
    }, []);

    // Em tela cheia: barra some/reaparece; ←→ navega entre os botões; Voltar sai;
    // tudo confinado à barra (não vaza pra lista atrás). Fora dela, foco volta ao player.
    useEffect(() => {
        if (!fs) {
            setShow(true); clearTimeout(hideTimer.current);
            const t = setTimeout(() => boxRef.current?.focus(), 60);
            return () => clearTimeout(t);
        }
        reveal();
        const t = setTimeout(() => focusCtrl(0), 60);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); setFs(false); return; }
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'NumpadEnter') {
                if (!showRef.current) { e.preventDefault(); e.stopPropagation(); reveal(); focusCtrl(0); }
                else reveal();   // deixa o botão focado disparar
                return;
            }
            e.stopPropagation();  // confina: stageNav/spatialMove não agem na lista de trás
            if (!showRef.current) { e.preventDefault(); reveal(); focusCtrl(0); return; }  // 1ª tecla só revela
            reveal();
            if (e.key === 'ArrowRight') { e.preventDefault(); moveCtrl(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); moveCtrl(-1); }
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); }
        };
        const onMove = () => reveal();
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousemove', onMove, true);
        return () => { clearTimeout(t); clearTimeout(hideTimer.current); window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousemove', onMove, true); };
    }, [fs, reveal, setShow]);
    const trying = alt > 0 && !dead;
    const active = sources[0];
    const canFs = !!sources.length;
    // OK/Enter no player (foco no container) → entra em tela cheia.
    const onBoxKey = (e: React.KeyboardEvent) => {
        if (fs) return;
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'NumpadEnter') { e.preventDefault(); if (canFs) setFs(true); }
    };
    return (
        <div ref={boxRef}
            className={`live-player${fs ? ' fs' : ''}${fs && !showCtrl ? ' nocursor' : ''}`}
            tabIndex={0}
            role="button"
            aria-label="Player — OK para tela cheia"
            onKeyDown={onBoxKey}
            onClick={() => { if (fs) reveal(); else if (canFs) setFs(true); }}>
            <video ref={ref} autoPlay playsInline className="live-video" />
            {/* Anel de foco SOBRE o vídeo (box-shadow no container fica escondido atrás dele). */}
            {!fs && <div className="live-ring" aria-hidden="true" />}
            {/* Dica visível só quando o player está focado (não é focável → não rouba D-pad). */}
            {canFs && !fs && <span className="live-hint">⛶ OK = tela cheia</span>}
            {!sources.length && <div className="live-empty">▶ Selecione um canal na lista</div>}
            {loading && !dead && !!sources.length && <div className="live-loading"><span className="spin" /></div>}
            {trying && <div className="live-fallback">Fonte instável — tentando alternativa {alt + 1}/{sources.length}…</div>}
            {dead && sources.length > 0 && (<div className="player-err">Nenhuma fonte respondeu.<button onClick={() => window.open(sources[sources.length - 1], '_blank')}>Abrir externo</button></div>)}
            {fs && (
                <div className={`live-ov${showCtrl ? '' : ' hidden'}`}>
                    <div className="live-ov-top"><span className="live-ov-title">{title}</span></div>
                    <div className="live-ctrl" ref={ctrlRef}>
                        <button className="live-cbtn" onClick={togglePlay} aria-label={paused ? 'Tocar' : 'Pausar'} title={paused ? 'Tocar' : 'Pausar'}>{paused ? '▶' : '❚❚'}</button>
                        <button className="live-cbtn" onClick={toggleMute} aria-label={muted ? 'Ativar som' : 'Mudo'} title={muted ? 'Ativar som' : 'Mudo'}>{muted ? '🔇' : '🔊'}</button>
                        {options && options.length > 1 && options.map((o, k) => (
                            <button key={k} className={`now-opt${o.urls[0] === active ? ' on' : ''}`}
                                onClick={() => { onPick?.(o.urls); reveal(); }}>{o.label}</button>
                        ))}
                        <button className="live-cbtn live-cbtn-exit" onClick={() => setFs(false)} aria-label="Sair da tela cheia">✕ Sair</button>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Player em tela cheia: HLS via hls.js; senão <video> nativo; fallback "abrir externo". */
function Player({ url, title, contentKey, resumeFrom, onClose }: { url: string; title: string; contentKey?: string; resumeFrom?: number; onClose: () => void }) {
    const ref = useRef<HTMLVideoElement>(null);
    const [err, setErr] = useState(false);
    useEffect(() => {
        const v = ref.current; if (!v) return;
        // Player adaptativo: nativo → hls.js conforme a plataforma; só marca erro
        // quando todas as engines falham.
        const handle = attachAdaptive(v, url, () => setErr(true));
        // Retoma de onde parou (VOD).
        if (resumeFrom && resumeFrom > 5) {
            const seek = () => { try { if (v.currentTime < 1) v.currentTime = resumeFrom; } catch { } };
            v.addEventListener('loadedmetadata', seek, { once: true });
        }
        // Salva o progresso periodicamente (continuar assistindo / retomar).
        let last = 0;
        const onTime = () => { if (!contentKey) return; const now = v.currentTime; if (Math.abs(now - last) >= 5) { last = now; saveProg(contentKey, now, v.duration); } };
        v.addEventListener('timeupdate', onTime);
        return () => { if (contentKey) saveProg(contentKey, v.currentTime, v.duration); v.removeEventListener('timeupdate', onTime); handle.destroy(); };
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

// --- Progresso de reprodução (continuar assistindo / retomar posição) ----------
// Chave = id do conteúdo (filme `vod..._` ou episódio `epi..._`).
const PROG_KEY = 'rajada.progress.v1';
function loadProg(): Record<string, { pos: number; dur: number; t: number }> { try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}'); } catch { return {}; } }
function getProg(key: string) { if (!key) return null; return loadProg()[key] || null; }
// Episódios/filmes concluídos (>95%) — usado p/ achar o "próximo episódio".
const WATCHED_KEY = 'rajada.watched.v1';
function loadWatched(): Record<string, number> { try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}'); } catch { return {}; } }
function markWatched(key: string) { if (!key) return; try { const w = loadWatched(); w[key] = Date.now(); localStorage.setItem(WATCHED_KEY, JSON.stringify(w)); } catch { } }
function saveProg(key: string, pos: number, dur: number) {
    if (!key || !dur || !isFinite(pos)) return;
    try {
        const p = loadProg();
        if (pos / dur > 0.95) { delete p[key]; markWatched(key); }   // concluído → tira do "continuar" e marca assistido
        else if (pos < 8) delete p[key];                             // mal começou → não guarda
        else p[key] = { pos, dur, t: Date.now() };
        localStorage.setItem(PROG_KEY, JSON.stringify(p));
    } catch { }
}
// Resolve o que tocar ao clicar "Continuar/Assistir" numa série.
function resolveResume(videos: any[]): { ep: any; mode: 'continue' | 'next' | 'first' | 'rewatch'; pos: number } | null {
    if (!videos.length) return null;
    const ordered = [...videos].sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    const prog = loadProg(); const watched = loadWatched();
    let ip: { v: any; t: number; pos: number } | null = null;
    for (const v of ordered) { const p = prog[v.id]; if (p && p.t > (ip?.t || 0)) ip = { v, t: p.t, pos: p.pos }; }
    let fin: { v: any; t: number } | null = null;
    for (const v of ordered) { const t = watched[v.id]; if (t && t > (fin?.t || 0)) fin = { v, t }; }
    if (ip && (!fin || ip.t >= fin.t)) return { ep: ip.v, mode: 'continue', pos: ip.pos };
    if (fin) {
        const idx = ordered.findIndex(v => v.id === fin!.v.id);
        const next = ordered[idx + 1];
        return next ? { ep: next, mode: 'next', pos: 0 } : { ep: fin.v, mode: 'rewatch', pos: 0 };
    }
    return { ep: ordered[0], mode: 'first', pos: 0 };
}
// Extrai "agora / a seguir" da descrição do canal (getDetailedMeta), que o core
// monta a partir do EPG: linhas "AGORA: ..." e "A SEGUIR:\nHH:MM - ...".
function parseEpgDesc(desc: string): { now: string; next: string } {
    const lines = String(desc || '').split('\n').map(s => s.trim()).filter(Boolean);
    let now = '', next = '';
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^AGORA:\s*(.+)$/i);
        if (m) { now = m[1]; continue; }
        if (/^A SEGUIR/i.test(lines[i])) { const nx = lines[i + 1]; if (nx) next = nx.replace(/^\d{1,2}:\d{2}\s*-\s*/, ''); break; }
    }
    return { now, next };
}

// --- Favoritos / Minha lista (filmes, séries, canais) -------------------------
const FAV_KEY = 'rajada.fav.v1';
function loadFav(): Record<string, any> { try { return JSON.parse(localStorage.getItem(FAV_KEY) || '{}'); } catch { return {}; } }
function isFav(id: string): boolean { return !!loadFav()[id]; }
function toggleFav(meta: any): boolean {
    try {
        const f = loadFav();
        if (f[meta.id]) delete f[meta.id];
        else f[meta.id] = { id: meta.id, name: meta.name, poster: meta.poster, posterChain: meta.posterChain, posterShape: meta.posterShape, type: meta.type };
        localStorage.setItem(FAV_KEY, JSON.stringify(f));
        return !!f[meta.id];
    } catch { return false; }
}
function fmtTime(s: number): string {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
}

/** Busca (overlay): filmes, séries e canais por nome (debounce). Filme/série
 *  abrem detalhes; canal toca direto. */
function SearchView({ engine, context, games, onClose, onDetails, onPlayChannel, onPlayGame }: {
    engine: NexoEngine; context: Section; games: any[]; onClose: () => void;
    onDetails: (m: any) => void; onPlayChannel: (m: any) => void; onPlayGame: (m: any) => void;
}) {
    const [q, setQ] = useState('');
    const [res, setRes] = useState<{ movies: any[]; series: any[]; channels: any[] }>({ movies: [], series: [], channels: [] });
    const [loading, setLoading] = useState(false);
    const timer = useRef<any>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const recRef = useRef<any>(null);
    const [listening, setListening] = useState(false);
    // Busca por voz (Web Speech API) — ótimo na TV/controle. Some o botão se a
    // plataforma não suportar reconhecimento de fala.
    const voiceOK = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    const startVoice = () => {
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SR) return;
        try {
            if (recRef.current) { try { recRef.current.stop(); } catch { } recRef.current = null; setListening(false); return; }
            const rec = new SR();
            rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
            rec.onresult = (e: any) => {
                const txt = Array.from(e.results).map((r: any) => r[0]?.transcript || '').join('').trim();
                if (txt) setQ(txt);
            };
            rec.onerror = () => { setListening(false); recRef.current = null; };
            rec.onend = () => { setListening(false); recRef.current = null; };
            recRef.current = rec; setListening(true); rec.start();
        } catch { setListening(false); recRef.current = null; }
    };
    useEffect(() => () => { try { recRef.current?.stop(); } catch { } }, []);
    useEffect(() => { inputRef.current?.focus(); }, []);
    useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
    useEffect(() => {
        clearTimeout(timer.current);
        const term = q.trim();
        if (term.length < 2) { setRes({ movies: [], series: [], channels: [] }); setLoading(false); return; }
        timer.current = setTimeout(async () => {
            setLoading(true);
            const get = (type: string, id: string) => engine.getCatalog({ type, id, extra: { search: term } }).then((r: any) => r.metas || []).catch(() => []);
            const [movies, series, channels] = await Promise.all([get('movie', 'nexotv_vod'), get('series', 'nexotv_series'), get('tv', 'iptv_channels')]);
            setRes({ movies: movies.slice(0, 24), series: series.slice(0, 24), channels: channels.slice(0, 24) });
            setLoading(false);
        }, 320);
    }, [q]);
    // Jogos: filtro local (times/competição) sobre a agenda já carregada.
    const gameHits = useMemo(() => {
        const term = q.trim().toLowerCase(); if (term.length < 2) return [];
        const norm = (s: string) => String(s || '').toLowerCase();
        return games.filter(g => norm(g.name).includes(term) || norm(g.tournament).includes(term)).slice(0, 24);
    }, [q, games]);
    const total = res.movies.length + res.series.length + res.channels.length + gameHits.length;
    const Sec = (key: string, title: string, metas: any[], onItem: (m: any) => void) => metas.length > 0 && (
        <section className="row" key={key}><h2>{title} <span className="vod-cat-count">{metas.length}</span></h2>
            <div className="tiles">{metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onItem(m)} />)}</div>
        </section>
    );
    // Ordem das linhas conforme a seção em que a busca foi aberta (a relevante primeiro).
    const blocks: Record<string, any> = {
        channels: () => Sec('channels', 'Canais', res.channels, onPlayChannel),
        movies: () => Sec('movies', 'Filmes', res.movies, onDetails),
        series: () => Sec('series', 'Séries', res.series, onDetails),
        games: () => gameHits.length > 0 && (
            <section className="row" key="games"><h2>Jogos <span className="vod-cat-count">{gameHits.length}</span></h2>
                <div className="tiles">{gameHits.map((m: any) => <GameCard key={m.id} meta={m} onPlay={() => onPlayGame(m)} />)}</div>
            </section>
        ),
    };
    const order = context === 'channels' ? ['channels', 'games', 'movies', 'series']
        : context === 'games' ? ['games', 'channels', 'movies', 'series']
            : ['movies', 'series', 'channels', 'games'];
    return (
        <div className="search-ov">
            <div className="search-bar">
                <span className="search-ico">🔍</span>
                <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar filmes, séries e canais…" />
                {voiceOK && <button className={`search-mic${listening ? ' on' : ''}`} onClick={startVoice}
                    aria-label="Buscar por voz" title="Buscar por voz">🎤</button>}
                <button className="search-close" onClick={onClose}>✕</button>
            </div>
            <div className="search-results">
                {q.trim().length < 2 ? <div className="status">Digite ao menos 2 letras…</div>
                    : loading && !total ? <div className="connecting"><span className="spin" /> Buscando…</div>
                        : total === 0 ? <div className="status">Nada encontrado para “{q.trim()}”.</div>
                            : <>{order.map(k => blocks[k]())}</>}
            </div>
        </div>
    );
}

/** Tela de detalhes (overlay) de filme/série: backdrop, nota, sinopse, elenco.
 *  Filme → Assistir (retoma posição). Série → temporadas + episódios. */
function DetailsView({ engine, meta, onClose, onPlay }: {
    engine: NexoEngine; meta: any; onClose: () => void;
    onPlay: (url: string, title: string, key: string, resumeFrom: number) => void;
}) {
    const [d, setD] = useState<any>(meta);
    const [loading, setLoading] = useState(true);
    const [season, setSeason] = useState<number>(1);
    const [fav, setFav] = useState<boolean>(() => isFav(meta.id));
    const FavBtn = () => (
        <button className={`details-fav${fav ? ' on' : ''}`} onClick={() => setFav(toggleFav(meta))}>
            {fav ? '✓ Minha lista' : '＋ Minha lista'}
        </button>
    );
    useEffect(() => {
        let dead = false; setLoading(true);
        engine.getDetailedMeta(meta.id)
            .then((r: any) => { if (!dead && r) { setD(r); const vs = Array.isArray(r.videos) ? r.videos : []; if (vs.length) { const rr = resolveResume(vs); setSeason(rr?.ep.season || vs[0].season || 1); } } })
            .catch(() => { }).finally(() => { if (!dead) setLoading(false); });
        return () => { dead = true; };
    }, [meta.id]);
    useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

    const videos: any[] = Array.isArray(d.videos) ? d.videos : [];
    const isSeries = videos.length > 0 || d.type === 'series' || (typeof meta.id === 'string' && /ser\w*_/.test(meta.id));
    const seasons = [...new Set(videos.map(v => v.season))].sort((a, b) => a - b);
    const eps = videos.filter(v => v.season === season).sort((a, b) => a.episode - b.episode);
    const watchedMap = loadWatched();
    const genres: string[] = Array.isArray(d.genres) ? d.genres : [];
    const cast: string[] = Array.isArray(d.cast) ? d.cast : [];
    const art = d.background && !/placehold/.test(d.background) ? d.background : '';
    const poster = d.poster && !/placehold/.test(d.poster) ? d.poster : '';

    const startMovie = async (from: number) => {
        try { const s = await engine.getStreams(meta.id); if (s[0]?.url) onPlay(s[0].url, d.name, meta.id, from); } catch { }
    };
    const playEp = async (ep: any, from?: number) => {
        try { const s = await engine.getStreams(ep.id); if (s[0]?.url) onPlay(s[0].url, `${d.name} · S${ep.season}E${ep.episode}`, ep.id, from != null ? from : (getProg(ep.id)?.pos || 0)); } catch { }
    };
    const mProg = !isSeries ? getProg(meta.id) : null;
    // Série: o que tocar no botão principal (retoma / próximo / 1º episódio).
    const resume = isSeries ? resolveResume(videos) : null;
    const resumeLabel = resume && ({
        continue: `Continuar T${resume.ep.season}E${resume.ep.episode} (${fmtTime(resume.pos)})`,
        next: `Assistir T${resume.ep.season}E${resume.ep.episode}`,
        rewatch: `Rever T${resume.ep.season}E${resume.ep.episode}`,
        first: `Assistir T${resume.ep.season}E${resume.ep.episode}`,
    } as any)[resume.mode];

    return (
        <div className="details" onClick={onClose}>
            <div className="details-box" onClick={e => e.stopPropagation()}>
                <div className="details-hero" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
                    <div className="details-grad" />
                    <button className="details-close" onClick={onClose} aria-label="Fechar">✕</button>
                    <div className="details-head">
                        {!art && poster && <img className="details-poster" src={poster} alt="" />}
                        <div className="details-info">
                            <span className="vb-kind">{isSeries ? 'SÉRIE' : 'FILME'}</span>
                            <h1 className="vb-title">{d.name}</h1>
                            <div className="vb-meta">
                                {ratingNum(d) > 0 && <span className="vb-imdb">★ {d.imdbRating}</span>}
                                {d.releaseInfo && <span>{d.releaseInfo}</span>}
                                {d.runtime && <span>{d.runtime} min</span>}
                                {genres.length > 0 && <span className="vb-genres">{genres.slice(0, 3).join(' · ')}</span>}
                            </div>
                            {!isSeries && (
                                <div className="details-actions">
                                    <button className="vb-play" onClick={() => startMovie(mProg?.pos || 0)}>▶ {mProg ? `Continuar (${fmtTime(mProg.pos)})` : 'Assistir'}</button>
                                    {mProg && <button className="details-restart" onClick={() => startMovie(0)}>Reiniciar</button>}
                                    <FavBtn />
                                </div>
                            )}
                            {isSeries && resume && (
                                <div className="details-actions">
                                    <button className="vb-play" onClick={() => playEp(resume.ep, resume.pos)}>▶ {resumeLabel}</button>
                                    {resume.mode === 'continue' && <button className="details-restart" onClick={() => playEp(resume.ep, 0)}>Reiniciar ep.</button>}
                                    <FavBtn />
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div className="details-body">
                    {d.description && <p className="details-desc">{d.description}</p>}
                    {cast.length > 0 && <div className="vb-cast"><b>Elenco:</b> {cast.slice(0, 6).join(', ')}</div>}
                    {d.director && <div className="vb-cast"><b>Direção:</b> {d.director}</div>}
                    {loading && isSeries && <div className="status">Carregando episódios…</div>}
                    {isSeries && seasons.length > 0 && (
                        <>
                            <div className="det-seasons">
                                {seasons.map(s => (
                                    <button key={s} className={`vod-sub${s === season ? ' on' : ''}`} onClick={() => setSeason(s)} onFocus={focusScroll}>Temporada {s}</button>
                                ))}
                            </div>
                            <div className="det-eps">
                                {eps.map(ep => {
                                    const p = getProg(ep.id);
                                    const done = !p && !!watchedMap[ep.id];
                                    return (
                                        <button key={ep.id} className={`det-ep${done ? ' done' : ''}`} onClick={() => playEp(ep)}>
                                            <img className="det-ep-thumb" src={ep.thumbnail || poster || cardFor(d.name)} alt="" loading="lazy"
                                                onError={e => { (e.currentTarget as HTMLImageElement).src = cardFor(d.name); }} />
                                            <span className="det-ep-info">
                                                <span className="det-ep-title">{done && <span className="det-ep-check">✓</span>}{ep.episode}. {ep.title}{p ? <em className="det-ep-resume"> · continuar {fmtTime(p.pos)}</em> : ''}</span>
                                                {ep.overview && <span className="det-ep-ov">{ep.overview}</span>}
                                            </span>
                                            <span className="det-ep-play">▶</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

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
    const initCat = useRef<any>((() => { try { return JSON.parse(localStorage.getItem('rajada.vodcat.v1') || '{}'); } catch { return {}; } })());
    const [mainCat, setMainCat] = useState<string>(initCat.current.main || '__all'); // categoria principal
    const [subCat, setSubCat] = useState<string>(initCat.current.sub || '__all');    // subcategoria (id do catálogo)
    const [loaded, setLoaded] = useState<Record<string, any[]>>({}); // buscadas sob demanda
    const [loadingCat, setLoadingCat] = useState(false);
    // Categorias descobertas vazias (escondidas dos botões). Persiste entre sessões.
    const [empty, setEmpty] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('rajada.vodempty.v1') || '[]')); } catch { return new Set(); } });

    // Árvore de categorias do catálogo. Nome "Filmes | Ação" vira principal
    // "Filmes" + sub "Ação"; sem "|" vira uma principal própria (com selfId).
    const tree = useMemo(() => {
        const cats = ((engine.getManifest() as any).catalogs || []) as any[];
        const defs = cats.filter(c => /^nexotv_(vod|series)(_g_|$)/.test(c.id));
        const map = new Map<string, { name: string; selfId?: string; type: string; subs: { name: string; id: string }[] }>();
        for (const c of defs) {
            const parts = String(c.name).split('|').map(s => s.trim());
            const main = parts[0] || c.name; const sub = parts.slice(1).join(' | ');
            if (!map.has(main)) map.set(main, { name: main, type: c.type, subs: [] });
            const node = map.get(main)!;
            if (sub) node.subs.push({ name: sub, id: c.id }); else node.selfId = c.id;
        }
        return [...map.values()];
    }, [engine]);

    // Árvore visível: esconde subs vazias e principais cujo conteúdo é todo vazio.
    const visTree = useMemo(() => tree
        .map(n => ({ ...n, subs: n.subs.filter(s => !empty.has(s.id)) }))
        .filter(n => (n.selfId ? !empty.has(n.selfId) : false) || n.subs.length > 0)
        , [tree, empty]);

    const node = mainCat === '__all' ? null : tree.find(n => n.name === mainCat) || null;
    const visNode = mainCat === '__all' ? null : visTree.find(n => n.name === mainCat) || null;
    // Catálogo efetivo selecionado (sub escolhida → ela; senão o "pai" não-vazio,
    // senão a 1ª sub não-vazia).
    const selId = mainCat === '__all' ? null
        : (subCat !== '__all' ? subCat
            : ((node?.selfId && !empty.has(node.selfId)) ? node.selfId
                : (node?.subs.find(s => !empty.has(s.id))?.id || node?.selfId || node?.subs[0]?.id || null)));

    const metasOf = (id: string | null) => {
        if (!id) return [];
        const r = [...movieRows, ...seriesRows].find(x => x.id === id);
        return r ? r.metas : (loaded[id] || []);
    };

    // Lembra a última categoria aberta.
    useEffect(() => { try { localStorage.setItem('rajada.vodcat.v1', JSON.stringify({ main: mainCat, sub: subCat })); } catch { } }, [mainCat, subCat]);
    // Se a categoria lembrada não existe mais no catálogo, volta pra "Tudo".
    useEffect(() => { if (mainCat !== '__all' && tree.length && !tree.find(n => n.name === mainCat)) { setMainCat('__all'); setSubCat('__all'); } }, [tree]);

    // Busca o catálogo selecionado sob demanda; se vier vazio, marca como vazio (some dos botões).
    useEffect(() => {
        if (!selId) return;
        const inRows = [...movieRows, ...seriesRows].some(r => r.id === selId);
        if (inRows || loaded[selId]) return;
        let dead = false; setLoadingCat(true);
        engine.getCatalog({ type: node?.type || 'movie', id: selId })
            .then(({ metas }: any) => {
                if (dead) return;
                const list = metas || []; setLoaded(p => ({ ...p, [selId]: list }));
                if (!list.length) setEmpty(prev => { const n = new Set(prev); n.add(selId); try { localStorage.setItem('rajada.vodempty.v1', JSON.stringify([...n])); } catch { } return n; });
            })
            .catch(() => { if (!dead) setLoaded(p => ({ ...p, [selId]: [] })); })
            .finally(() => { if (!dead) setLoadingCat(false); });
        return () => { dead = true; };
    }, [selId]);

    const pickMain = (name: string) => { setMainCat(name); setSubCat('__all'); };

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
    const art = D.background && !/placehold/.test(D.background) ? D.background : '';
    const noArt = !art; // sem backdrop → mostra o pôster como miniatura (Stremio)

    const progAll = loadProg();
    const prog = (id: string) => { const p = progAll[id]; return p && p.dur ? p.pos / p.dur : 0; };

    const favList = Object.values(loadFav()).filter((m: any) => m.type === 'movie' || m.type === 'series');
    const rows: { id: string; name: string; metas: any[] }[] = [];
    if (cwAll.length) rows.push({ id: '__cw', name: 'Continuar assistindo', metas: cwAll });
    if (favList.length) rows.push({ id: '__fav', name: '★ Minha lista', metas: favList });
    if (featured.length) rows.push({ id: '__feat', name: '⭐ Em alta · Bem avaliados', metas: featured });

    return (
        <div className="vod-view">
            <div className={'vod-board' + (noArt ? ' noart' : '')} style={art ? { backgroundImage: `url("${art}")` } : undefined}>
                <div className="vb-grad" />
                {noArt && D.poster && !/placehold/.test(D.poster) && (
                    <img className="vb-poster" src={D.poster} alt="" loading="lazy"
                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                )}
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
                <div className="vod-catbar">
                    <div className="vod-cats">
                        <button className={`vod-cat${mainCat === '__all' ? ' on' : ''}`} onClick={() => pickMain('__all')} onFocus={focusScroll}>Tudo</button>
                        {visTree.map(n => (
                            <button key={n.name} className={`vod-cat${mainCat === n.name ? ' on' : ''}`} onClick={() => pickMain(n.name)} onFocus={focusScroll}>{n.name}</button>
                        ))}
                    </div>
                    {visNode && visNode.subs.length > 0 && (
                        <div className="vod-subcats">
                            {visNode.selfId && <button className={`vod-sub${subCat === '__all' ? ' on' : ''}`} onClick={() => setSubCat('__all')} onFocus={focusScroll}>Todos</button>}
                            {visNode.subs.map(s => (
                                <button key={s.id} className={`vod-sub${subCat === s.id ? ' on' : ''}`} onClick={() => setSubCat(s.id)} onFocus={focusScroll}>{s.name}</button>
                            ))}
                        </div>
                    )}
                </div>
                {mainCat === '__all' ? (
                    <>
                        {rows.map(r => (
                            <section className="row" key={r.id}><h2>{r.name}</h2>
                                <div className="tiles">{r.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                            </section>
                        ))}
                        {movieRows.length > 0 && <div className="sec-head">Filmes</div>}
                        {movieRows.map(row => (
                            <section className="row" key={row.id}><h2>{row.name}</h2>
                                <div className="tiles">{row.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                            </section>
                        ))}
                        {seriesRows.length > 0 && <div className="sec-head">Séries</div>}
                        {seriesRows.map(row => (
                            <section className="row" key={row.id}><h2>{row.name}</h2>
                                <div className="tiles">{row.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                            </section>
                        ))}
                    </>
                ) : (() => {
                    const metas = metasOf(selId);
                    if (loadingCat && !metas.length) return <div className="connecting"><span className="spin" /> Carregando categoria…</div>;
                    if (!metas.length) return <div className="status">Nada nesta categoria.</div>;
                    const subName = subCat !== '__all' ? (node?.subs.find(s => s.id === subCat)?.name || '') : '';
                    const name = subName ? `${mainCat} · ${subName}` : mainCat;
                    return (
                        <section className="vod-cat-sec">
                            <h2 className="sec-head">{name} <span className="vod-cat-count">{metas.length}</span></h2>
                            <div className="vod-grid">{metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                        </section>
                    );
                })()}
            </div>
        </div>
    );
}

function Tile({ meta, onPlay, onFocusItem, progress }: { meta: any; onPlay: () => void; onFocusItem?: (m: any) => void; progress?: number }) {
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
            {progress != null && progress > 0.02 && progress < 0.97 && (
                <span className="tile-prog"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
            )}
            <span className="tile-name">{meta.name}</span>
        </button>
    );
}

export default App;
