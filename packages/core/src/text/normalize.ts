/**
 * Helpers de texto, puros — usados em matching de títulos e exibição.
 * Migrado/consolidado de backend (titleMatch + stripAccents do M3UEPGAddon).
 */

const QUALITY_TOKENS = new Set([
    '4k', 'uhd', 'fhd', 'hd', 'sd', 'dv', 'hdr', 'hdr10', 'h265', 'h264', 'x265', 'x264',
    'dual', 'dublado', 'dub', 'leg', 'legendado', 'nacional', 'atmos', 'web', 'webdl',
    'bluray', 'bdrip', '2160p', '1080p', '720p', '480p', 'remux', 'imax', 'extended',
]);

/**
 * Remove acentos via mapa manual (não depende de ICU/`normalize('NFD')`, que é
 * no-op em alguns runtimes como o nodejs-mobile). Mantém o resto do texto.
 */
export function stripAccents(s: string): string {
    if (!s) return s;
    const MAP: Record<string, string> = {
        'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
        'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
        'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
        'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
        'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
        'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
        'Á': 'A', 'À': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
        'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
        'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
        'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
        'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
        'Ç': 'C', 'Ñ': 'N',
    };
    let out = '';
    for (const ch of s) out += (MAP[ch] !== undefined ? MAP[ch] : ch);
    return out;
}

/** Compacta para alfanuméricos minúsculos (sem acento) — matching fuzzy. */
export function compact(s: string): string {
    return stripAccents(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normaliza um título para matching: tira [tags], (ano), acentos, tokens de
 * qualidade/idioma e pontuação.
 */
export function normalizeTitle(s: string | undefined | null): string {
    if (!s) return '';
    let t = String(s).toLowerCase();
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    t = stripAccents(t);
    t = t.replace(/[^a-z0-9]+/g, ' ').trim();
    const kept = t.split(/\s+/).filter(w => w && !QUALITY_TOKENS.has(w));
    return kept.join(' ').trim();
}

/**
 * Limpa um título de provedor para busca (TMDB): tira [tags], (..), tokens de
 * qualidade e ano final, mas mantém palavras/acentos legíveis.
 */
export function cleanForSearch(s: string | undefined | null): string {
    if (!s) return '';
    let t = String(s).replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    t = t.split(/\s+/).filter(w => w && !QUALITY_TOKENS.has(w.toLowerCase())).join(' ');
    t = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
}
