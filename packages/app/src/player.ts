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
import Hls from 'hls.js';

export type AdaptiveHandle = { destroy: () => void };
type Kind = 'hls' | 'ts' | 'direct';
type EngineName = 'native' | 'hlsjs';

// Tempo p/ considerar "travou" uma engine que conectou mas não toca.
const WATCHDOG_MS = 3000;

// Engine que JÁ funcionou, por tipo de stream — persistida entre sessões.
const ENGINE_LS = 'rajada.engine.v1';
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
    const runHlsJs = () => {
        if (!Hls.isSupported()) { advance(); return; }
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) advance(); });
        hls.loadSource(url);
        hls.attachMedia(video);
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

    // "tocou de verdade" → grava a engine vencedora e desarma o watchdog.
    const onProgress = () => {
        if (video.currentTime > 0.1 || !video.paused) {
            progressed = true; clearWatch();
            const cur = attempts[ai - 1]; if (cur) remember(kind, cur.name);
        }
    };
    const armWatchdog = () => {
        clearWatch();
        watchdog = setTimeout(() => { if (!destroyed && !progressed) advance(); }, WATCHDOG_MS);
    };

    let ai = 0;
    function advance() {
        if (destroyed) return;
        cleanup();
        if (ai >= attempts.length) { onFatal(); return; }
        progressed = false;
        attempts[ai++].run();
        video.addEventListener('playing', onProgress); video.addEventListener('timeupdate', onProgress);
        probes.push(['playing', onProgress], ['timeupdate', onProgress]);
        armWatchdog();
    }

    advance(); // inicia a 1ª tentativa
    return { destroy: () => { destroyed = true; cleanup(); } };
}
