import xml2js from 'xml2js';

/**
 * Parser de EPG (XMLTV), independente de servidor. Migrado de packages/backend
 * e desacoplado de `env`/`logger`: os limites vêm por parâmetro e o log é um
 * callback opcional.
 */

export interface ParseEpgOptions {
    /** Tamanho máximo do conteúdo (bytes). Acima disso, retorna {}. Default 50 MB. */
    maxBytes?: number;
    /** Máx. de programas futuros mantidos por canal (cobre a agenda). Default 60. */
    futureCap?: number;
    /** Log opcional: (nível, msg, extra?). */
    log?: (level: 'debug' | 'warn', msg: string, extra?: any) => void;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function byteLength(s: string): number {
    // Buffer no Node; TextEncoder no navegador/app.
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
    return new TextEncoder().encode(s).length;
}

/**
 * Parseia XMLTV em um objeto indexado por canal.
 */
export async function parseEPG(content: string, opts: ParseEpgOptions = {}) {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const futureCap = opts.futureCap ?? 60;
    const log = opts.log;

    if (byteLength(content) > maxBytes) {
        const sizeMb = (byteLength(content) / 1024 / 1024).toFixed(1);
        log?.('warn', `[EPG] Content too large (${sizeMb} MB), skipping`);
        return {};
    }

    const start = Date.now();
    try {
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(content);
        const epgData: Record<string, any[]> = {};
        if (result.tv && result.tv.programme) {
            const cutoff = Date.now() - 3600 * 1000; // 1 hora atrás
            const nowTime = Date.now();
            let eventCount = 0;
            for (const prog of result.tv.programme) {
                if (++eventCount % 5000 === 0) {
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
                const stopDate = parseEPGTime(prog.$.stop);
                if (stopDate.getTime() < cutoff) continue;

                const startDate = parseEPGTime(prog.$.start);

                const ch = prog.$.channel;
                if (!epgData[ch]) epgData[ch] = [];
                epgData[ch].push({
                    start: startDate.getTime(),
                    stop: stopDate.getTime(),
                    title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                    desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                });
            }

            for (const ch in epgData) {
                epgData[ch].sort((a, b) => a.start - b.start);
                let futureCount = 0;
                epgData[ch] = epgData[ch].filter(p => {
                    const startTime = p.start;
                    if (startTime > nowTime) {
                        if (futureCount >= futureCap) return false;
                        futureCount++;
                    }
                    return true;
                });
            }
        }
        log?.('debug', 'EPG parsed', {
            channels: Object.keys(epgData).length,
            programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
            ms: Date.now() - start
        });
        return epgData;
    } catch (e: any) {
        log?.('warn', 'EPG parse failed', e?.message);
        return {};
    }
}

/**
 * Parseia horário XMLTV (YYYYMMDDHHmmss +HHMM).
 */
export function parseEPGTime(s: string, epgOffsetHours = 0) {
    if (!s) return new Date();
    const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
    if (m) {
        const base = m[1];
        const tz = m[2] || null;
        const year = parseInt(base.slice(0, 4), 10);
        const month = parseInt(base.slice(4, 6), 10) - 1;
        const day = parseInt(base.slice(6, 8), 10);
        const hour = parseInt(base.slice(8, 10), 10);
        const min = parseInt(base.slice(10, 12), 10);
        const sec = parseInt(base.slice(12, 14), 10);
        let date: Date | undefined;
        if (tz) {
            const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
            const parsed = new Date(iso);
            if (!isNaN(parsed.getTime())) date = parsed;
        }
        if (!date) date = new Date(year, month, day, hour, min, sec);
        if (epgOffsetHours) {
            date = new Date(date.getTime() + epgOffsetHours * 3600000);
        }
        return date;
    }
    const d = new Date(s);
    if (epgOffsetHours && !isNaN(d.getTime()))
        return new Date(d.getTime() + epgOffsetHours * 3600000);
    return d;
}

/** Programa em exibição agora para um canal. */
export function getCurrentProgram(epgData: Record<string, any[]>, channelId: string, epgOffsetHours = 0) {
    if (!channelId || !epgData[channelId]) return null;
    const nowTime = Date.now();
    for (const p of epgData[channelId]) {
        const start = p.start + (epgOffsetHours * 3600000);
        const stop = p.stop + (epgOffsetHours * 3600000);
        if (nowTime >= start && nowTime <= stop) {
            const startDate = new Date(start);
            const stopDate = new Date(stop);
            return { title: p.title, description: p.desc, start: startDate, stop: stopDate, startTime: startDate, stopTime: stopDate };
        }
    }
    return null;
}

/** Próximos programas de um canal. */
export function getUpcomingPrograms(epgData: Record<string, any[]>, channelId: string, limit = 5, epgOffsetHours = 0) {
    if (!channelId || !epgData[channelId]) return [];
    const nowTime = Date.now();
    const upcoming: any[] = [];
    for (const p of epgData[channelId]) {
        const start = p.start + (epgOffsetHours * 3600000);
        if (start > nowTime && upcoming.length < limit) {
            upcoming.push({
                title: p.title,
                description: p.desc,
                startTime: new Date(start),
                stopTime: new Date(p.stop + (epgOffsetHours * 3600000))
            });
        }
    }
    return upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
