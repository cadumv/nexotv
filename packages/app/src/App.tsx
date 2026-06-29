import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Hls from 'hls.js';
import { attachAdaptive, createThumbnailer, type Thumbnailer } from './player';
import type { AddonConfig, EngineOptions, NexoEngine } from '@nexotv/core';
import { createEngine, tmdbPoster, tmdbTrendingPoster } from './engineHost';
import { UpdateBanner } from './UpdateBanner';

const LS_KEY = 'proza.config.v1';

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
        const options: EngineOptions = { addonName: 'Proza', sofascoreAgendaUrl: agenda.trim() || null, tmdbApiKey: tmdb.trim() || null };
        if (mode === 'xtream') {
            onSave({ config: { provider: 'xtream', xtreamUrl: url.trim(), xtreamUsername: user.trim(), xtreamPassword: pass.trim(), enableVod: true }, options });
        } else {
            onSave({ config: { provider: 'm3u', m3uUrl: m3u.trim(), epgUrl: epg.trim() || undefined }, options });
        }
    };
    return (
        <div className="setup">
            <h1 className="brand">Proza</h1>
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

// Aparelho de BAIXA POTÊNCIA (Fire TV / smart TV / Android TV): CPU/GPU fracos, e o
// provedor IPTV limita a ~2 conexões simultâneas. Nesses, o pré-carregamento em 2ª
// janela (2º decode + 2º worker hls + 2ª conexão) ROUBA recurso do stream principal e
// o faz TRAVAR enquanto se assiste. Aqui detectamos pra: desligar o prefetch, usar
// buffer maior (mais liso) e limitar a quantidade de cards renderados (menos lag).
const LOW_POWER: boolean = (() => {
    try {
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        // Fire TV (AFT*), Tizen (Samsung), WebOS (LG), Android TV / Google TV, smart TVs.
        if (/\bAFT|BRAVIA|Tizen|Web0?S|GoogleTV|Google TV|SMART[-\s]?TV|HbbTV|NetCast|VIDAA|DTV|Roku\b/i.test(ua)) return true;
        if (/Android/i.test(ua) && /\bTV\b/i.test(ua)) return true;
        const hc = (typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency) || 0;
        if (hc > 0 && hc <= 2) return true;
    } catch { }
    return false;
})();

// Limites de renderização (anti-lag). Cada card é um <button> + <img>; a aba "Tudo"
// chegava a renderizar MILHARES → travava a navegação (cada seta varre todos os
// focáveis com getBoundingClientRect). As fileiras da home são prévias (cap baixo) e o
// grid de categoria carrega em páginas (botão "carregar mais").
const ROW_CAP = LOW_POWER ? 18 : 40;        // máx. de cards por fileira na home
const GRID_PAGE = LOW_POWER ? 60 : 120;     // 1ª página do grid de uma categoria

// --- Navegação por D-pad (controle de TV): movimento espacial do foco -----------
// Elementos focáveis VISÍVEIS na tela.
function navFocusables(): HTMLElement[] {
    const sel = 'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href], input:not([disabled])';
    // Se há um overlay aberto (detalhes/busca/player/tela cheia), confina o D-pad a ele
    // — senão o foco "vaza" pros cards atrás do modal.
    const overlay = document.querySelector('.details-box, .search-ov, .player-box, .live-player.fs') as HTMLElement | null;
    let root: ParentNode = overlay || document;
    if (!overlay) {
        // No palco do player (player + provedores), restringe a busca a ele — evita
        // varrer centenas de botões de canal a cada tecla (lag na TV).
        const stage = (document.activeElement as HTMLElement | null)?.closest('.chan-stage');
        if (stage) root = stage;
    }
    return Array.from(root.querySelectorAll<HTMLElement>(sel))
        // tabindex="-1" (ex.: logo Proza) NÃO é alvo de D-pad, mesmo sendo <button>.
        .filter(el => el.tabIndex !== -1 && el.offsetWidth > 0 && el.offsetHeight > 0 && el.getClientRects().length > 0);
}

// Pilha de "voltar": o botão Voltar do controle (na TV, via @capacitor/app) executa o
// handler do topo (sai da tela cheia → fecha modal → volta de tela); vazio = sai do app.
const backStack: Array<() => void> = [];
function useBackHandler(active: boolean, fn: () => void) {
    const ref = useRef(fn); ref.current = fn;
    useEffect(() => {
        if (!active) return;
        const h = () => ref.current();
        backStack.push(h);
        return () => { const i = backStack.lastIndexOf(h); if (i >= 0) backStack.splice(i, 1); };
    }, [active]);
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
    if (best) {
        best.focus();
        // 'center' faz a tela ACOMPANHAR o foco (estilo TV/Netflix): ao descer pelas
        // fileiras, a focada sobe pro centro; 'nearest' antes mal rolava (foco saía da tela).
        best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
        return true;
    }
    return false;
}

// Leva o foco pras abas do topo (Filmes/Canais/Jogos) — usado quando ↑ no player
// não tem pra onde ir dentro do stage.
function focusTopbar() {
    const b = (document.querySelector('.tabs-top button.on') || document.querySelector('.tabs-top button')) as HTMLElement | null;
    b?.focus();
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
            e.preventDefault();
            const before = a;
            const moved = spatialMove(e.key);   // move ENTRE player/provedores (escopo do stage)
            const na = document.activeElement as HTMLElement | null;
            if (na && na.closest('.chan-list')) { stage?.focus(); return; }  // caiu na lista → modo zap
            if (!moved || na === before) {
                // Nada na direção dentro do stage → sai dele:
                if (e.key === 'ArrowLeft') stage?.focus();        // ← (esquerda esgotada) vai pra lista de canais
                else if (e.key === 'ArrowUp') focusTopbar();      // ↑ (topo do player) vai pras abas do topo
                // ↓/→ sem alvo: permanece (não há pra onde ir)
            }
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
    const [cw, setCw] = useState<any[]>(() => { try { return JSON.parse(localStorage.getItem('proza.cw.v1') || '[]'); } catch { return []; } });
    const homeRef = useRef<HTMLDivElement>(null);
    const builtRef = useRef({ vod: false, channels: false, games: false });

    const recordCw = (meta: any) => {
        setCw(prev => {
            const next = [{ id: meta.id, name: meta.name, poster: meta.poster, posterChain: meta.posterChain, posterShape: meta.posterShape, type: meta.type },
            ...prev.filter((x: any) => x.id !== meta.id)].slice(0, 20);
            localStorage.setItem('proza.cw.v1', JSON.stringify(next));
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

    // Botão Voltar do controle (Android TV) → pilha de voltar; vazio = sai do app.
    useEffect(() => {
        let handle: any;
        import('@capacitor/app').then(({ App: CapApp }: any) => {
            CapApp.addListener('backButton', () => {
                if (backStack.length) backStack[backStack.length - 1]();
                else CapApp.exitApp();
            }).then((h: any) => { handle = h; });
        }).catch(() => { /* web/desktop: sem Capacitor, usa-se Esc */ });
        return () => { try { handle?.remove?.(); } catch { } };
    }, []);

    // Voltar de uma seção → tela inicial (overlays empilham por cima e voltam antes).
    useBackHandler(section !== 'pick', () => setSection('pick'));

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
        await (eng as any).vodReady;   // VOD/séries carregam em 2º plano — espera ficarem prontos
        const cats: any[] = eng.getManifest().catalogs;
        const pick = (id: string) => cats.find((c: any) => c.id === id);
        const buildRows = async (defs: any[]) => (await Promise.all(defs.filter(Boolean).map(async (c: any) => {
            try { const { metas } = await eng.getCatalog({ type: c.type, id: c.id }); return metas.length ? { id: c.id, type: c.type, name: c.name, metas: metas.slice(0, 30) } as Row : null; } catch { return null; }
        }))).filter(Boolean) as Row[];
        // Exclui grupos do provedor com o MESMO nome do base ("Filmes"/"Series") — são
        // catch-alls degenerados (ex.: um grupo "Filmes" com 1 item) que apareciam como
        // uma fileira "Filmes" de 1 item, confusa, ao lado do base que tem todos.
        const dupBase = (c: any, base: string) => (c.name || '').trim().toLowerCase() === base.toLowerCase();
        const mr = await buildRows([pick('nexotv_vod'), ...cats.filter((c: any) => c.id.startsWith('nexotv_vod_g_') && !dupBase(c, 'Filmes')).slice(0, 8)]);
        const sr = await buildRows([pick('nexotv_series'), ...cats.filter((c: any) => c.id.startsWith('nexotv_series_g_') && !dupBase(c, 'Series')).slice(0, 6)]);
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
        (eng as any).ensureEpg?.();   // EPG sob demanda: começa a carregar/parsear (em Worker) ao abrir Canais
        const cats: any[] = eng.getManifest().catalogs;
        // Só categorias de canais (os jogos têm seção própria agora).
        const defs = cats.filter((c: any) => c.id.startsWith('iptv_channels_g_'));
        // Pagina cada categoria até trazer TODOS os canais (getCatalog devolve ~100/página).
        const fetchAllChans = async (c: any) => {
            const PAGE = 100; const all: any[] = [];
            for (let skip = 0; skip < 6000; skip += PAGE) {
                let metas: any[] = [];
                try { ({ metas } = await eng.getCatalog({ type: c.type, id: c.id, extra: { skip: String(skip) } })); } catch { break; }
                all.push(...(metas || []));
                if (!metas || metas.length < PAGE) break;
            }
            return { c, metas: all };
        };
        const results = await Promise.all(defs.map(fetchAllChans));
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
        // Carga IMEDIATA: os campeonatos vêm da agenda (Worker) + canais já carregados
        // na 1ª fase — NÃO dependem do EPG/VOD do 2º plano. No nativo (TV) esse 2º plano
        // baixa um catálogo enorme e demora/trava; bloquear os Jogos nele deixava a tela
        // vazia na TV (no notebook resolvia rápido, por isso só falhava na TV).
        try {
            const { metas } = await eng.getCatalog({ type: 'tv', id: 'nexotv_games' });
            setGamesMetas(metas || []);
        } catch { setGamesMetas([]); }
        setGamesLoading(false);
        // Enriquece com os jogos casados pelo EPG. Dispara o EPG SOB DEMANDA (leve, em
        // Worker) em vez de esperar o `vodReady` (fase 2 = baixar o VOD inteiro, que na
        // TV trava/demora demais). Sem o EPG só vinha a agenda (≈ só Brasileirão); com ele
        // entram os demais campeonatos — igual ao navegador.
        try {
            await (eng as any).ensureEpg?.();
            const { metas } = await eng.getCatalog({ type: 'tv', id: 'nexotv_games' });
            if (metas && metas.length) setGamesMetas(metas);
        } catch { /* mantém a carga imediata */ }
    }, []);

    // Constrói a seção ao entrar nela (uma vez).
    useEffect(() => {
        if (!engine || !saved) return;
        if (section === 'vod' && !builtRef.current.vod) { builtRef.current.vod = true; buildVod(engine, saved.options); }
        if (section === 'channels' && !builtRef.current.channels) { builtRef.current.channels = true; buildChannels(engine); }
        if (section === 'games' && !builtRef.current.games) { builtRef.current.games = true; buildGames(engine); }
    }, [section, engine, saved, buildVod, buildChannels, buildGames]);

    // Arte dos cards da tela inicial (estilo Netflix). Os TRÊS carregam EM PARALELO e
    // cada um aparece assim que fica pronto (não espera os outros). O card de Filmes
    // NÃO depende mais do catálogo do 2º plano: usa um pôster em alta do TMDB na hora
    // (e, se a biblioteca já estiver carregada, prefere um pôster real dela).
    useEffect(() => {
        if (!engine) return;
        let dead = false;
        const set = (k: 'vod' | 'tv' | 'live', v?: string | null) => { if (!dead && v) setPickArt(p => ({ ...p, [k]: v })); };
        (async () => {
            try {
                const { metas } = await engine.getCatalog({ type: 'movie', id: 'nexotv_vod' });
                const withP = metas.find((m: any) => m.poster && !/placehold/.test(m.poster));
                if (withP) { set('vod', withP.poster); return; }
            } catch { /* sem catálogo ainda → TMDB abaixo */ }
            set('vod', await tmdbTrendingPoster().catch(() => null));
        })();
        (async () => set('tv', (await tmdbPoster('jornal nacional').catch(() => null)) || (await tmdbPoster('telejornal').catch(() => null))))();
        (async () => set('live', (await tmdbPoster('Pelé').catch(() => null)) || (await tmdbPoster('Ronaldo').catch(() => null)) || (await tmdbPoster('Maradona').catch(() => null))))();
        return () => { dead = true; };
    }, [engine]);

    const logout = () => { localStorage.removeItem(LS_KEY); setSaved(null); setEngine(null); setSection('pick'); builtRef.current = { vod: false, channels: false, games: false }; };

    if (!saved) return <Setup onSave={(s) => { localStorage.setItem(LS_KEY, JSON.stringify(s)); setSaved(s); }} />;
    // Enquanto conecta ao provedor (IPTV pode demorar), mostra um loading da marca ANTES
    // da tela de seleção — evita os cards aparecerem sem imagem / entrar numa seção vazia.
    if (section === 'pick' && !engine) return <BootScreen status={status || 'Conectando ao provedor…'} error={/^erro/i.test(status)} />;
    if (section === 'pick') return (<><UpdateBanner /><PickScreen onPick={setSection} onLogout={logout} status="" art={pickArt} /></>);

    const cwAll = cw.filter((m: any) => m.type === 'movie' || m.type === 'series');

    return (
        <div className={`home ${section}`} ref={homeRef}>
            <UpdateBanner />
            <header className="topbar">
                <button className="brand-sm" tabIndex={-1} onClick={() => setSection('pick')}>Proza</button>
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

/** Loading da marca exibido enquanto conecta ao provedor (antes da tela de seleção).
 *  IPTV pode demorar a responder — melhor um loading claro do que cards vazios. */
function BootScreen({ status, error }: { status: string; error?: boolean }) {
    return (
        <div className="boot">
            <div className="boot-mark">Proza</div>
            {!error && <span className="boot-spin" />}
            <div className={`boot-status${error ? ' err' : ''}`}>{status}</div>
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
            <header className="pick-top"><span className="brand-sm">Proza</span><button className="logout" onClick={onLogout}>sair</button></header>
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

// Tira o prefixo "Canais | " do nome da categoria (usado na lista e no cabeçalho).
const chanLabel = (n: string) => (n || '').replace(/^Canais\s*\|\s*/i, '').trim() || n;

// Alturas FIXAS dos itens da lista virtualizada (px). Essenciais p/ calcular offsets
// sem medir o DOM. Mantidas em sincronia com .chan-virt .chan-row / .chan-divider no CSS.
const VROW_H = 48, VHEAD_H = 30;

// Ícone do canal, encolhido: os logos vêm do proxy wsrv.nl em 320px e eram decodificados
// em 320px (centenas deles = trava na TV). O ícone tem 38px → pede 96px (suficiente p/ HiDPI).
const ICON_W = 96;
function iconSrc(meta: any): string {
    let s = (Array.isArray(meta.posterChain) && meta.posterChain[0]) || meta.poster || cardFor(meta.name);
    if (typeof s === 'string' && s.includes('wsrv.nl')) {
        s = /[?&]w=\d+/.test(s) ? s.replace(/([?&]w=)\d+/, '$1' + ICON_W) : (s + (s.includes('?') ? '&' : '?') + 'w=' + ICON_W);
    }
    return s;
}

// Logos já baixados (por URL): uma vez carregados, nunca "rebaixam" pro placeholder,
// mesmo rolando — evita piscar. Decodificar logos remotos durante a rolagem rápida era
// o que restava travando (lista virtualizada já roda a 52fps sem imagens).
const loadedIcons = new Set<string>();

// Linha de canal (posicionada por `top` absoluto na lista virtualizada). Durante a
// rolagem (`defer`), mostra o card local SVG (instantâneo); o logo real entra quando
// a rolagem para — ou já está, se foi carregado antes.
const VRow = React.memo(function VRow({ meta, index, onSelect, selected, top, defer }: { meta: any; index: number; onSelect: (i: number) => void; selected: boolean; top: number; defer: boolean }) {
    const real = iconSrc(meta);
    const showReal = !defer || loadedIcons.has(real);
    return (
        <button data-i={index} className={'chan-row' + (selected ? ' on' : '')} style={{ top }} onClick={() => onSelect(index)}>
            <img className="chan-ico" alt="" loading="lazy" decoding="async"
                src={showReal ? real : cardFor(meta.name)}
                onLoad={() => { if (showReal) loadedIcons.add(real); }}
                onError={(e) => { const c = cardFor(meta.name); const img = e.currentTarget as HTMLImageElement; if (img.src !== c) img.src = c; }} />
            <span className="chan-name">{meta.name}</span>
        </button>
    );
});

// Lista de canais VIRTUALIZADA: renderiza só as ~linhas visíveis (+overscan). Com 700+
// canais, a lista plana criava uma camada de ~40.000px que o compositor da TV não
// conseguia rasterizar (rolagem a 5fps). Virtualizando, o DOM tem ~30 nós e rola liso.
function VChannelList({ vflat, offsets, total, selectedIdx, onSelect, scrollRef }: {
    vflat: FlatItem[]; offsets: number[]; total: number; selectedIdx: number;
    onSelect: (i: number) => void; scrollRef: React.RefObject<HTMLDivElement>;
}) {
    const [, force] = useState(0);
    const [vh, setVh] = useState(500);
    const [scrolling, setScrolling] = useState(false);
    const settleTimer = useRef<any>(null);
    useEffect(() => {
        const sc = scrollRef.current; if (!sc) return;
        setVh(sc.clientHeight);
        let raf: number | null = null;
        const onScroll = () => {
            setScrolling(true);   // no-op se já true (React ignora)
            clearTimeout(settleTimer.current);
            settleTimer.current = setTimeout(() => setScrolling(false), 140);  // logos entram quando para
            if (raf != null) return; raf = requestAnimationFrame(() => { raf = null; force(t => t + 1); });
        };
        sc.addEventListener('scroll', onScroll, { passive: true });
        const ro = new ResizeObserver(() => setVh(sc.clientHeight)); ro.observe(sc);
        return () => { sc.removeEventListener('scroll', onScroll); ro.disconnect(); if (raf != null) cancelAnimationFrame(raf); clearTimeout(settleTimer.current); };
    }, [scrollRef]);

    const sc = scrollRef.current;
    const st = sc ? sc.scrollTop : 0;
    const OVER = 240;                              // px de overscan acima/abaixo
    const top = st - OVER, bot = st + vh + OVER;
    // 1º índice cujo fim ultrapassa o topo visível (busca binária nos offsets).
    let lo = 0, hi = vflat.length - 1, start = vflat.length ? vflat.length - 1 : 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (offsets[mid + 1] > top) { start = mid; hi = mid - 1; } else lo = mid + 1; }
    const items: any[] = [];
    for (let i = start; i < vflat.length && offsets[i] < bot; i++) {
        const f = vflat[i];
        if (f.kind === 'header') items.push(<div key={'h' + i} className="chan-divider" data-h={i} style={{ top: offsets[i] }}><span>{chanLabel(f.name)}</span></div>);
        else items.push(<VRow key={i} meta={f.meta} index={i} onSelect={onSelect} selected={i === selectedIdx} top={offsets[i]} defer={scrolling} />);
    }
    return <div className="chan-virt" style={{ height: total }}>{items}</div>;
}

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
    // Os jogos já mostrados em "Próximos" NÃO se repetem nas competições abaixo (evita o
    // mesmo jogo duas vezes — bug visível quando faltam nomes de campeonato).
    const upSet = new Set(upcoming);
    const groups = new Map<string, any[]>();
    for (const m of rest) { if (upSet.has(m)) continue; const k = (m.tournament || '').trim() || 'Outros jogos'; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(m); }
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
    const gridRef = useRef<HTMLDivElement>(null);
    // Navegação VERTICAL explícita (↑/↓) entre hero e fileiras de jogos. Sem isso a
    // geometria global (spatialMove) pulava da 2ª fileira direto pras abas do topo (o
    // scroll centraliza o card e a fileira de cima sai da tela). Aqui pulamos pra
    // faixa vizinha preservando a COLUNA; só ↑ no hero/1ª faixa sobe pras abas.
    const onGamesKey = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const sc = gridRef.current; if (!sc) return;
        const a = document.activeElement as HTMLElement | null; if (!a || !sc.contains(a)) return;
        const groups: HTMLElement[][] = [];
        const hero = sc.querySelector<HTMLElement>('.games-hero .game-card'); if (hero) groups.push([hero]);
        for (const s of sc.querySelectorAll('section.row')) {
            const t = [...s.querySelectorAll<HTMLElement>('.game-card')]; if (t.length) groups.push(t);
        }
        const gi = groups.findIndex(g => g.includes(a));
        if (gi < 0) return;            // foco fora das faixas → deixa a geometria global agir
        e.preventDefault(); e.stopPropagation();
        const ni = gi + (e.key === 'ArrowDown' ? 1 : -1);
        if (ni < 0) { focusTopbar(); return; }   // acima do hero → abas do topo
        if (ni >= groups.length) return;          // abaixo da última fileira → permanece
        const target = groups[ni];
        const c = a.getBoundingClientRect(); const cx = (c.left + c.right) / 2;
        let best = target[0], bd = Infinity;
        for (const el of target) { const r = el.getBoundingClientRect(); const d = Math.abs((r.left + r.right) / 2 - cx); if (d < bd) { bd = d; best = el; } }
        best.focus({ preventScroll: true });
        // Enquadramento estável (não corta ao voltar pra cima): hero → topo total;
        // fileira → encosta o título no topo do grid; senão centraliza.
        if (ni === 0) { sc.scrollTo({ top: 0, behavior: 'auto' }); return; }
        const sec = best.closest('section.row') as HTMLElement | null;
        if (sec) {
            const delta = sec.getBoundingClientRect().top - (sc.getBoundingClientRect().top + 12);
            sc.scrollBy({ top: delta, behavior: 'auto' });
        } else {
            best.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
    }, []);
    if (loading && !metas.length) return <div className="status">Carregando jogos…</div>;
    if (!loading && !metas.length) return <div className="status">Nenhum jogo encontrado agora. Confira mais tarde.</div>;
    if (watch) return <GameStage engine={engine} metas={metas} start={watch} onBack={() => setWatch(null)} />;
    const { live, upcoming, ordered } = groupGames(metas);
    const featured = live[0] || upcoming[0] || metas[0];   // hero: ao vivo, senão o mais cedo
    const liveRest = featured && featured.live ? live.slice(1) : live;
    const up = upcoming.filter((m: any) => m !== featured);
    const grpFiltered = ordered.map(([n, l]) => [n, l.filter((m: any) => m !== featured)] as [string, any[]]).filter(([, l]) => l.length);
    return (
        <div className="games-grid" ref={gridRef} onKeyDown={onGamesKey}>
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

    const dirRef = useRef<1 | -1>(1);
    const [prefetch, setPrefetch] = useState<string[]>([]);
    const move = (dir: 1 | -1) => {
        dirRef.current = dir;
        const pos = gameIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(gameIdxs.length - 1, pos + dir));
        select(gameIdxs[np]);
    };
    // Zap em TELA CHEIA (↑/↓ no player): troca de jogo sem refocar o stage.
    const zapFs = useCallback((dir: 1 | -1) => {
        dirRef.current = dir;
        const pos = gameIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(gameIdxs.length - 1, pos + dir));
        const i = gameIdxs[np]; if (i == null || i === idx) return;
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), 80);   // coalesce ao segurar ↑/↓
        setTimeout(() => scrollRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
    }, [gameIdxs, idx, loadStream]);
    // PREFETCH do próximo jogo (na direção do zap), ~0,6s após assentar.
    useEffect(() => {
        if (LOW_POWER) return;   // TV: prefetch desligado (ver prefetchInto)
        let dead = false;
        const h = setTimeout(async () => {
            const pos = gameIdxs.indexOf(idx);
            const ni = pos < 0 ? -1 : gameIdxs[pos + dirRef.current];
            const it = ni != null && ni >= 0 ? gflat[ni] : null;
            if (!it || it.kind !== 'game') { if (!dead) setPrefetch([]); return; }
            try { const s = await engine.getStreams(it.meta.id); if (!dead) setPrefetch(dedupStreams(s)[0]?.urls || []); } catch { }
        }, 600);
        return () => { dead = true; clearTimeout(h); };
    }, [idx, gameIdxs, gflat, engine]);
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
                <LivePlayer sources={sources} title={title} onZap={zapFs} prefetch={prefetch}
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
const WATCH_KEY = 'proza.chanwatch.v1';
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

    // EPG sob demanda: quando terminar de carregar/parsear (Worker), atualiza o
    // "agora/a seguir" do canal que já está tocando (a 1ª seleção pode ter ocorrido
    // antes do EPG ficar pronto → mostrava só "AO VIVO").
    useEffect(() => {
        let dead = false;
        (engine as any).ensureEpg?.().then(() => {
            const id = curIdRef.current; if (dead || !id) return;
            engine.getDetailedMeta(id).then((dm: any) => { if (!dead) setEpg(parseEpgDesc(dm?.description)); }).catch(() => { });
        });
        return () => { dead = true; };
    }, [engine]);

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

    // Offsets (top em px) de cada item — base da virtualização e de toda rolagem por
    // índice (sem medir o DOM). offsets[n] = altura total da lista.
    const { rowOffsets, listTotal } = useMemo(() => {
        const o = new Array(vflat.length + 1); let y = 0;
        for (let i = 0; i < vflat.length; i++) { o[i] = y; y += vflat[i].kind === 'header' ? VHEAD_H : VROW_H; }
        o[vflat.length] = y; return { rowOffsets: o as number[], listTotal: y };
    }, [vflat]);

    // Rola o container p/ deixar o índice `i` visível (lista virtualizada → por offset).
    const scrollToIdx = useCallback((i: number, toTop = false) => {
        const sc = scrollRef.current; if (!sc || i < 0) return;
        const t = rowOffsets[i]; const h = sc.clientHeight;
        if (toTop) sc.scrollTop = Math.max(0, t);
        else if (t < sc.scrollTop) sc.scrollTop = Math.max(0, t - VHEAD_H);
        else if (t + VROW_H > sc.scrollTop + h) sc.scrollTop = t + VROW_H - h;
    }, [rowOffsets]);

    // Ao (des)favoritar, a lista reordena → reaponta o índice pro canal que está tocando.
    useEffect(() => {
        if (!curIdRef.current) return;
        const ni = vflat.findIndex(f => f.kind === 'chan' && f.meta.id === curIdRef.current);
        if (ni >= 0) { setIdx(ni); setTimeout(() => scrollToIdx(ni), 0); }
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
        timer.current = setTimeout(() => loadStream(i), now ? 0 : 70);  // debounce no zapping
        setTimeout(() => stageRef.current?.focus(), 0);  // foco no stage (não na linha)
    }, [loadStream, vflat]);

    // Mantém o canal selecionado visível ao zapear (o destaque .on vai via prop na lista).
    useEffect(() => { scrollToIdx(idx); }, [idx, scrollToIdx, mode]);

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
        // Rola o cabeçalho da categoria escolhida pro TOPO da lista.
        setTimeout(() => { scrollToIdx(h, true); stageRef.current?.focus(); }, 0);
    };

    // "Sticky" sem buraco: a categoria do topo da rolagem é refletida na BARRA FIXA
    // externa (.chan-list-head). Com offsets pré-calculados, achar a categoria do topo é
    // só comparar scrollTop aos offsets dos cabeçalhos — ZERO leitura de layout, throttle
    // por requestAnimationFrame (a versão antiga media o DOM a cada scroll = travava).
    const rafRef = useRef<number | null>(null);
    const applyTopCat = useCallback(() => {
        const sc = scrollRef.current; if (!sc) return;
        const st = sc.scrollTop + 1;
        let name = '';
        for (let i = 0; i < vflat.length; i++) {
            if (vflat[i].kind !== 'header') continue;
            if (rowOffsets[i] <= st) name = chanLabel(vflat[i].name); else break;
        }
        setTopCat(prev => (prev === name ? prev : name));
    }, [vflat, rowOffsets]);

    const recalcTopCat = useCallback(() => {
        if (rafRef.current != null) return;            // 1 cálculo por frame, sem forçar layout
        rafRef.current = requestAnimationFrame(() => { rafRef.current = null; applyTopCat(); });
    }, [applyTopCat]);

    // Recalcula a categoria do topo ao trocar a lista/modo.
    useEffect(() => { applyTopCat(); return () => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } }; }, [vflat, mode, applyTopCat]);

    const dirRef = useRef<1 | -1>(1);                       // última direção de zap (p/ prever o vizinho)
    const [prefetch, setPrefetch] = useState<string[]>([]); // fonte do próximo canal (pré-carregar)
    const move = (dir: 1 | -1) => {
        dirRef.current = dir;
        const pos = chanIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(chanIdxs.length - 1, pos + dir));
        select(chanIdxs[np]);
    };
    // Zap em TELA CHEIA (↑/↓ no player): troca de canal sem refocar o stage — o player
    // continua focado e a lista atrás acompanha (idx → scroll). loadStream troca a fonte
    // na MESMA instância de vídeo, sem sair da tela cheia.
    const zapFs = useCallback((dir: 1 | -1) => {
        dirRef.current = dir;
        const pos = chanIdxs.indexOf(idx);
        const np = Math.max(0, Math.min(chanIdxs.length - 1, pos + dir));
        const i = chanIdxs[np]; if (i == null || i === idx) return;
        setIdx(i);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => loadStream(i), 80);   // coalesce ao segurar ↑/↓ (não carrega os do meio)
    }, [chanIdxs, idx, loadStream]);
    // PREFETCH: ~0,6s após assentar num canal, pré-carrega o PRÓXIMO na direção do zap
    // (só quando a pessoa para — não durante zap rápido, pra poupar banda).
    useEffect(() => {
        if (LOW_POWER) return;   // TV: prefetch desligado (ver prefetchInto) — não computa o vizinho
        let dead = false;
        const h = setTimeout(async () => {
            const pos = chanIdxs.indexOf(idx);
            const ni = pos < 0 ? -1 : chanIdxs[pos + dirRef.current];
            const it = ni != null && ni >= 0 ? vflat[ni] : null;
            if (!it || it.kind !== 'chan') { if (!dead) setPrefetch([]); return; }
            try { const s = await engine.getStreams(it.meta.id); if (!dead) setPrefetch(dedupStreams(s)[0]?.urls || []); } catch { }
        }, 600);
        return () => { dead = true; clearTimeout(h); };
    }, [idx, chanIdxs, vflat, engine]);
    const selectNow = useCallback((i: number) => select(i, true), [select]);  // estável p/ memo das linhas
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
        if (mode === 'cats') { catsKey(e); return; }
        // Canais: ↑ no topo da lista leva o foco pro botão "☰ Categorias".
        if (e.key === 'ArrowUp' && document.activeElement === stageRef.current && chanIdxs.indexOf(idx) <= 0) {
            e.preventDefault(); (stageRef.current?.querySelector('.chan-list-head .back') as HTMLElement | null)?.focus(); return;
        }
        stageNav(e, stageRef.current, move, () => setMode('cats'));
    };
    // Voltar do controle: na lista de canais vai pras categorias (não sai do app).
    useBackHandler(mode === 'channels', () => setMode('cats'));

    // Tecla MENU do controle → abre/fecha as Categorias (alguns controles de TV).
    useEffect(() => {
        const onMenu = (e: KeyboardEvent) => {
            if (e.key === 'ContextMenu' || e.keyCode === 82 || e.key === 'F1' || (e as any).keyCode === 457) {
                e.preventDefault(); setMode(m => (m === 'cats' ? 'channels' : 'cats'));
            }
        };
        window.addEventListener('keydown', onMenu);
        return () => window.removeEventListener('keydown', onMenu);
    }, []);

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
                        <VChannelList vflat={vflat} offsets={rowOffsets} total={listTotal} selectedIdx={idx} onSelect={selectNow} scrollRef={scrollRef} />
                    )}
                </div>
            </aside>
            <main className="chan-stage">
                <LivePlayer sources={sources} title={title} onZap={zapFs} prefetch={prefetch}
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

