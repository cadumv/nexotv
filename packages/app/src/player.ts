// Camada de player ADAPTATIVA — toca em qualquer TV/plataforma sem código por marca.
//
// Por que: cada TV (Samsung/LG/Android/desktop) suporta um conjunto diferente de
// formas de tocar vídeo, e isso muda com atualizações de firmware. Em vez de fixar
// um método, detectamos em RUNTIME o que a plataforma aceita (canPlayType / MSE) e
// montamos uma CADEIA de tentativas, da melhor opção pra TV até o último recurso.
// Se uma falha, cai pra próxima sozinho. Como é só feature-detection, se adapta a
// qualquer marca e a futuras atualizações sem mexer no código.
//
// APRENDIZADO: assim que uma engine TOCA de verdade, gravamos qual foi (por tipo de
// stream) no localStorage. Nas próximas vezes ela já entra PRIMEIRO — então o atraso
// do watchdog acontece no máximo uma vez por plataforma (e nem isso após reabrir).
//
// Cadeia por tipo de stream:
//  - HLS (.m3u8):  HLS nativo (decodificador de HW da TV) → hls.js (MSE) → nativo
//  - MPEG-TS (.ts, /live/): TS nativo (a maioria das TVs decodifica) → hls.js → nativo
//  - direto (mp4/mkv/…): nativo
//
// Limite honesto: se a TV NÃO tem o decodificador de hardware do codec (ex.: HEVC/
// H.265, áudio AC3), nenhum player em JS "inventa" o codec — a cadeia se esgota e o
// app cai pra próxima FONTE do canal (failover de fontes, já existente).
import type Hls from 'hls.js';

// hls.js é o maior pedaço do bundle e só é necessário ao TOCAR algo. Carregamos
// sob demanda (chunk separado) → boot da home/catálogo mais leve, principalmente na TV.
let _Hls: any = null;
let _hlsP: Promise<any> | null = null;
export function loadHls(): Promise<any> {
    if (!_hlsP) _hlsP = import('hls.js').then((m) => (_Hls = m.default));
    return _hlsP;
}
/** Construtor do hls.js se JÁ carregado (senão null — chame loadHls()). */
export function hlsNow(): any { return _Hls; }

export type Track = { id: number; label: string; active: boolean };
export type AdaptiveHandle = {
    destroy: () => void;
    /** Faixas de áudio (dublado/legendado) — vazio se só houver uma. */
    audioTracks: () => Track[];
    setAudioTrack: (id: number) => void;
    /** Faixas de legenda embutidas no stream (id -1 = desligar). */
    subtitleTracks: () => Track[];
    setSubtitleTrack: (id: number) => void;
    /** Avisa quando as faixas (áudio/legenda) ficam disponíveis ou mudam. */
    onTracks: (cb: () => void) => void;
};
type Kind = 'hls' | 'ts' | 'direct';
type EngineName = 'native' | 'hlsjs';

// Tempo p/ considerar "travou" uma engine que conectou mas não toca.
const WATCHDOG_MS = 3000;

// Engine que JÁ funcionou, por tipo de stream — persistida entre sessões.
const ENGINE_LS = 'proza.engine.v2';
function loadLearned(): Partial<Record<Kind, EngineName>> {
    try { return JSON.parse(localStorage.getItem(ENGINE_LS) || '{}'); } catch { return {}; }
}
const learned = loadLearned();
function remember(kind: Kind, name: EngineName) {
    if (learned[kind] === name) return;
    learned[kind] = name;
    try { localStorage.setItem(ENGINE_LS, JSON.stringify(learned)); } catch { /* noop */ }
}

