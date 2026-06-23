/**
 * Football agenda via Sofascore (RapidAPI / Dojo). The IPTV EPG often omits the
 * match name on PPV channels (Premiere, DAZN…), so games there never show up.
 * Sofascore knows, per BR TV channel, exactly which games it airs — so we query
 * each relevant channel's schedule and aggregate by game. The result tells us,
 * for each match, the EXACT BR broadcaster (e.g. "Premiere 2"), which we then map
 * to the user's IPTV channels.
 *
 * One request per channel, cached aggressively (SOFASCORE_TTL_MS) to respect the
 * free-tier quota. No key set → returns [] and the caller falls back to EPG-only.
 */
import env from '../config/env';
import { makeLogger } from './logger';

const log = makeLogger();

// Curated BR football channels (Sofascore channelId → display name). IDs are
// stable; pulled once from tvchannels/list?countryCode=BR.
export const BR_FOOTBALL_CHANNELS: { id: number; name: string }[] = [
    { id: 5613, name: 'Premiere' }, { id: 3179, name: 'Premiere 2' }, { id: 3180, name: 'Premiere 3' },
    { id: 3181, name: 'Premiere 4' }, { id: 3182, name: 'Premiere 5' }, { id: 3191, name: 'Premiere 6' },
    { id: 3307, name: 'Premiere 7' }, { id: 3308, name: 'Premiere 8' },
    { id: 7213, name: 'Sportv' }, { id: 7214, name: 'Sportv 2' }, { id: 7215, name: 'Sportv 3' }, { id: 7216, name: 'Sportv 4' },
    { id: 151, name: 'ESPN' }, { id: 1414, name: 'ESPN 2' }, { id: 4044, name: 'ESPN 3' }, { id: 684, name: 'ESPN 4' }, { id: 7408, name: 'ESPN 5' },
    { id: 6049, name: 'TV Globo' }, { id: 7008, name: 'Globoplay' },
    { id: 1811, name: 'SBT' }, { id: 7226, name: '+SBT' },
    { id: 681, name: 'Band' }, { id: 946, name: 'BandSports' },
    { id: 5264, name: 'DAZN' }, { id: 7225, name: 'Paramount+' }, { id: 7209, name: 'Disney+' },
    { id: 1962, name: 'TNT' }, { id: 1738, name: 'Space' },
    { id: 5906, name: 'NSports' }, { id: 7297, name: 'Canal Goat' }, { id: 6491, name: 'CazeTV' },
];

export interface AgendaGame {
    home: string; away: string; startMs: number; stopMs: number;
    tournament: string; channels: string[];   // Sofascore channel display names
}

let _cache: { ts: number; data: AgendaGame[] } | null = null;
let _inflight: Promise<AgendaGame[]> | null = null;

function gameKey(home: string, away: string, startMs: number) {
    const d = new Date(startMs);
    return `${home}|${away}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`.toLowerCase();
}

async function fetchChannelSchedule(ch: { id: number; name: string }, headers: Record<string, string>) {
    try {
        const url = `https://${env.SOFASCORE_RAPIDAPI_HOST}/tvchannels/get-schedules?channelId=${ch.id}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        let resp: any;
        try { resp = await fetch(url, { headers, signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
        if (!resp || !resp.ok) return [];
        const j: any = await resp.json();
        return Array.isArray(j?.events) ? j.events : [];
    } catch { return []; }
}

/** Run promise-returning tasks with a small concurrency cap (gentle on the API). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Aggregated BR football agenda: each game with the Sofascore channels airing it.
 * Cached for SOFASCORE_TTL_MS. Returns [] if no API key (caller uses EPG only).
 *
 * `allowNetwork` gates the actual quota spend: when false (no live/imminent game),
 * we only serve cache and never hit the API — so idle periods cost zero requests.
 */
export async function fetchSofascoreAgenda(allowNetwork = true): Promise<AgendaGame[]> {
    // Relay mode: a central Worker already aggregated the agenda for all devices.
    // One cheap GET, no RapidAPI key on the device, no quota concern → no gate.
    if (env.SOFASCORE_AGENDA_URL) {
        if (_cache && Date.now() - _cache.ts < Math.min(env.SOFASCORE_TTL_MS as number, 3600000)) return _cache.data;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let resp: any;
            try { resp = await fetch(env.SOFASCORE_AGENDA_URL as string, { signal: ctrl.signal }); }
            finally { clearTimeout(timer); }
            if (resp && resp.ok) {
                const j: any = await resp.json();
                const data: AgendaGame[] = Array.isArray(j?.games) ? j.games : [];
                _cache = { ts: Date.now(), data };
                return data;
            }
        } catch (e: any) { log.warn?.('[SOFASCORE] relay fetch failed', e?.message); }
        return _cache?.data || [];
    }

    const key = env.SOFASCORE_RAPIDAPI_KEY;
    if (!key) return [];
    if (_cache && Date.now() - _cache.ts < env.SOFASCORE_TTL_MS) return _cache.data;
    if (!allowNetwork) return _cache?.data || [];
    if (_inflight) return _inflight;

    _inflight = (async () => {
        const headers = { 'x-rapidapi-host': env.SOFASCORE_RAPIDAPI_HOST as string, 'x-rapidapi-key': key };
        const byGame = new Map<string, AgendaGame>();
        const lists = await mapLimit(BR_FOOTBALL_CHANNELS, 4, ch =>
            fetchChannelSchedule(ch, headers).then(events => ({ ch, events })));
        for (const { ch, events } of lists) {
            for (const e of events) {
                if (e?.sport?.slug && e.sport.slug !== 'football') continue;
                const home = e?.homeTeam?.name, away = e?.awayTeam?.name, ts = e?.startTimestamp;
                if (!home || !away || !ts) continue;
                const startMs = ts * 1000;
                const k = gameKey(home, away, startMs);
                if (!byGame.has(k)) {
                    byGame.set(k, { home, away, startMs, stopMs: startMs + 2.5 * 3600 * 1000, tournament: e?.tournament?.name || '', channels: [] });
                }
                const g = byGame.get(k)!;
                if (!g.channels.includes(ch.name)) g.channels.push(ch.name);
            }
        }
        const data = [...byGame.values()];
        _cache = { ts: Date.now(), data };
        log.debug?.('[SOFASCORE] agenda fetched', { games: data.length });
        return data;
    })();
    try { return await _inflight; }
    catch (e: any) { log.warn?.('[SOFASCORE] agenda failed', e?.message); return _cache?.data || []; }
    finally { _inflight = null; }
}