/** Ícones SVG próprios do player Proza (sem emoji) — herdam a cor do botão
 *  (currentColor), então o foco vermelho/branco se aplica sozinho. */
function RIcon({ n }: { n: string }) {
    const c = { viewBox: '0 0 24 24', width: 24, height: 24, fill: 'currentColor', 'aria-hidden': true } as any;
    switch (n) {
        case 'play': return <svg {...c}><path d="M8 5v14l11-7z" /></svg>;
        case 'pause': return <svg {...c}><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>;
        case 'back': return <svg {...c}><path d="M11 18V6L3 12l8 6zm9 0V6l-8 6 8 6z" /></svg>;
        case 'fwd': return <svg {...c}><path d="M13 6v12l8-6-8-6zM4 6v12l8-6-8-6z" /></svg>;
        case 'vol': return <svg {...c}><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16 8.6a4 4 0 0 1 0 6.8M18.7 6a7.5 7.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>;
        case 'mute': return <svg {...c}><path d="M4 9v6h4l5 5V4L8 9H4z" /><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>;
        case 'fs': return <svg {...c}><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z" /></svg>;
        case 'fsExit': return <svg {...c}><path d="M9 4v2H6v3H4V4h5zm6 0h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z" /></svg>;
        case 'close': return <svg {...c}><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>;
        case 'sources': return <svg {...c}><path d="M12 3 2 9l10 6 10-6-10-6zm0 13.5L4.3 12 2 13.5 12 19l10-5.5L19.7 12 12 16.5z" /></svg>;
        default: return null;
    }
}

