import React, { useEffect, useState, useCallback, useRef } from 'react';
import Hls from 'hls.js';
import type { AddonConfig, EngineOptions, NexoEngine } from '@nexotv/core';
import { createEngine } from './engineHost';

const LS_KEY = 'rajada.config.v1';

interface SavedConfig { config: AddonConfig; options: EngineOptions; }

function loadSaved(): SavedConfig | null {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

/** Tela de setup — funciona com QUALQUER IPTV: Xtream (url/user/senha) ou lista M3U. */
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

function App() {
    const [saved, setSaved] = useState<SavedConfig | null>(loadSaved());
    const [engine, setEngine] = useState<NexoEngine | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const [status, setStatus] = useState('');
    const [picker, setPicker] = useState<{ title: string; options: { label: string; url: string }[] } | null>(null);
    const [playing, setPlaying] = useState<{ url: string; title: string } | null>(null);
    const [cw, setCw] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem('rajada.cw.v1') || '[]'); } catch { return []; } });
    const [hero, setHero] = useState<any | null>(null);
    const homeRef = useRef<HTMLDivElement>(null);

    const recordCw = (meta: any) => {
        setCw(prev => {
            const next = [{ id: meta.id, name: meta.name, poster: meta.poster, posterShape: meta.posterShape, type: meta.type },
            ...prev.filter((x: any) => x.id !== meta.id)].slice(0, 20);
            localStorage.setItem('rajada.cw.v1', JSON.stringify(next));
            return next;
        });
    };

    const play = (url: string, title: string) => { setPicker(null); setPlaying({ url, title }); };

    const openItem = useCallback(async (meta: any) => {
        if (!engine) return;
        const streams = await engine.getStreams(meta.id);
        if (!streams.length) { setStatus('Sem stream disponível'); setTimeout(() => setStatus(''), 2500); return; }
        recordCw(meta);
        if (streams.length === 1) { play(streams[0].url, meta.name); return; }
        // Várias opções (qualidades / canais da família) → mostra o seletor.
        setPicker({
            title: meta.name,
            options: streams.map((s: any) => ({ label: String(s.title || '').replace(/\s*-\s*Live$/i, '').trim() || meta.name, url: s.url })),
        });
    }, [engine]);

    // Navegação por controle (D-pad): setas movem o foco entre tiles/fileiras.
    const onKey = useCallback((e: React.KeyboardEvent) => {
        const k = e.key;
        if (!k.startsWith('Arrow')) return;
        const root = homeRef.current; if (!root) return;
        const rowsEls = Array.from(root.querySelectorAll('.tiles')) as HTMLElement[];
        const active = document.activeElement as HTMLElement;
        const focusIn = (row: HTMLElement, idx: number) => { const t = Array.from(row.querySelectorAll('.tile')) as HTMLElement[]; t[Math.max(0, Math.min(idx, t.length - 1))]?.focus(); };
        const ri = rowsEls.findIndex(r => r.contains(active));
        e.preventDefault();
        if (ri < 0) { if (rowsEls[0]) focusIn(rowsEls[0], 0); }
        else {
            const tiles = Array.from(rowsEls[ri].querySelectorAll('.tile')) as HTMLElement[];
            const ci = tiles.indexOf(active);
            if (k === 'ArrowRight') tiles[Math.min(ci + 1, tiles.length - 1)]?.focus();
            else if (k === 'ArrowLeft') tiles[Math.max(ci - 1, 0)]?.focus();
            else if (k === 'ArrowDown') { if (rowsEls[ri + 1]) focusIn(rowsEls[ri + 1], ci); }
            else if (k === 'ArrowUp') { if (rowsEls[ri - 1]) focusIn(rowsEls[ri - 1], ci); else (root.querySelector('.hero-play') as HTMLElement)?.focus(); }
        }
        setTimeout(() => (document.activeElement as HTMLElement)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), 0);
    }, []);

    const boot = useCallback(async (s: SavedConfig) => {
        setStatus('Carregando…');
        try {
            const eng = await createEngine(s.config, s.options);
            setEngine(eng);
            const man = eng.getManifest();
            const cats: any[] = man.catalogs;
            // Ordem estilo "TV paga": Futebol → categorias de canais (grade) →
            // Filmes (+ alguns gêneros) → Séries.
            const pick = (id: string) => cats.find((c: any) => c.id === id);
            const ordered: any[] = [
                pick('nexotv_games'),
                ...cats.filter((c: any) => c.id.startsWith('iptv_channels_g_')),
                pick('nexotv_vod'),
                ...cats.filter((c: any) => c.id.startsWith('nexotv_vod_g_')).slice(0, 8),
                pick('nexotv_series'),
                ...cats.filter((c: any) => c.id.startsWith('nexotv_series_g_')).slice(0, 6),
            ].filter(Boolean);
            // Constrói as fileiras em paralelo (carrega rápido).
            const built = (await Promise.all(ordered.map(async (c: any) => {
                try {
                    const { metas } = await eng.getCatalog({ type: c.type, id: c.id });
                    return metas.length ? { id: c.id, type: c.type, name: c.name, metas: metas.slice(0, 30) } as Row : null;
                } catch { return null; }
            }))).filter(Boolean) as Row[];
            setRows(built);
            setStatus(built.length ? '' : 'Nenhum conteúdo (provedor fora do ar?)');

            // Banner de destaque (hero): um filme/série com capa; busca a arte landscape no meta.
            (async () => {
                const cand = built.flatMap(r => r.metas).find((m: any) => (m.type === 'movie' || m.type === 'series') && m.poster && !/placehold/.test(m.poster))
                    || built.flatMap(r => r.metas)[0];
                if (!cand) return;
                let image = cand.poster; let description = '';
                try { const mm = await eng.getMeta(cand.type, cand.id); image = mm.meta?.background || mm.meta?.poster || cand.poster; description = mm.meta?.description || ''; } catch { }
                setHero({ ...cand, image, description });
            })();

            // Posters dinâmicos (TMDB) — preenche capas faltantes em 2º plano (estilo Stremio).
            if (s.options.tmdbApiKey) {
                (async () => {
                    const targets: { rowId: string; id: string }[] = [];
                    for (const r of built) if (r.type === 'movie' || r.type === 'series')
                        for (const m of r.metas) if (!m.poster || /placehold\.co/.test(m.poster)) targets.push({ rowId: r.id, id: m.id });
                    let i = 0;
                    const worker = async () => {
                        while (i < targets.length) {
                            const t = targets[i++];
                            const url = await eng.getTmdbPosterFor(t.id).catch(() => null);
                            if (url) for (const r of built) if (r.id === t.rowId) for (const m of r.metas) if (m.id === t.id) m.poster = url;
                        }
                    };
                    await Promise.all(Array.from({ length: 4 }, worker));
                    setRows(built.map(r => ({ ...r, metas: [...r.metas] })));
                })();
            }
        } catch (e: any) {
            setStatus('Erro: ' + (e?.message || e));
        }
    }, []);

    useEffect(() => { if (saved) boot(saved); }, [saved, boot]);

    if (!saved) return <Setup onSave={(s) => { localStorage.setItem(LS_KEY, JSON.stringify(s)); setSaved(s); }} />;

    return (
        <div className="home" ref={homeRef} onKeyDown={onKey}>
            <header className="topbar"><span className="brand-sm">RAJADA</span>
                <button className="logout" onClick={() => { localStorage.removeItem(LS_KEY); setSaved(null); setEngine(null); setRows([]); }}>sair</button>
            </header>

            {hero && (
                <section className="hero" style={{ backgroundImage: `url("${hero.image}")` }}>
                    <div className="hero-grad" />
                    <div className="hero-info">
                        <h1 className="hero-title">{hero.name}</h1>
                        {hero.description && <p className="hero-desc">{String(hero.description).split('\n')[0]}</p>}
                        <button className="hero-play" onClick={() => openItem(hero)}>▶ Assistir</button>
                    </div>
                </section>
            )}

            {status && <div className="status">{status}</div>}

            {cw.length > 0 && (
                <section className="row">
                    <h2>Continuar Assistindo</h2>
                    <div className="tiles">{cw.map((m: any) => <Tile key={m.id} meta={m} onPlay={() => openItem(m)} />)}</div>
                </section>
            )}

            {rows.map(row => (
                <section className="row" key={row.id}>
                    <h2>{row.name}</h2>
                    <div className="tiles">
                        {row.metas.map((m: any) => (
                            <Tile key={m.id} meta={m} onPlay={() => openItem(m)} />
                        ))}
                    </div>
                </section>
            ))}

            {picker && (
                <div className="modal" onClick={() => setPicker(null)}>
                    <div className="modal-box" onClick={e => e.stopPropagation()}>
                        <h3>{picker.title}</h3>
                        <p className="modal-sub">Escolha a opção</p>
                        <div className="opts">
                            {picker.options.map((o, i) => (
                                <button key={i} className="opt" onClick={() => play(o.url, o.label)}>{o.label}</button>
                            ))}
                        </div>
                        <button className="modal-close" onClick={() => setPicker(null)}>fechar</button>
                    </div>
                </div>
            )}

            {playing && <Player url={playing.url} title={playing.title} onClose={() => setPlaying(null)} />}
        </div>
    );
}

/** Player em tela cheia: HLS via hls.js; senão <video> nativo; fallback "abrir externo".
 *  No APK, um plugin ExoPlayer nativo pode substituir isto (ver README). */
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

function Tile({ meta, onPlay }: { meta: any; onPlay: () => void }) {
    const shape = meta.posterShape || 'poster';
    return (
        <button className={`tile ${shape}`} onClick={onPlay} aria-label={meta.name}>
            {meta.poster && <img src={meta.poster} alt={meta.name} loading="lazy" />}
            <span className="tile-name">{meta.name}</span>
        </button>
    );
}

export default App;
