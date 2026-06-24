// Camada de player ADAPTATIVA — toca em qualquer TV/plataforma sem código por marca.
//
// Por que: cada TV (Samsung/LG/Android/desktop) suporta um conjunto diferente de
// formas de tocar vídeo, e isso muda com atualizações de firmware. Em vez de fixar
// um método, detectamos em RUNTIME o que a plataforma aceita (canPlayType / MSE) e
// montamos uma CADEIA de tentativas, da melhor opção pra TV até o último recurso.
// Se uma falha, cai pra próxima sozinho. Como é só feature-detection, se adapta a
// qualquer marca e a futuras atualizações sem mexer no código.
//
// Cadeia por tipo de stream:
//  - HLS (.m3u8):  HLS nativo (decodificador de HW da TV) → hls.js (MSE) → nativo
//  - MPEG-TS (.ts, /live/): TS nativo (a maioria das TVs decodifica) → hls.js (caso
//    o endpoint sirva HLS) → nativo
//  - direto (mp4/mkv/…): nativo
//
// Limite honesto: se a TV NÃO tem o decodificador de hardware do codec (ex.: HEVC/
// H.265, áudio AC3), nenhum player em JS "inventa" o codec — a cadeia se esgota e o
// app cai pra próxima FONTE do canal (failover de fontes, já existente). A camada
// maximiza compatibilidade; não substitui hardware ausente.
import Hls from 'hls.js';

export type AdaptiveHandle = { destroy: () => void };

function kindOf(url: string): 'hls' | 'ts' | 'direct' {
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
 * alternativas quando uma falha. Chama `onFatal` quando TODAS as tentativas se
 * esgotam (aí o chamador troca de fonte). Retorna { destroy } pra limpar.
 */
export function attachAdaptive(video: HTMLVideoElement, url: string, onFatal: () => void): AdaptiveHandle {
    let destroyed = false;
    let hls: Hls | null = null;
    let onErr: (() => void) | null = null;

    const cleanup = () => {
        if (hls) { try { hls.destroy(); } catch { /* noop */ } hls = null; }
        if (onErr) { video.removeEventListener('error', onErr); onErr = null; }
        try { video.removeAttribute('src'); video.load(); } catch { /* noop */ }
    };

    const play = () => { const p = video.play(); if (p && p.catch) p.catch(() => { /* autoplay */ }); };

    const useNative = () => {
        video.src = url;
        onErr = () => advance();
        video.addEventListener('error', onErr, { once: true });
        play();
    };
    const useHlsJs = () => {
        if (!Hls.isSupported()) { advance(); return; }
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) advance(); });
        hls.loadSource(url);
        hls.attachMedia(video);
        play();
    };

    // Monta a cadeia conforme o tipo + o que a plataforma suporta.
    const kind = kindOf(url);
    const attempts: Array<() => void> = [];
    if (kind === 'hls') {
        if (canNativeHls(video)) attempts.push(useNative);
        attempts.push(useHlsJs);
        if (!canNativeHls(video)) attempts.push(useNative);
    } else if (kind === 'ts') {
        if (canNativeTs(video)) attempts.push(useNative);
        attempts.push(useHlsJs);
        if (!canNativeTs(video)) attempts.push(useNative);
    } else {
        attempts.push(useNative);
    }

    let ai = 0;
    const advance = () => {
        if (destroyed) return;
        cleanup();
        if (ai >= attempts.length) { onFatal(); return; }
        attempts[ai++]();
    };

    advance(); // inicia a 1ª tentativa
    return { destroy: () => { destroyed = true; cleanup(); } };
}