/** Player embutido (canais/jogos ao vivo): recebe a CADEIA de fontes daquela
 *  marca (várias regionais/qualidades) e faz failover automático — se uma falha,
 *  já tenta a próxima sozinho. Troca de fonte ao zapear, sem fechar. */
function LivePlayer({ sources, title, options, onPick, onZap, prefetch }: {
    sources: string[]; title: string;
    options?: { label: string; urls: string[] }[];   // fontes alternativas (p/ trocar em tela cheia)
    onPick?: (urls: string[]) => void;
    onZap?: (dir: 1 | -1) => void;   // ↑/↓ em tela cheia trocam de canal/jogo SEM sair
    prefetch?: string[];             // próximo canal (direção do zap) p/ pré-carregar → troca instantânea
}) {
    // JANELA DUPLA (A/B): uma toca (frente), a outra PRÉ-CARREGA o próximo canal. Ao
    // zapear na direção pré-carregada, só promovemos a janela de trás → instantâneo.
    const aRef = useRef<HTMLVideoElement>(null);
    const bRef = useRef<HTMLVideoElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const frontRef = useRef(0);               // 0=A, 1=B é a janela visível/ativa
    const hls0 = useRef<Hls | null>(null);
    const hls1 = useRef<Hls | null>(null);
    const idxRef = useRef(0);                  // fonte atual na cadeia (frente)
    const srcRef = useRef<string[]>(sources);
    const recoverRef = useRef(0);
    const mutedRef = useRef(false);
    const onZapRef = useRef(onZap); onZapRef.current = onZap;
    const spinTimer = useRef<any>(null);
    const preUrlRef = useRef<string | null>(null);   // url pré-carregada na janela de trás
    const preCappedRef = useRef(false);              // prefetch já bufferizou o suficiente (parou de baixar)
    const [front, setFront] = useState(0);    // espelha frontRef p/ a visibilidade no render
    const [alt, setAlt] = useState(0);
    const [dead, setDead] = useState(false);
    const [hasFrame, setHasFrame] = useState(false);
    const [fs, setFs] = useState(false);
    const [showCtrl, setShowCtrl] = useState(true);
    const [paused, setPaused] = useState(false);
    const [muted, setMuted] = useState(false);
    const showRef = useRef(true);
    const hideTimer = useRef<any>(null);
    const startTimer = useRef<any>(null);
    const ctrlRef = useRef<HTMLDivElement>(null);
    srcRef.current = sources;

    const elAt = (i: number) => (i === 0 ? aRef.current : bRef.current);
    const hlsAt = (i: number) => (i === 0 ? hls0.current : hls1.current);
    const setHlsAt = (i: number, h: Hls | null) => { if (i === 0) hls0.current = h; else hls1.current = h; };
    const vEl = () => elAt(frontRef.current);
    // Buffer da janela da FRENTE. Antes era agressivo (liveSync 1 + buffer 10s) p/ baixa
    // latência → no menor soluço de rede/CPU (típico na TV) ESVAZIAVA e travava. Agora
    // ficamos uns segundos atrás do "ao vivo" e seguramos ~30s de colchão: muito mais
    // liso, ao custo de ~poucos segundos de atraso (irrelevante p/ IPTV).
    const MAINBUF = LOW_POWER ? 24 : 30;
    const HLS_CFG: any = { enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, startLevel: 0, abrEwmaDefaultEstimate: 800000, liveSyncDurationCount: 3, maxBufferLength: MAINBUF, maxMaxBufferLength: MAINBUF * 2, backBufferLength: 15, manifestLoadingTimeOut: 7000, fragLoadingTimeOut: 18000, manifestLoadingMaxRetry: 3, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 6 };

    // Toca a fonte i NA JANELA DA FRENTE (failover automático se a fonte falhar).
    const playAt = useCallback((i: number) => {
        const fi = frontRef.current; const v = elAt(fi); const url = srcRef.current[i];
        if (!v || !url) return;
        idxRef.current = i; setAlt(i);
        const nextSrc = () => { const ni = idxRef.current + 1; if (ni < srcRef.current.length) { recoverRef.current = 0; playAt(ni); } else setDead(true); };
        clearTimeout(startTimer.current);
        startTimer.current = setTimeout(() => { if (v.readyState < 3 && v.currentTime < 0.1) nextSrc(); }, 9000);
        if (Hls.isSupported()) {
            let hls = hlsAt(fi);
            if (!hls) {
                hls = new Hls(HLS_CFG);
                hls.attachMedia(v);
                hls.on(Hls.Events.ERROR, (_e, d) => {
                    if (!d.fatal) return;
                    if (hlsAt(frontRef.current) !== hls) return;   // erro de janela demovida → ignora
                    if (d.type === Hls.ErrorTypes.NETWORK_ERROR && recoverRef.current < 4) { recoverRef.current++; try { hls!.startLoad(); } catch { } return; }
                    if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recoverRef.current < 4) { recoverRef.current++; try { hls!.recoverMediaError(); } catch { } return; }
                    nextSrc();
                });
                setHlsAt(fi, hls);
            }
            recoverRef.current = 0;
            try { hls.config.maxBufferLength = MAINBUF; } catch { }
            hls.loadSource(url); try { hls.startLoad(); } catch { }
            v.muted = mutedRef.current; v.play().catch(() => { });
        } else {
            v.src = url; v.onerror = nextSrc; v.muted = mutedRef.current; v.play().catch(() => { });
        }
    }, []);

    // Pré-carrega `url` na janela de TRÁS, ECONÔMICO: menor qualidade + para de baixar
    // após ~5s no buffer (stopLoad). Não dá play (poupa CPU/banda) — só paga o "engate"
    // caro (conexão + 1º segmentos), que é o que custa os segundos de espera.
    const prefetchInto = useCallback((url: string) => {
        if (LOW_POWER) return;   // TV: 2ª janela trava o stream principal — sem prefetch (zap fica frio, mas LISO)
        const bi = 1 - frontRef.current; const v = elAt(bi); if (!v) return;
        const old = hlsAt(bi); if (old) { try { old.destroy(); } catch { } setHlsAt(bi, null); }
        preCappedRef.current = false; preUrlRef.current = url;
        if (!Hls.isSupported()) { preUrlRef.current = null; return; }
        const hls = new Hls({ ...HLS_CFG, maxBufferLength: 6, maxMaxBufferLength: 6 });
        // Para de baixar após ter ~2 segmentos no buffer (gasta o mínimo de banda).
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
            try { const b = v.buffered; if (b.length && !preCappedRef.current) { preCappedRef.current = true; hls.stopLoad(); } } catch { }
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
            if (!d.fatal) return;
            // prefetch falhou (ex.: limite de conexão) → descarta; o canal nunca será promovido vazio.
            try { hls.destroy(); } catch { } if (hlsAt(bi) === hls) setHlsAt(bi, null); preUrlRef.current = null;
        });
        hls.attachMedia(v); v.muted = true; hls.loadSource(url); try { hls.startLoad(); } catch { }
        setHlsAt(bi, hls);
    }, []);

    // Promove a janela de trás (já pré-carregada) a frente → troca INSTANTÂNEA.
    const promote = useCallback(() => {
        const oldF = frontRef.current; const nf = 1 - oldF;
        const nv = elAt(nf); const nhls = hlsAt(nf);
        if (!nv || !nhls) return false;
        // SÓ promove se o prefetch já tem quadro pronto; senão devolve false → cold-load
        // normal (zap rápido, antes do prefetch terminar, não trava numa janela vazia).
        const ready = nv.readyState >= 2 || (nv.buffered && nv.buffered.length > 0);
        if (!ready) return false;
        const ohls = hlsAt(oldF); if (ohls) { try { ohls.destroy(); } catch { } setHlsAt(oldF, null); }   // libera a conexão do canal anterior
        frontRef.current = nf; setFront(nf);
        preUrlRef.current = null; preCappedRef.current = false;
        idxRef.current = 0; recoverRef.current = 0;
        clearTimeout(spinTimer.current); setDead(false); setHasFrame(true);   // já tem quadro → sem spinner
        try { nhls.config.maxBufferLength = MAINBUF; nhls.startLoad(); } catch { }   // volta ao buffer normal
        nv.muted = mutedRef.current; nv.play().catch(() => { });
        return true;
    }, []);

    // Troca de canal: se o novo canal É o que pré-carregamos → promove (instantâneo);
    // senão, cold-load na janela da frente (sem flash: mantém o quadro até 450ms).
    useEffect(() => {
        if (sources.length && preUrlRef.current && sources[0] === preUrlRef.current && promote()) return;
        setDead(false); recoverRef.current = 0;
        clearTimeout(spinTimer.current);
        spinTimer.current = setTimeout(() => setHasFrame(false), 450);
        playAt(0);
        return () => clearTimeout(spinTimer.current);
    }, [sources, playAt, promote]);

    // Pré-carrega o vizinho quando o pai manda (só depois de assentar no canal — ver pai).
    useEffect(() => {
        const url = prefetch && prefetch[0];
        const bi = 1 - frontRef.current;
        if (!url || url === srcRef.current[0]) {
            const old = hlsAt(bi); if (old) { try { old.destroy(); } catch { } setHlsAt(bi, null); }
            preUrlRef.current = null; return;
        }
        if (url === preUrlRef.current) return;   // já pré-carregado
        prefetchInto(url);
    }, [prefetch, prefetchInto]);

    // Vigia de travadas (na janela da frente).
    useEffect(() => {
        let last = -1, stuck = 0;
        const iv = setInterval(() => {
            const v = vEl(); if (!v || v.paused || v.readyState < 2) return;
            if (v.currentTime === last) { if (++stuck >= 3) { stuck = 0; try { hlsAt(frontRef.current)?.startLoad(); } catch { } v.play().catch(() => { }); } }
            else { stuck = 0; last = v.currentTime; }
        }, 1000);
        return () => clearInterval(iv);
    }, []);

    // Status da FRENTE (ignora eventos da janela de trás). Aqui mora a TRAVA DE BANDA:
    // se a frente rebufferiza (waiting) → PAUSA o prefetch (cede banda); quando volta a
    // tocar (playing) → libera o prefetch a continuar (até o teto de ~5s).
    useEffect(() => {
        const done = (e: Event) => {
            if (e.target !== vEl()) return;
            clearTimeout(startTimer.current); clearTimeout(spinTimer.current); setHasFrame(true);
            if (preUrlRef.current && !preCappedRef.current) { try { hlsAt(1 - frontRef.current)?.startLoad(); } catch { } }
        };
        const wait = (e: Event) => { if (e.target !== vEl()) return; try { hlsAt(1 - frontRef.current)?.stopLoad(); } catch { } };
        const sync = (e: Event) => { if (e.target !== vEl()) return; const v = vEl(); if (v) { setPaused(v.paused); setMuted(v.muted); mutedRef.current = v.muted; } };
        const list = [aRef.current, bRef.current].filter(Boolean) as HTMLVideoElement[];
        for (const el of list) { el.addEventListener('playing', done); el.addEventListener('canplay', done); el.addEventListener('waiting', wait); el.addEventListener('play', sync); el.addEventListener('pause', sync); el.addEventListener('volumechange', sync); }
        return () => { for (const el of list) { el.removeEventListener('playing', done); el.removeEventListener('canplay', done); el.removeEventListener('waiting', wait); el.removeEventListener('play', sync); el.removeEventListener('pause', sync); el.removeEventListener('volumechange', sync); } };
    }, []);

    // Destrói as instâncias ao desmontar.
    useEffect(() => () => { clearTimeout(startTimer.current); for (const h of [hls0.current, hls1.current]) { try { h?.destroy(); } catch { } } hls0.current = null; hls1.current = null; }, []);
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
    const togglePlay = () => { const v = vEl(); if (!v) return; if (v.paused) v.play().catch(() => { }); else v.pause(); reveal(); };
    const toggleMute = () => { const v = vEl(); if (!v) return; v.muted = !v.muted; mutedRef.current = v.muted; reveal(); };
    useBackHandler(fs, () => setFs(false));   // Voltar do controle sai da tela cheia (não do app)
    // (play/mudo já sincronizam pelos listeners das duas janelas — ver efeito de status acima.)

    // Em tela cheia: barra some/reaparece; ←→ navega entre os botões; Voltar sai;
    // tudo confinado à barra (não vaza pra lista atrás). Fora dela, foco volta ao player.
    useEffect(() => {
        if (!fs) {
            setShow(true); clearTimeout(hideTimer.current);
            const t = setTimeout(() => {
                // NÃO roubar o foco da LISTA/stage: ao entrar nos Canais (ou ao clicar/zapear
                // um canal) o foco deve ficar na lista (modo zapping), não pular pro player.
                const ae = document.activeElement as HTMLElement | null;
                if (ae && (ae.classList.contains('chan-live') || ae.closest('.chan-list'))) return;
                boxRef.current?.focus();
            }, 60);
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
            // ↑/↓ zapeiam canal/jogo SEM sair da tela cheia (mesmo com a barra escondida).
            if (onZapRef.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault(); reveal(); onZapRef.current(e.key === 'ArrowDown' ? 1 : -1); return;
            }
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
            {/* JANELA DUPLA: A e B empilhadas; a de trás (.lv-back) fica oculta pré-carregando. */}
            <video ref={aRef} playsInline className={`live-video${front === 0 ? '' : ' lv-back'}`} />
            <video ref={bRef} playsInline className={`live-video${front === 1 ? '' : ' lv-back'}`} />
            {/* Anel de foco SOBRE o vídeo (box-shadow no container fica escondido atrás dele). */}
            {!fs && <div className="live-ring" aria-hidden="true" />}
            {/* Dica visível só quando o player está focado (não é focável → não rouba D-pad). */}
            {canFs && !fs && <span className="live-hint">⛶ OK = tela cheia</span>}
            {!sources.length && <div className="live-empty">▶ Selecione um canal na lista</div>}
            {!hasFrame && !dead && !!sources.length && <div className="live-loading"><span className="spin" /></div>}
            {trying && <div className="live-fallback">Fonte instável — tentando alternativa {alt + 1}/{sources.length}…</div>}
            {dead && sources.length > 0 && (<div className="player-err">Nenhuma fonte respondeu.<button onClick={() => window.open(sources[sources.length - 1], '_blank')}>Abrir externo</button></div>)}
            {fs && (
                <div className={`live-ov${showCtrl ? '' : ' hidden'}`}>
                    <div className="live-ov-top">
                        <span className="rp-live-pill"><i className="rp-live-dot" />AO VIVO</span>
                        <span className="live-ov-title">{title}</span>
                    </div>
                    {paused && <button className="rp-center" tabIndex={-1} onClick={togglePlay} aria-label="Tocar"><RIcon n="play" /></button>}
                    <div className="rp-ctrl" ref={ctrlRef}>
                        <button className="rp-btn rp-primary" onClick={togglePlay} aria-label={paused ? 'Tocar' : 'Pausar'} title={paused ? 'Tocar' : 'Pausar'}><RIcon n={paused ? 'play' : 'pause'} /></button>
                        <button className="rp-btn" onClick={toggleMute} aria-label={muted ? 'Ativar som' : 'Mudo'} title={muted ? 'Ativar som' : 'Mudo'}><RIcon n={muted ? 'mute' : 'vol'} /></button>
                        {options && options.length > 1 && (
                            <div className="rp-sources">
                                <span className="rp-sources-ico" aria-hidden="true"><RIcon n="sources" /></span>
                                {options.map((o, k) => (
                                    <button key={k} className={`now-opt${o.urls[0] === active ? ' on' : ''}`}
                                        onClick={() => { onPick?.(o.urls); reveal(); }}>{o.label}</button>
                                ))}
                            </div>
                        )}
                        <button className="rp-btn rp-exit" onClick={() => setFs(false)} aria-label="Sair da tela cheia" title="Sair"><RIcon n="fsExit" /></button>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Player VOD (filme/série): mesma interface do player ao vivo — fundo preto, SEM
 *  controles nativos cinzas, barra própria que some sozinha, navegável por controle
 *  remoto (D-pad). HLS via hls.js; senão <video> nativo; fallback "abrir externo". */
function Player({ url, title, contentKey, resumeFrom, onClose }: { url: string; title: string; contentKey?: string; resumeFrom?: number; onClose: () => void }) {
    const ref = useRef<HTMLVideoElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const ctrlRef = useRef<HTMLDivElement>(null);
    const hideTimer = useRef<any>(null);
    const showRef = useRef(true);
    const [err, setErr] = useState(false);
    const [loading, setLoading] = useState(true);
    const [paused, setPaused] = useState(false);
    const [muted, setMuted] = useState(false);
    const [cur, setCur] = useState(0);
    const [dur, setDur] = useState(0);
    const [showCtrl, setShowCtrl] = useState(true);
    const [scrub, setScrub] = useState<number | null>(null);   // posição da prévia (scrubbing)
    const [thumbReady, setThumbReady] = useState(false);       // 1º frame da miniatura já desenhado
    const barRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLCanvasElement>(null);
    const thumbRef = useRef<Thumbnailer | null>(null);
    const zoneRef = useRef<'bar' | 'btn'>('bar');   // foco: barra de tempo x botões
    const scrubRef = useRef<number | null>(null);
    const accelRef = useRef(0);
    const capTimer = useRef<any>(null);
    const commitTimer = useRef<any>(null);
    useBackHandler(true, onClose);   // Voltar do controle fecha o player

    useEffect(() => {
        const v = ref.current; if (!v) return;
        const handle = attachAdaptive(v, url, () => setErr(true));
        if (resumeFrom && resumeFrom > 5) {
            const seek = () => { try { if (v.currentTime < 1) v.currentTime = resumeFrom; } catch { } };
            v.addEventListener('loadedmetadata', seek, { once: true });
        }
        let last = 0;
        const onTime = () => {
            setCur(v.currentTime); setDur(v.duration || 0);
            if (!contentKey) return; const now = v.currentTime;
            if (Math.abs(now - last) >= 5) { last = now; saveProg(contentKey, now, v.duration); }
        };
        const onPlaying = () => setLoading(false);
        const onWaiting = () => setLoading(true);
        v.addEventListener('timeupdate', onTime);
        v.addEventListener('playing', onPlaying); v.addEventListener('canplay', onPlaying);
        v.addEventListener('waiting', onWaiting);
        return () => { if (contentKey) saveProg(contentKey, v.currentTime, v.duration); v.removeEventListener('timeupdate', onTime); v.removeEventListener('playing', onPlaying); v.removeEventListener('canplay', onPlaying); v.removeEventListener('waiting', onWaiting); handle.destroy(); };
    }, [url]);

    // Sincroniza play/mudo com o vídeo.
    useEffect(() => {
        const v = ref.current; if (!v) return;
        const sync = () => { setPaused(v.paused); setMuted(v.muted); };
        v.addEventListener('play', sync); v.addEventListener('pause', sync); v.addEventListener('volumechange', sync);
        return () => { v.removeEventListener('play', sync); v.removeEventListener('pause', sync); v.removeEventListener('volumechange', sync); };
    }, []);

    // Controlador da barra: some após 4s parado, reaparece em qualquer ação.
    const setShow = useCallback((b: boolean) => { showRef.current = b; setShowCtrl(b); }, []);
    const reveal = useCallback(() => { setShow(true); clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => setShow(false), 4000); }, [setShow]);
    const ctrlButtons = () => Array.from(ctrlRef.current?.querySelectorAll<HTMLElement>('button') || []);
    const focusCtrl = (i = 0) => { const b = ctrlButtons(); b[Math.max(0, Math.min(b.length - 1, i))]?.focus(); };
    const moveCtrl = (dir: 1 | -1) => { const b = ctrlButtons(); if (!b.length) return; const cur = b.indexOf(document.activeElement as HTMLElement); const ni = cur < 0 ? 0 : Math.max(0, Math.min(b.length - 1, cur + dir)); b[ni].focus(); };
    const togglePlay = () => { const v = ref.current; if (!v) return; if (v.paused) v.play().catch(() => { }); else v.pause(); reveal(); };
    const toggleMute = () => { const v = ref.current; if (!v) return; v.muted = !v.muted; reveal(); };
    const seek = (delta: number) => { const v = ref.current; if (!v) return; try { v.currentTime = Math.max(0, Math.min((v.duration || 1e9), v.currentTime + delta)); } catch { } reveal(); };

    // === Scrubbing com miniatura (estilo Netflix) ===
    const ensureThumb = () => { if (!thumbRef.current) thumbRef.current = createThumbnailer(url, () => setThumbReady(true)); return thumbRef.current; };
    const captureSoon = (t: number) => {
        clearTimeout(capTimer.current);
        capTimer.current = setTimeout(() => { const c = previewRef.current; if (c) ensureThumb().capture(t, c); }, 80);
    };
    // Libera o gerador de miniaturas (e a 2ª conexão com o provedor) — contas que só
    // permitem 1 conexão NÃO têm a reprodução derrubada: o vídeo oculto só existe
    // durante o scrub e é destruído ao confirmar/cancelar.
    const killThumb = useCallback(() => { clearTimeout(capTimer.current); try { thumbRef.current?.destroy(); } catch { /* noop */ } thumbRef.current = null; setThumbReady(false); }, []);
    // Aplica a posição escolhida no vídeo e volta a tocar (ao "parar" de segurar).
    const commitScrub = useCallback(() => {
        const t = scrubRef.current; const v = ref.current;
        if (t != null && v) { try { v.currentTime = t; } catch { /* noop */ } v.play().catch(() => { }); }
        scrubRef.current = null; setScrub(null); accelRef.current = 0;
        clearTimeout(commitTimer.current); killThumb();
    }, [killThumb]);
    const cancelScrub = useCallback(() => { scrubRef.current = null; setScrub(null); accelRef.current = 0; clearTimeout(commitTimer.current); killThumb(); }, [killThumb]);
    const scrubTo = useCallback((t: number, D: number, arm = true) => {
        const cl = Math.max(0, Math.min(D, t));
        scrubRef.current = cl; setScrub(cl); reveal(); captureSoon(cl);
        clearTimeout(commitTimer.current);
        // D-pad: OK confirma na hora; este é só a rede de segurança se a pessoa parar
        // (tempo folgado pro frame da miniatura decodificar). Mouse (arm=false): só prévia.
        if (arm) commitTimer.current = setTimeout(commitScrub, 2500);
    }, [reveal, commitScrub]);
    // Passo acelera enquanto segura (cada repetição anda mais), proporcional à duração.
    const stepScrub = (dir: 1 | -1) => {
        const v = ref.current; if (!v) return; const D = v.duration || 0;
        if (!D || !isFinite(D)) return;
        accelRef.current = Math.min(accelRef.current + 1, 40);
        const base = Math.max(5, D / 240);
        const from = scrubRef.current == null ? v.currentTime : scrubRef.current;
        scrubTo(from + base * (1 + accelRef.current * 0.4) * dir, D);
    };
    useEffect(() => () => { clearTimeout(capTimer.current); clearTimeout(commitTimer.current); killThumb(); }, [killThumb]);

    // Navegação por controle remoto (D-pad). Duas zonas:
    //  - BARRA (padrão): ←→ scrub com miniatura; ↓ vai pros botões; OK confirma a posição.
    //  - BOTÕES: ←→ entre botões; ↑ volta pra barra; OK dispara o botão.
    // Voltar fecha. Tudo confinado (não vaza pra lista atrás).
    useEffect(() => {
        reveal(); zoneRef.current = 'bar';
        const t = setTimeout(() => barRef.current?.focus(), 60);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Backspace') return; // useBackHandler trata
            const k = e.key;
            const isEnter = k === 'Enter' || k === ' ' || k === 'NumpadEnter';
            // Enter na zona BOTÕES dispara o <button> focado nativamente — não intercepta.
            if (isEnter && zoneRef.current === 'btn') { reveal(); return; }
            e.stopPropagation();
            if (!showRef.current) { e.preventDefault(); reveal(); zoneRef.current = 'bar'; barRef.current?.focus(); return; }
            reveal();
            if (zoneRef.current === 'bar') {
                if (k === 'ArrowRight') { e.preventDefault(); stepScrub(1); }
                else if (k === 'ArrowLeft') { e.preventDefault(); stepScrub(-1); }
                else if (k === 'ArrowDown') { e.preventDefault(); cancelScrub(); zoneRef.current = 'btn'; focusCtrl(0); }
                else if (k === 'ArrowUp') { e.preventDefault(); }
                else if (isEnter) { e.preventDefault(); if (scrubRef.current != null) commitScrub(); else togglePlay(); }
            } else {
                if (k === 'ArrowRight') { e.preventDefault(); moveCtrl(1); }
                else if (k === 'ArrowLeft') { e.preventDefault(); moveCtrl(-1); }
                else if (k === 'ArrowUp') { e.preventDefault(); zoneRef.current = 'bar'; barRef.current?.focus(); }
                else if (k === 'ArrowDown') { e.preventDefault(); }
            }
        };
        const onUp = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') accelRef.current = 0; };
        const onMove = () => reveal();
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onUp, true);
        window.addEventListener('mousemove', onMove, true);
        return () => { clearTimeout(t); clearTimeout(hideTimer.current); window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true); window.removeEventListener('mousemove', onMove, true); };
    }, [reveal, commitScrub, scrubTo]);

    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    const dispPct = scrub != null && dur > 0 ? (scrub / dur) * 100 : pct;   // barra/knob seguem a prévia ao scrubar
    return (
        <div ref={boxRef}
            className={`player${showCtrl ? '' : ' nocursor'}`}
            tabIndex={0}
            onClick={() => reveal()}>
            <video ref={ref} autoPlay playsInline className="player-video" />
            {loading && !err && <div className="live-loading"><span className="spin" /></div>}
            {err && (
                <div className="player-err">
                    Não consegui tocar aqui.
                    <button onClick={() => window.open(url, '_blank')}>Abrir externo</button>
                </div>
            )}
            <div className={`live-ov${showCtrl ? '' : ' hidden'}`}>
                <div className="live-ov-top"><span className="live-ov-title">{title}</span></div>
                {paused && <button className="rp-center" tabIndex={-1} onClick={togglePlay} aria-label="Tocar"><RIcon n="play" /></button>}
                <div className="player-seek">
                    <span className="player-time">{fmtTime(scrub != null ? scrub : cur)}</span>
                    <div ref={barRef} className={`player-bar-wrap${scrub != null ? ' scrubbing' : ''}`} tabIndex={0}
                        onMouseMove={(e) => { const v = ref.current; if (!v || !dur) return; const r = e.currentTarget.getBoundingClientRect(); scrubTo(((e.clientX - r.left) / r.width) * dur, dur, false); }}
                        onMouseLeave={() => cancelScrub()}
                        onClick={(e) => { const v = ref.current; if (!v || !dur) return; const r = e.currentTarget.getBoundingClientRect(); v.currentTime = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur)); cancelScrub(); reveal(); }}>
                        {scrub != null && (
                            <div className="player-preview" style={{ left: dispPct + '%' }}>
                                <div className="player-preview-frame">
                                    <canvas ref={previewRef} className="player-preview-img" width={256} height={144} />
                                    {!thumbReady && <span className="player-preview-spin" />}
                                </div>
                                <span className="player-preview-time">{fmtTime(scrub)}</span>
                            </div>
                        )}
                        <div className="player-bar-track">
                            <i style={{ width: dispPct + '%' }} />
                            <span className="player-knob" style={{ left: dispPct + '%' }} />
                        </div>
                    </div>
                    <span className="player-time">{fmtTime(dur)}</span>
                </div>
                <div className="rp-ctrl" ref={ctrlRef}>
                    <button className="rp-btn rp-seek" onClick={() => seek(-10)} aria-label="Voltar 10s" title="−10s"><RIcon n="back" /><small>10</small></button>
                    <button className="rp-btn rp-primary" onClick={togglePlay} aria-label={paused ? 'Tocar' : 'Pausar'} title={paused ? 'Tocar' : 'Pausar'}><RIcon n={paused ? 'play' : 'pause'} /></button>
                    <button className="rp-btn rp-seek" onClick={() => seek(30)} aria-label="Avançar 30s" title="+30s"><RIcon n="fwd" /><small>30</small></button>
                    <button className="rp-btn" onClick={toggleMute} aria-label={muted ? 'Ativar som' : 'Mudo'} title={muted ? 'Ativar som' : 'Mudo'}><RIcon n={muted ? 'mute' : 'vol'} /></button>
                    <button className="rp-btn rp-exit" onClick={onClose} aria-label="Fechar" title="Fechar"><RIcon n="close" /></button>
                </div>
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
// SVG data-URI LOCAL (sem rede): com centenas de canais, bater no placehold.co era
// centenas de requisições remotas — pesado e lento na TV. Agora é instantâneo/offline.
const _cardCache = new Map<string, string>();
function cardFor(name: string) {
    const s = name || 'TV';
    const hit = _cardCache.get(s); if (hit) return hit;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const pal = ['1f3a5f', '3a1f5f', '5f1f2e', '1f5f3a', '5f4a1f', '2e1f5f', '1f5f5a', '5f1f4a', '24304a', '402a2a'];
    const bg = pal[h % pal.length];
    // Iniciais (até 2 letras) — fica limpo no quadradinho.
    const initials = s.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'TV';
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#${bg}"/><text x="80" y="80" font-family="Segoe UI,Arial,sans-serif" font-size="64" font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="central">${esc(initials)}</text></svg>`;
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    _cardCache.set(s, uri);
    return uri;
}
// Nota IMDb numérica (string "7.8" → 7.8) p/ ordenar destaques.
function ratingNum(m: any): number { const r = parseFloat(m?.imdbRating); return isFinite(r) ? r : 0; }

// --- Progresso de reprodução (continuar assistindo / retomar posição) ----------
// Chave = id do conteúdo (filme `vod..._` ou episódio `epi..._`).
const PROG_KEY = 'proza.progress.v1';
function loadProg(): Record<string, { pos: number; dur: number; t: number }> { try { return JSON.parse(localStorage.getItem(PROG_KEY) || '{}'); } catch { return {}; } }
function getProg(key: string) { if (!key) return null; return loadProg()[key] || null; }
// Episódios/filmes concluídos (>95%) — usado p/ achar o "próximo episódio".
const WATCHED_KEY = 'proza.watched.v1';
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
const FAV_KEY = 'proza.fav.v1';
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
    useBackHandler(true, onClose);   // Voltar do controle fecha a busca
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
            <div className="tiles">{metas.map((m: any) => <Tile key={m.id} meta={m} onOpen={onItem} />)}</div>
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
    useBackHandler(true, onClose);   // Voltar do controle fecha o modal
    // Leva o foco direto pro botão Assistir/Continuar (senão o D-pad mexe nos cards
    // atrás). Tenta algumas vezes pois o botão pode renderizar um instante depois.
    useEffect(() => {
        if (loading) return;
        let tries = 0; let h: any;
        const grab = () => {
            const play = document.querySelector('.details-box .vb-play') as HTMLElement | null;
            if (play) { play.focus(); return; }
            const any = document.querySelector('.details-box .details-fav, .details-box .details-close') as HTMLElement | null;
            if (++tries < 12) h = setTimeout(grab, 60); else any?.focus();   // só cai no fallback se o play não aparecer
        };
        h = setTimeout(grab, 60);
        return () => clearTimeout(h);
    }, [loading]);

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
    const initCat = useRef<any>((() => { try { return JSON.parse(localStorage.getItem('proza.vodcat.v1') || '{}'); } catch { return {}; } })());
    const [mainCat, setMainCat] = useState<string>(initCat.current.main || '__all'); // categoria principal
    const [subCat, setSubCat] = useState<string>(initCat.current.sub || '__all');    // subcategoria (id do catálogo)
    const [loaded, setLoaded] = useState<Record<string, any[]>>({}); // páginas já buscadas, acumuladas
    const [more, setMore] = useState<Record<string, boolean>>({});   // ainda há páginas a buscar?
    const fetchingRef = useRef(false);                               // evita buscar a mesma página 2x
    const [rowCap, setRowCap] = useState<Record<string, number>>({}); // qtos cards revelar por fileira da home (cresce ao navegar →)
    const fetchingRowRef = useRef<Record<string, boolean>>({});       // evita refetch simultâneo por fileira
    const [loadingCat, setLoadingCat] = useState(false);
    const [gridLimit, setGridLimit] = useState(GRID_PAGE);  // paginação do grid (anti-lag na TV)
    const [scrolled, setScrolled] = useState(false);   // board saiu da tela → mostra preview flutuante
    const vodRef = useRef<HTMLDivElement>(null);        // scroller (p/ revelar o board ao subir)

    // Navegação VERTICAL explícita (↑/↓) entre as faixas do VOD. NÃO usa a geometria
    // global (spatialMove) porque a barra de categorias é STICKY no topo: ao centralizar
    // um card, a fileira de cima saía da tela e o ↑ "pulava" pra catbar — voltando pro
    // início (era exatamente o bug relatado). Aqui montamos as faixas em ordem
    // (board → categorias → subcategorias → cada fileira / linha do grid → "carregar
    // mais") e pulamos pra faixa vizinha preservando a COLUNA (card alinhado na
    // horizontal). ←/→ continuam na geometria global (dentro da fileira).
    const onVodKey = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const sc = vodRef.current; if (!sc) return;
        const a = document.activeElement as HTMLElement | null; if (!a || !sc.contains(a)) return;
        const groups: HTMLElement[][] = [];
        const play = sc.querySelector<HTMLElement>('.vod-board .vb-play'); if (play) groups.push([play]);
        const cats = [...sc.querySelectorAll<HTMLElement>('.vod-cats .vod-cat')]; if (cats.length) groups.push(cats);
        const subs = [...sc.querySelectorAll<HTMLElement>('.vod-subcats .vod-sub')]; if (subs.length) groups.push(subs);
        for (const s of sc.querySelectorAll('.vod-rows section.row')) {
            const t = [...s.querySelectorAll<HTMLElement>('.tile')]; if (t.length) groups.push(t);
        }
        const grid = sc.querySelector('.vod-grid');
        if (grid) {
            const byTop = new Map<number, HTMLElement[]>();
            for (const t of grid.querySelectorAll<HTMLElement>('.tile')) {
                const k = t.offsetTop; let arr = byTop.get(k); if (!arr) { arr = []; byTop.set(k, arr); } arr.push(t);
            }
            [...byTop.keys()].sort((x, y) => x - y).forEach(k => groups.push(byTop.get(k)!));
            const more = sc.querySelector<HTMLElement>('.vod-more'); if (more) groups.push([more]);
        }
        const gi = groups.findIndex(g => g.includes(a));
        if (gi < 0) return;   // foco fora das faixas → deixa a geometria global agir
        e.preventDefault(); e.stopPropagation();
        const ni = gi + (e.key === 'ArrowDown' ? 1 : -1);
        if (ni < 0) { focusTopbar(); return; }     // acima do board → abas do topo
        if (ni >= groups.length) return;            // abaixo da última faixa → permanece
        const target = groups[ni];
        const c = a.getBoundingClientRect(); const cx = (c.left + c.right) / 2;
        let best = target[0], bd = Infinity;
        for (const el of target) { const r = el.getBoundingClientRect(); const d = Math.abs((r.left + r.right) / 2 - cx); if (d < bd) { bd = d; best = el; } }
        best.focus({ preventScroll: true });   // nós controlamos o scroll (sem pulo duplo)
        // Enquadramento: o scroll SEMPRE para numa posição boa, mostrando a seção em foco.
        // 1) Topo (board): rola tudo pro topo → banner inteiro à mostra.
        if (ni === 0) { sc.scrollTo({ top: 0, behavior: 'auto' }); return; }
        const bar = sc.querySelector<HTMLElement>('.vod-catbar');
        const barH = bar ? bar.getBoundingClientRect().height : 0;
        const viewTop = sc.getBoundingClientRect().top;   // topo do scroller (abaixo da topbar)
        const sec = best.closest('section.row') as HTMLElement | null;
        if (sec) {
            // 2) Fileira horizontal: encosta o TÍTULO da seção logo abaixo da barra fixa →
            //    sempre enquadra "título da seção + a fila de cards" inteira.
            const delta = sec.getBoundingClientRect().top - (viewTop + barH + 14);
            sc.scrollBy({ top: delta, behavior: 'auto' });
        } else if (best.classList.contains('tile')) {
            // 3) Grid de categoria (sem títulos por linha): centraliza a linha em foco,
            //    mas nunca deixa o card atrás da barra fixa.
            best.scrollIntoView({ block: 'center', inline: 'nearest' });
            const tr = best.getBoundingClientRect();
            if (tr.top < viewTop + barH) sc.scrollBy({ top: tr.top - (viewTop + barH + 14), behavior: 'auto' });
        } else {
            // 4) Categorias/subcategorias (a própria barra fixa): garante visível.
            best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            if (bar) { const tr = best.getBoundingClientRect(); if (tr.top < viewTop + barH) sc.scrollBy({ top: tr.top - (viewTop + barH + 14), behavior: 'auto' }); }
        }
    }, []);
    // Categorias descobertas vazias (escondidas dos botões). Persiste entre sessões.
    const [empty, setEmpty] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('proza.vodempty.v1') || '[]')); } catch { return new Set(); } });

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
            // selfId = catálogo "raiz" da categoria (Todos). NÃO sobrescreve: o base
            // (ex.: nexotv_vod = TODOS os filmes) vem primeiro e deve vencer um grupo do
            // provedor de mesmo nome (ex.: um grupo "Filmes" com 1 item) que sobrescrevia
            // e fazia a categoria mostrar só aquele 1 item.
            if (sub) node.subs.push({ name: sub, id: c.id }); else if (!node.selfId) node.selfId = c.id;
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
        if (loaded[id]) return loaded[id];          // lista COMPLETA (todas as páginas)
        const r = [...movieRows, ...seriesRows].find(x => x.id === id);
        return r ? r.metas : [];                      // 30 da home como preview enquanto a completa carrega
    };

    // Lembra a última categoria aberta.
    useEffect(() => { try { localStorage.setItem('proza.vodcat.v1', JSON.stringify({ main: mainCat, sub: subCat })); } catch { } }, [mainCat, subCat]);
    // Se a categoria lembrada não existe mais no catálogo, volta pra "Tudo".
    useEffect(() => { if (mainCat !== '__all' && tree.length && !tree.find(n => n.name === mainCat)) { setMainCat('__all'); setSubCat('__all'); } }, [tree]);

    // Catálogos podem ter MILHARES de itens (ex.: "Filmes" = ~30 mil). Paginar PREGUIÇOSO:
    // busca a 1ª página ao abrir a categoria; busca a próxima conforme o usuário pede mais
    // (gridLimit cresce). Carregar tudo de uma vez travaria a TV. O getCatalog devolve
    // ~100/página via skip; `more[selId]` indica se ainda há páginas.
    const VOD_PAGE = 100;
    useEffect(() => {
        if (!selId || loaded[selId]) return;
        let dead = false; setLoadingCat(true);
        engine.getCatalog({ type: node?.type || 'movie', id: selId, extra: { skip: '0' } })
            .then(({ metas }: any) => {
                if (dead) return;
                const got = metas || [];
                setLoaded(p => ({ ...p, [selId]: got }));
                setMore(p => ({ ...p, [selId]: got.length >= VOD_PAGE }));
                if (!got.length) setEmpty(prev => { const n = new Set(prev); n.add(selId); try { localStorage.setItem('proza.vodempty.v1', JSON.stringify([...n])); } catch { } return n; });
            })
            .catch(() => { if (!dead) { setLoaded(p => ({ ...p, [selId]: [] })); setMore(p => ({ ...p, [selId]: false })); } })
            .finally(() => { if (!dead) setLoadingCat(false); });
        return () => { dead = true; };
    }, [selId]);

    // Conforme o grid revela mais (gridLimit) e chega perto do fim do já carregado, busca
    // a próxima página e acumula — paginação "infinita" sem travar.
    useEffect(() => {
        if (!selId) return;
        const have = loaded[selId];
        if (!have || !more[selId] || fetchingRef.current) return;
        if (gridLimit + 24 <= have.length) return;   // ainda há folga carregada
        fetchingRef.current = true;
        engine.getCatalog({ type: node?.type || 'movie', id: selId, extra: { skip: String(have.length) } })
            .then(({ metas }: any) => {
                const got = metas || [];
                setLoaded(p => ({ ...p, [selId]: [...(p[selId] || []), ...got] }));
                setMore(p => ({ ...p, [selId]: got.length >= VOD_PAGE }));
            })
            .catch(() => { setMore(p => ({ ...p, [selId]: false })); })
            .finally(() => { fetchingRef.current = false; });
    }, [gridLimit, selId, loaded, more]);

    // "Carregar mais" do grid: cresce o limite e leva o FOCO pro 1º card novo. Sem isso o
    // foco ficava no botão (que pulava pro fim de tudo). Re-tenta enquanto os cards novos
    // ainda estão renderizando/sendo buscados.
    const loadMoreGrid = useCallback(() => {
        const firstNew = gridLimit;
        setGridLimit(n => n + GRID_PAGE);
        let tries = 0;
        const focusNew = () => {
            const grid = vodRef.current?.querySelector('.vod-grid');
            const t = grid?.querySelectorAll<HTMLElement>('.tile')[firstNew];
            if (t) { t.focus({ preventScroll: true }); t.scrollIntoView({ block: 'center', inline: 'nearest' }); }
            else if (++tries < 24) setTimeout(focusNew, 80);
        };
        setTimeout(focusNew, 60);
    }, [gridLimit]);

    // Fileiras da home: ao navegar → perto do fim, revela mais cards e busca a próxima
    // página do catálogo quando o já-carregado acaba (paginação POR FILEIRA na página
    // principal de Filmes/Séries).
    const growRow = useCallback((row: Row, idx: number, shownLen: number) => {
        if (idx < shownLen - 4) return;                       // só perto do fim da fila
        setRowCap(p => ({ ...p, [row.id]: (p[row.id] || ROW_CAP) + ROW_CAP }));
        const base = loaded[row.id] || row.metas;
        const nextCap = (rowCap[row.id] || ROW_CAP) + ROW_CAP;
        if (nextCap + 6 <= base.length || more[row.id] === false || fetchingRowRef.current[row.id]) return;
        fetchingRowRef.current[row.id] = true;
        engine.getCatalog({ type: (row as any).type, id: row.id, extra: { skip: String(base.length) } })
            .then(({ metas }: any) => {
                const got = metas || [];
                setLoaded(p => ({ ...p, [row.id]: [...(p[row.id] || row.metas), ...got] }));
                setMore(p => ({ ...p, [row.id]: got.length >= VOD_PAGE }));
            })
            .catch(() => { setMore(p => ({ ...p, [row.id]: false })); })
            .finally(() => { fetchingRowRef.current[row.id] = false; });
    }, [engine, loaded, more, rowCap]);

    const pickMain = (name: string) => { setMainCat(name); setSubCat('__all'); };
    // Toda troca de categoria/sub volta o grid pra 1ª página (não acumula milhares de cards).
    useEffect(() => { setGridLimit(GRID_PAGE); }, [selId]);

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

    // Preview flutuante: quando o board já saiu da tela (rolou p/ ver os cards), mostra
    // a descrição/nota do item EM FOCO num cantinho — "passou em cima, apareceu a info".
    const showPreview = scrolled && !!focused && !!D;
    return (
        <div className="vod-view" ref={vodRef} onKeyDown={onVodKey} onScroll={(e) => { const st = (e.currentTarget as HTMLElement).scrollTop; setScrolled(prev => { const n = st > 200; return n === prev ? prev : n; }); }}>
            {showPreview && (
                <div className="vod-preview">
                    {D.poster && !/placehold/.test(D.poster) && <img className="vod-preview-poster" src={D.poster} alt="" />}
                    <div className="vod-preview-info">
                        <span className="vb-kind">{D.type === 'series' ? 'SÉRIE' : 'FILME'}</span>
                        <h3 className="vod-preview-title">{D.name}</h3>
                        <div className="vb-meta">
                            {ratingNum(D) > 0 && <span className="vb-imdb">★ {D.imdbRating}</span>}
                            {year && <span>{year}</span>}
                            {D.runtime && <span>{D.runtime} min</span>}
                            {genres.length > 0 && <span className="vb-genres">{genres.slice(0, 3).join(' · ')}</span>}
                        </div>
                        {D.description && <p className="vod-preview-desc">{D.description}</p>}
                    </div>
                </div>
            )}
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
                    {/* Elenco fica nos Detalhes/preview — fora do board p/ o conteúdo NÃO
                        estourar a altura e cortar o título sob a barra do topo. */}
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
                                <div className="tiles">{r.metas.map((m: any) => <Tile key={m.id} meta={m} onOpen={onOpen} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                            </section>
                        ))}
                        {movieRows.length > 0 && <div className="sec-head">Filmes</div>}
                        {movieRows.map(row => {
                            const base = loaded[row.id] || row.metas;
                            const shown = base.slice(0, rowCap[row.id] || ROW_CAP);
                            return (
                                <section className="row" key={row.id}><h2>{row.name}</h2>
                                    <div className="tiles">{shown.map((m: any, i: number) => <Tile key={m.id} meta={m} onOpen={onOpen} onFocusItem={(mm: any) => { focus(mm); growRow(row, i, shown.length); }} progress={prog(m.id)} />)}</div>
                                </section>
                            );
                        })}
                        {seriesRows.length > 0 && <div className="sec-head">Séries</div>}
                        {seriesRows.map(row => {
                            const base = loaded[row.id] || row.metas;
                            const shown = base.slice(0, rowCap[row.id] || ROW_CAP);
                            return (
                                <section className="row" key={row.id}><h2>{row.name}</h2>
                                    <div className="tiles">{shown.map((m: any, i: number) => <Tile key={m.id} meta={m} onOpen={onOpen} onFocusItem={(mm: any) => { focus(mm); growRow(row, i, shown.length); }} progress={prog(m.id)} />)}</div>
                                </section>
                            );
                        })}
                    </>
                ) : (() => {
                    const metas = metasOf(selId);
                    if (loadingCat && !metas.length) return <div className="connecting"><span className="spin" /> Carregando categoria…</div>;
                    if (!metas.length) return <div className="status">Nada nesta categoria.</div>;
                    const subName = subCat !== '__all' ? (node?.subs.find(s => s.id === subCat)?.name || '') : '';
                    const name = subName ? `${mainCat} · ${subName}` : mainCat;
                    return (
                        <section className="vod-cat-sec">
                            <h2 className="sec-head">{name} <span className="vod-cat-count">{metas.length}{more[selId!] ? '+' : ''}</span></h2>
                            <div className="vod-grid">{metas.slice(0, gridLimit).map((m: any) => <Tile key={m.id} meta={m} onOpen={onOpen} onFocusItem={focus} progress={prog(m.id)} />)}</div>
                            {(metas.length > gridLimit || more[selId!]) && (
                                <button className="vod-more" onClick={loadMoreGrid}>
                                    {metas.length > gridLimit ? `Carregar mais (${metas.length - gridLimit}${more[selId!] ? '+' : ''})` : 'Carregar mais…'}
                                </button>
                            )}
                        </section>
                    );
                })()}
            </div>
        </div>
    );
}

// React.memo: sem isto, mover o foco (setFocused no pai) re-renderizava TODOS os ~250
// cards a cada tecla do controle → era a causa central do lag de navegação na TV. Com
// props estáveis (meta imutável, onOpen/onFocusItem em useCallback, progress primitivo),
// só o card que muda re-renderiza.
const Tile = React.memo(function Tile({ meta, onOpen, onFocusItem, progress }: { meta: any; onOpen: (m: any) => void; onFocusItem?: (m: any) => void; progress?: number }) {
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
        <button className={`tile ${shape}${fill ? ' fill' : ''}`} onClick={() => onOpen(meta)} aria-label={meta.name}
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
});

export default App;
