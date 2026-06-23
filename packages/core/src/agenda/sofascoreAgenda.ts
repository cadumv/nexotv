/**
 * Agenda de futebol (Sofascore), independente de servidor.
 *
 * Dois modos:
 *  - **relay** (preferido no app): busca de um Worker `/agenda` (1 GET barato,
 *    sem chave no aparelho, sem quota).
 *  - **direto**: consulta cada canal BR no Sofascore via RapidAPI (precisa da
 *    chave). Usado no server single-device.
 *
 * Rede via `HttpClient`.
 */
import { HttpClient } from '../http/HttpClient';

export interface AgendaGame {
    home: string; away: string; startMs: number; stopMs: number;
    tournament: string; channels: string[];   // nomes de canal Sofascore
}

export interface AgendaConfig {
    /** URL do relay (Worker /agenda?secret=…). Tem precedência. */
    agendaUrl?: string | null;
    /** RapidAPI (modo direto). */
    rapidApiKey?: string | null;
    rapidApiHost?: string;
    /** TTL do cache em memória (ms). Default 12h. */
    ttlMs?: number;
}

/** Canais de futebol BR (channelId Sofascore → nome). Usado no modo direto. */
export const BR_FOOTBALL_CHANNELS: { id: number; name: string }[] = [
    { id: 5613, name: 'Premiere' }, { id: 3179, name: 'Premiere 2' }, { id: 3180, name: 'Premiere 3' },
    { id: 3181, name: 'Premiere 4' }, { id: 3182, name: 'Premiere 5' }, { id: 3191, name: 'Premiere 6' },
    { id: 3307, name: 'Premiere 7' }, { id: 3308, name: 'Premiere 8' },
    { id: 7213, name: 'Sportv' }, { id: 151, name: 'ESPN' }, { id: 6049, name: 'TV Globo' }, { id: 1811, name: 'SBT' },
    { id: 5264, name: 'DAZN' }, { id: 6491, name: 'CazeTV' }, { id: 7209, name: 'Disney+' }, { id: 7225, name: 'Paramount+' },
];

let _cache: { ts: number; data: AgendaGame[] } | null = null;

/**
 * Retorna a agenda agregada. Sem agendaUrl nem chave → []. Cacheado em memória.
 */
export async function fetchSofascoreAgenda(http: HttpClient, config: AgendaConfig): Promise<AgendaGame[]> {
    const ttl = config.ttlMs ?? 12 * 3600 * 1000;
    if (_cache && Date.now() - _cache.ts < ttl) return _cache.data;

    // Modo relay: 1 GET no Worker.
    if (config.agendaUrl) {
        try {
            const resp = await http.get(config.agendaUrl, { timeoutMs: 15000 });
            if (resp && resp.ok) {
                const j: any = await resp.json();
                const data: AgendaGame[] = Array.isArray(j?.games) ? j.games : [];
                _cache = { ts: Date.now(), data };
                return data;
            }
        } catch { /* cai pro cache abaixo */ }
        return _cache?.data || [];
    }

    // Modo direto: consulta cada canal no RapidAPI.
    if (!config.rapidApiKey) return [];
    const host = config.rapidApiHost || 'sofascore.p.rapidapi.com';
    const headers = { 'x-rapidapi-host': host, 'x-rapidapi-key': config.rapidApiKey };
    const byGame = new Map<string, AgendaGame>();
    for (const ch of BR_FOOTBALL_CHANNELS) {
        try {
            const r = await http.get(`https://${host}/tvchannels/get-schedules?channelId=${ch.id}`, { headers, timeoutMs: 15000 });
            if (!r.ok) continue;
            const j: any = await r.json();
            const events = Array.isArray(j?.events) ? j.events : [];
            for (const e of events) {
                if (e?.sport?.slug && e.sport.slug !== 'football') continue;
                const home = e?.homeTeam?.name, away = e?.awayTeam?.name, ts = e?.startTimestamp;
                if (!home || !away || !ts) continue;
                const startMs = ts * 1000;
                const d = new Date(startMs);
                const k = `${home}|${away}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`.toLowerCase();
                if (!byGame.has(k)) {
                    byGame.set(k, { home, away, startMs, stopMs: startMs + 2.5 * 3600 * 1000, tournament: e?.tournament?.name || '', channels: [] });
                }
                const g = byGame.get(k)!;
                if (!g.channels.includes(ch.name)) g.channels.push(ch.name);
            }
        } catch { /* ignora erro por canal */ }
    }
    const data = [...byGame.values()];
    _cache = { ts: Date.now(), data };
    return data;
}
