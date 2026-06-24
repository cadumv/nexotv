import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import type { AddonConfig, EngineOptions, NexoEngine } from '@nexotv/core';
import { createEngine } from './engineHost';

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
type Section = 'pick' | 'movies' | 'series' | 'channels';
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
    const [picker, setPicker] = useState<{ title: string; options: { label: string; url: string }[] } | null>(null);
    const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
    const [cw, setCw] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem('rajada.cw.v1') || '[]'); } catch { return []; } });
    const homeRef = useRef<HTMLDivElement>(null);
    const builtRef = useRef({ vod: false, channels: false });

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
        const pick = (id: string) => cats.find((c: any) => c.id === id);
        // "Jogos do Dia" como 1ª categoria (estilo TV), depois as categorias de canais.
        const defs = [pick('nexotv_games'), ...cats.filter((c: any) => c.id.startsWith('iptv_channels_g_'))].filter(Boolean);
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

    // Constrói a seção ao entrar nela (uma vez).
    useEffect(() => {
        if (!engine || !saved) return;
        if ((section === 'movies' || section === 'series') && !builtRef.current.vod) { builtRef.current.vod = true; buildVod(engine, saved.options); }
        if (section === 'channels' && !builtRef.current.channels) { builtRef.current.channels = true; buildChannels(engine); }
    }, [section, engine, saved, buildVod, buildChannels]);

    const logout = () => { localStorage.removeItem(LS_KEY); setSaved(null); setEngine(null); setSection('pick'); builtRef.current = { vod: false, channels: false }; };

    if (!saved) return <Setup onSave={(s) => { localStorage.setItem(LS_KEY, JSON.stringify(s)); setSaved(s); }} />;
    if (section === 'pick') return <PickScreen onPick={setSection} onLogout={logout} status={!engine ? (status || 'Conectando…') : ''} />;

    const cwFor = (t: string) => cw.filter((m: any) => m.type === t);

    return (
        <div className={`home ${section}`} ref={homeRef} onKeyDown={section === 'channels' ? undefined : onKey}>
            <header className="topbar">
                <button className="brand-sm" onClick={() => setSection('pick')}>RAJADA</button>
                <nav className="tabs-top">
                    <button className={section === 'movies' ? 'on' : ''} onClick={() => setSection('movies')}>Filmes</button>
                    <button className={section === 'series' ? 'on' : ''} onClick={() => setSection('series')}>Séries</button>
                    <button className={section === 'channels' ? 'on' : ''} onClick={() => setSection('channels')}>Canais</button>
                </nav>
                <button className="logout" onClick={logout}>sair</button>
            </header>

            {status && <div className="status">{status}</div>}

            {section === 'movies' && <Rows rows={movieRows} cw={cwFor('movie')} onOpen={openItem} loading={vodLoading} empty="Nenhum filme (provedor fora do ar?)" />}
            {section === 'series' && <Rows rows={seriesRows} cw={cwFor('series')} onOpen={openItem} loading={vodLoading} empty="Nenhuma série (provedor fora do ar?)" />}
            {section === 'channels' && engine && <ChannelsView engine={engine} cats={chanCats} flat={chanFlat} catFirst={catFirst} loading={chanLoading} />}

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

/** Tela inicial: 3 cards (Filmes / Séries / Canais). */
function PickScreen({ onPick, onLogout, status }: { onPick: (s: Section) => void; onLogout: () => void; status: string }) {
    return (
        <div className="pick">
            <h1 className="brand">RAJADA</h1>
            <p className="pick-sub">O que você quer assistir?</p>
            <div className="pick-cards">
                <button className="pick-card pc-movies" onClick={() => onPick('movies')}><span className="pc-emoji">🎬</span><span>Filmes</span></button>
                <button className="pick-card pc-series" onClick={() => onPick('series')}><span className="pc-emoji">📺</span><span>Séries</span></button>
                <button className="pick-card pc-tv" onClick={() => onPick('channels')}><span className="pc-emoji">📡</span><span>Canais ao vivo</span></button>
            </div>
            {status && <div className="status">{status}</div>}
            <button className="logout pick-logout" onClick={onLogout}>sair</button>
        </div>
    );
}

/** Fileiras estilo Netflix (filmes/séries). */
function Rows({ rows, cw, onOpen, loading, empty }: { rows: Row[]; cw: any[]; onOpen: (m: any) => void; loading: boolean; empty: string }) {
    if (loading && !rows.length) return <div className="status">Carregando…</div>;
    if (!loading && !rows.length) return <div className="status">{empty}</div>;
    return (
        <>
            {cw.length > 0 && (
                <section className="row"><h2>Continuar Assistindo</h2>
                    <div className="tiles">{cw.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} />)}</div>
                </section>
            )}
            {rows.map(row => (
                <section className="row" key={row.id}><h2>{row.name}</h2>
                    <div className="tiles">{row.metas.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => onOpen(m)} />)}</div>
                </section>
            ))}
        </>
    );
}

/** Canais ao vivo: escolhe categoria → lista de canais + player ao lado. Zapeia
 *  ↑↓ atravessando categorias (divisor mostra onde cada uma acaba). Voltar volta
 *  pras categorias. */