function kindOf(url: string): Kind {
    const u = (url.split('?')[0] || '').toLowerCase();
    if (u.endsWith('.m3u8')) return 'hls';
    if (u.endsWith('.ts') || /\/live\//.test(u) || /\/\d+$/.test(u)) return 'ts';
    return 'direct';
}

const canNativeHls = (v: HTMLVideoElement) =>
    !!(v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('application/x-mpegurl'));
const canNativeTs = (v: HTMLVideoElement) => !!v.canPlayType('video/mp2t');

/**
 * Anexa a melhor engine disponível ao <video> pra tocar `url`, caindo pra
 * alternativas quando uma falha/trava. Chama `onFatal` quando TODAS as tentativas se
 * esgotam (aí o chamador troca de fonte). Retorna { destroy } pra limpar.
 */
export function attachAdaptive(video: HTMLVideoElement, url: string, onFatal: () => void): AdaptiveHandle {
    let destroyed = false;
    let hls: Hls | null = null;
    let onErr: (() => void) | null = null;
    let watchdog: any = null;
    let progressed = false;
    let probes: Array<[string, () => void]> = [];
    let tracksCb: (() => void) | null = null;
    const fireTracks = () => { try { tracksCb?.(); } catch { /* noop */ } };

    const clearWatch = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    const cleanup = () => {
        clearWatch();
        if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
        if (onErr) { video.removeEventListener('error', onErr); onErr = null; }
        probes.forEach(([ev, fn]) => video.removeEventListener(ev, fn)); probes = [];
        try { video.removeAttribute('src'); video.load(); } catch { /* noop */ }
    };

    const play = () => { const p = video.play(); if (p && p.catch) p.catch(() => { /* autoplay */ }); };

    const runNative = () => {
        video.src = url;
        onErr = () => advance();
        video.addEventListener('error', onErr, { once: true });
        play();
    };
    const runHlsJs = async () => {
        const HlsC = await loadHls();
        if (destroyed) return;
        if (!HlsC.isSupported()) { advance(); return; }
        hls = new HlsC({ enableWorker: true, lowLatencyMode: false });
        hls!.on(HlsC.Events.ERROR, (_e: any, d: any) => { if (d.fatal) advance(); });
        // Faixas de áudio/legenda do stream ficam prontas/mudam → avisa a UI.
        for (const ev of [HlsC.Events.MANIFEST_PARSED, HlsC.Events.AUDIO_TRACKS_UPDATED, HlsC.Events.SUBTITLE_TRACKS_UPDATED, HlsC.Events.AUDIO_TRACK_SWITCHED, HlsC.Events.SUBTITLE_TRACK_SWITCH]) {
            try { hls!.on(ev, fireTracks); } catch { /* evento ausente nesta versão */ }
        }
        hls!.loadSource(url);
        hls!.attachMedia(video);
        play();
    };

    const NATIVE = { name: 'native' as EngineName, run: runNative };
    const HLSJS = { name: 'hlsjs' as EngineName, run: runHlsJs };

    // Monta a cadeia conforme o tipo + o que a plataforma suporta.
    const kind = kindOf(url);
    let attempts: Array<{ name: EngineName; run: () => void }> = [];
    if (kind === 'hls') {
        attempts = canNativeHls(video) ? [NATIVE, HLSJS] : [HLSJS, NATIVE];
    } else if (kind === 'ts') {
        attempts = canNativeTs(video) ? [NATIVE, HLSJS] : [HLSJS, NATIVE];
    } else {
        attempts = [NATIVE];
    }
    // Se já aprendemos qual engine toca esse tipo, ela entra PRIMEIRO (sem atraso).
    const fav = learned[kind];
    if (fav) attempts.sort((a, b) => (a.name === fav ? -1 : b.name === fav ? 1 : 0));

    // Sinais de que a engine está VIVA (tem dados/decodificou) → grava a vencedora e
    // desarma o watchdog de vez. NÃO trocamos mais de engine depois disso.
    const markAlive = () => {
        if (progressed) return;
        progressed = true; clearWatch();
        const cur = attempts[ai - 1]; if (cur) remember(kind, cur.name);
    };
    const ALIVE_EVENTS = ['loadeddata', 'canplay', 'canplaythrough', 'playing', 'timeupdate'];
    const armWatchdog = () => {
        clearWatch();
        // Engine já conhecida → confiamos nela: SEM timer (o fallback vem dos eventos de
        // erro reais). Evita o atraso/corte de 3s a cada troca de canal.
        if (learned[kind]) return;
        watchdog = setTimeout(() => {
            if (destroyed || progressed) return;
            // readyState>=2 (HAVE_CURRENT_DATA) = já tem frame/buffer → só carregando,
            // NÃO troca de engine (evita "preto/recarregando" cortando um stream lento).
            if (video.readyState >= 2) { markAlive(); return; }
            advance(); // conectou mas 0 dados em Xs → engine travada → tenta a próxima
        }, WATCHDOG_MS);
    };

    let ai = 0;
    function advance() {
        if (destroyed) return;
        cleanup();
        if (ai >= attempts.length) { onFatal(); return; }
        progressed = false;
        attempts[ai++].run();
        for (const ev of ALIVE_EVENTS) { video.addEventListener(ev, markAlive); probes.push([ev, markAlive]); }
        armWatchdog();
    }

    // Faixas no caminho NATIVO (texttracks embutidas, Safari/HLS nativo) → avisa a UI.
    video.addEventListener('loadedmetadata', fireTracks);
    try { video.textTracks?.addEventListener?.('addtrack', fireTracks); video.textTracks?.addEventListener?.('change', fireTracks); } catch { /* noop */ }

    // Helpers de faixa (leem da engine ativa: hls.js ou <video> nativo).
    const mapHls = (arr: any[], active: number): Track[] =>
        (arr || []).map((t, i) => ({ id: i, label: t.name || t.lang || t.language || `Faixa ${i + 1}`, active: i === active }));

    advance(); // inicia a 1ª tentativa
    return {
        destroy: () => {
            destroyed = true;
            video.removeEventListener('loadedmetadata', fireTracks);
            try { video.textTracks?.removeEventListener?.('addtrack', fireTracks); video.textTracks?.removeEventListener?.('change', fireTracks); } catch { /* noop */ }
            cleanup();
        },
        onTracks: (cb) => { tracksCb = cb; },
        audioTracks: () => {
            if (hls && (hls.audioTracks?.length || 0) > 1) return mapHls(hls.audioTracks, hls.audioTrack);
            const at: any = (video as any).audioTracks;
            if (at && at.length > 1) { const out: Track[] = []; for (let i = 0; i < at.length; i++) out.push({ id: i, label: at[i].label || at[i].language || `Faixa ${i + 1}`, active: !!at[i].enabled }); return out; }
            return [];
        },
        setAudioTrack: (id) => {
            if (hls && (hls.audioTracks?.length || 0) > 1) { try { hls.audioTrack = id; } catch { /* noop */ } return; }
            const at: any = (video as any).audioTracks;
            if (at) for (let i = 0; i < at.length; i++) at[i].enabled = (i === id);
        },
        subtitleTracks: () => {
            if (hls && (hls.subtitleTracks?.length || 0) > 0) return mapHls(hls.subtitleTracks, hls.subtitleTrack);
            const tt = video.textTracks; const out: Track[] = [];
            if (tt) for (let i = 0; i < tt.length; i++) { const k = tt[i].kind; if (k === 'subtitles' || k === 'captions') out.push({ id: i, label: tt[i].label || tt[i].language || `Legenda ${i + 1}`, active: tt[i].mode === 'showing' }); }
            return out;
        },
        setSubtitleTrack: (id) => {
            if (hls && (hls.subtitleTracks?.length || 0) > 0) { try { hls.subtitleDisplay = id >= 0; hls.subtitleTrack = id; } catch { /* noop */ } return; }
            const tt = video.textTracks;
            if (tt) for (let i = 0; i < tt.length; i++) { const k = tt[i].kind; if (k === 'subtitles' || k === 'captions') tt[i].mode = (i === id ? 'showing' : 'disabled'); }
        },
    };
}

// ============================== MINIATURAS (scrub) ==============================
// Gera o frame do filme numa posição arbitrária (preview estilo Netflix ao segurar
// pro lado na barra). Usa um <video> OCULTO, pausado, que só DECODIFICA um quadro a
// cada busca (bem mais leve que tocar) e desenha no canvas que a UI mostra.
//
// Desenhar um vídeo cross-origin no canvas é permitido pra EXIBIR (só travaria
// getImageData/toDataURL, que não usamos) — então não precisa de CORS no provedor.
export type Thumbnailer = {
    /** Pede o frame de `time` (s) desenhado em `canvas`. Coalesce buscas rápidas. */
    capture: (time: number, canvas: HTMLCanvasElement) => void;
    ready: () => boolean;
    destroy: () => void;
};

export function createThumbnailer(url: string, onFrame?: () => void): Thumbnailer {
    const kind = kindOf(url);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; (v as any).playsInline = true;
    v.style.position = 'fixed'; v.style.left = '-9999px'; v.style.width = '2px'; v.style.height = '2px';
    let hls: Hls | null = null;
    let metaOK = false, primed = false, seeking = false, destroyed = false;
    let pending: { time: number; canvas: HTMLCanvasElement } | null = null;

    const draw = () => {
        if (!pending) return;
        const { canvas } = pending;
        try {
            const ctx = canvas.getContext('2d');
            if (ctx && v.videoWidth) { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); onFrame?.(); }
        } catch { /* engine recusou desenhar — mantém último frame */ }
    };
    const pump = () => {
        if (destroyed || !metaOK || seeking || !pending) return;
        const t = pending.time;
        if (Math.abs(v.currentTime - t) < 0.08) { draw(); return; }
        seeking = true;
        try { v.currentTime = t; } catch { seeking = false; }
    };
    const onSeeked = () => { seeking = false; draw(); pump(); };
    // Em vários WebViews (TV/Android) um vídeo nunca tocado não rende frame ao buscar:
    // "primamos" o decodificador com um play/pause mudo na 1ª carga.
    const onMeta = () => {
        metaOK = true;
        if (!primed) {
            primed = true;
            const p = v.play();
            if (p && p.then) p.then(() => { try { v.pause(); } catch { /* noop */ } pump(); }).catch(() => pump());
            else pump();
        } else pump();
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('seeked', onSeeked);

    if (kind === 'hls' && !canNativeHls(v)) {
        loadHls().then((HlsC) => {
            if (destroyed) return;
            if (HlsC.isSupported()) { hls = new HlsC({ enableWorker: true, lowLatencyMode: false }); hls!.loadSource(url); hls!.attachMedia(v); }
            else { v.src = url; try { v.load(); } catch { /* noop */ } }
        });
    } else {
        v.src = url;
    }
    try { document.body.appendChild(v); v.load(); } catch { /* noop */ }

    return {
        capture(time, canvas) { pending = { time: Math.max(0, time), canvas }; pump(); },
        ready() { return metaOK && v.videoWidth > 0; },
        destroy() {
            destroyed = true;
            v.removeEventListener('loadedmetadata', onMeta);
            v.removeEventListener('seeked', onSeeked);
            if (hls) { try { hls.destroy(); } catch { /* noop */ } }
            try { v.removeAttribute('src'); v.load(); v.remove(); } catch { /* noop */ }
        },
    };
}