function ChannelsView({ engine, cats, flat, catFirst, loading }: {
    engine: NexoEngine; cats: { id: string; name: string; count: number; sample?: any }[]; flat: FlatItem[]; catFirst: Record<string, number>; loading: boolean;
}) {
    const [showCats, setShowCats] = useState(true);
    const [idx, setIdx] = useState(-1);          // índice (no flat) do canal selecionado
    const [url, setUrl] = useState('');
    const [title, setTitle] = useState('');
    const [opts, setOpts] = useState<any[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const timer = useRef<any>(null);

    const chanIdxs = useMemo(() => { const a: number[] = []; flat.forEach((f, i) => { if (f.kind === 'chan') a.push(i); }); return a; }, [flat]);

    const loadStream = useCallback(async (i: number) => {
        const it = flat[i]; if (!it || it.kind !== 'chan') return;
        setTitle(it.meta.name);
        try { const streams = await engine.getStreams(it.meta.id); setOpts(streams); setUrl(streams[0]?.url || ''); }
        catch { setOpts([]); setUrl(''); }
    }, [engine, flat]);

    const select = useCallback((i: number, now = false) => {
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 380);  // debounce no zapping
        setTimeout(() => scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }, [loadStream]);

    const pickCat = (catId: string) => {
        const h = catFirst[catId];
        let fc = -1;
        for (let i = h + 1; i < flat.length; i++) { if (flat[i].kind === 'chan') { fc = i; break; } if (flat[i].kind === 'header') break; }
        setShowCats(false);
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
        else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); setShowCats(true); }
    };

    const label = (n: string) => (n || '').replace(/^Canais\s*\|\s*/i, '').trim() || n;
    const curCatName = idx >= 0 ? label(cats.find(c => c.id === flat[idx]?.catId)?.name || '') : '';

    if (loading && !flat.length) return <div className="status">Carregando canais…</div>;
    if (!loading && !flat.length) return <div className="status">Nenhum canal (provedor fora do ar?)</div>;

    if (showCats) {
        return (
            <div className="chan-cats">
                <h2 className="chan-h">Canais — escolha uma categoria</h2>
                <div className="cat-grid">
                    {cats.map(c => (
                        <button key={c.id} className="cat-card" onClick={() => pickCat(c.id)}>
                            <span className="cat-name">{label(c.name)}</span>
                            <span className="cat-count">{c.count} canais</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="chan-live" ref={stageRef} tabIndex={0} onKeyDown={onKey}>
            <aside className="chan-list">
                <div className="chan-list-head">
                    <button className="back" onClick={() => setShowCats(true)}>‹ Categorias</button>
                    <span className="cur-cat">{curCatName}</span>
                </div>
                <div className="chan-scroll" ref={scrollRef}>
                    {flat.map((f, i) => f.kind === 'header' ? (
                        <div className="chan-divider" key={'h' + i}><span>{label(f.name)}</span></div>
                    ) : (
                        <button key={i} data-i={i} className={`chan-row${i === idx ? ' on' : ''}`} onClick={() => select(i, true)}>
                            <img className="chan-ico" alt="" loading="lazy"
                                src={(Array.isArray(f.meta.posterChain) && f.meta.posterChain[0]) || f.meta.poster || cardFor(f.meta.name)}
                                onError={(e) => { const c = cardFor(f.meta.name); if (e.currentTarget.src !== c) e.currentTarget.src = c; }} />
                            <span className="chan-name">{f.meta.name}</span>
                        </button>
                    ))}
                </div>
            </aside>
            <main className="chan-stage">
                <LivePlayer url={url} title={title} />
                <div className="chan-now">
                    <span className="now-title">{title || 'Selecione um canal'}</span>
                    {opts.length > 1 && (
                        <div className="now-opts">
                            {opts.map((o, i) => (
                                <button key={i} className={`now-opt${o.url === url ? ' on' : ''}`} onClick={() => setUrl(o.url)}>
                                    {String(o.title || '').replace(/\s*-\s*Live$/i, '').trim() || ('Opção ' + (i + 1))}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}

/** Player embutido (canais ao vivo): troca de fonte ao zapear, sem fechar. */
function LivePlayer({ url, title }: { url: string; title: string }) {
    const ref = useRef<HTMLVideoElement>(null);
    const [err, setErr] = useState(false);
    useEffect(() => {
        setErr(false);
        const v = ref.current; if (!v || !url) return;
        const isHls = /\.m3u8(\?|$)|\.ts(\?|$)/i.test(url) || url.includes('/live/');
        let hls: Hls | null = null;
        if (isHls && Hls.isSupported()) {
            hls = new Hls({ enableWorker: true, lowLatencyMode: false });
            hls.loadSource(url); hls.attachMedia(v);
            hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) setErr(true); });
        } else { v.src = url; v.addEventListener('error', () => setErr(true), { once: true }); }
        const p = v.play(); if (p && p.catch) p.catch(() => { });
        return () => { try { hls?.destroy(); } catch { } };
    }, [url]);
    return (
        <div className="live-player">
            <video ref={ref} controls autoPlay playsInline className="live-video" />
            {!url && <div className="live-empty">▶ Selecione um canal na lista</div>}
            {err && url && (<div className="player-err">Não consegui tocar.<button onClick={() => window.open(url, '_blank')}>Abrir externo</button></div>)}
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
function Tile({ meta, onPlay }: { meta: any; onPlay: () => void }) {
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
        <button className={`tile ${shape}${fill ? ' fill' : ''}`} onClick={onPlay} aria-label={meta.name}>
            <img src={src} alt={meta.name} loading="lazy" crossOrigin={isProxyLogo ? 'anonymous' : undefined}
                onError={onErr} onLoad={onLoad} />
            <span className="tile-name">{meta.name}</span>
        </button>
    );
}

export default App;
