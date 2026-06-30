/**
 * NexoTV ↔ Stremio voice bridge + agenda de futebol — Cloudflare Worker.
 *
 * /agenda agrega jogos de DUAS fontes (central pra todos os aparelhos):
 *   1. POR CANAL — Sofascore via RapidAPI (get-schedules dos canais BR). Pega
 *      Brasileirão/Premiere/ESPN/etc. Tem COTA → cache de 24h + teto mensal.
 *   2. POR TORNEIO — Sofascore via RapidAPI (get-seasons + get-next-matches). Cobre
 *      QUALQUER campeonato da lista TOURNAMENTS (Brasileirão A/B, Copa do Brasil,
 *      Libertadores, Champions, Copa do Mundo…), inclusive os que a busca por canal
 *      NÃO amarra. Tem cota → cache + teto mensal próprios.
 * As duas são mescladas (dedupe por times + horário); na duplicata vence a por-canal
 * (que sabe o canal exato). Se uma fonte falhar, o /agenda devolve a outra.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Fire TV app polls this to get the pending query ---
    if (path === '/get') {
      if (url.searchParams.get('secret') !== env.SHARED_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }
      const q = (await env.VOICE_KV.get('q')) || '';
      if (q) await env.VOICE_KV.delete('q'); // one-shot: clear after read
      return json({ query: q });
    }

    // --- Shared football agenda (per-channel RapidAPI + per-tournament public) ---
    if (path === '/agenda') {
      if (url.searchParams.get('secret') !== env.SHARED_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }
      try {
        // No plano básico do RapidAPI (cota pequena), a fonte por-torneio já cobre os
        // campeonatos. A por-canal (precisão de subcanal) é cara → só roda se você
        // ativar AGENDA_PER_CHANNEL=1 (e tiver cota/plano pra isso).
        const [perChannel, perTournament] = await Promise.all([
          env.AGENDA_PER_CHANNEL === '1' ? getAgendaCached(env).catch(() => []) : Promise.resolve([]),
          getTournamentsCached(env).catch(() => []),
        ]);
        return json({ games: mergeGames(perChannel, perTournament) });
      } catch (e) {
        return json({ games: [], error: String(e && e.message || e) });
      }
    }

    // --- Manual/testing inject ---
    if (path === '/set') {
      if (url.searchParams.get('secret') !== env.SHARED_SECRET) {
        return json({ error: 'forbidden' }, 403);
      }
      const q = (url.searchParams.get('q') || '').trim();
      await env.VOICE_KV.put('q', q, { expirationTtl: 300 });
      return json({ ok: true, queued: q });
    }

    // --- Alexa skill endpoint (POST from Alexa servers) ---
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

      const type = body?.request?.type;

      if (type === 'LaunchRequest') {
        return json({
          version: '1.0',
          response: {
            outputSpeech: { type: 'PlainText', text: 'O que você quer procurar?' },
            shouldEndSession: false,
            directives: [{
              type: 'Dialog.ElicitSlot',
              slotToElicit: 'query',
              updatedIntent: {
                name: 'SearchIntent',
                confirmationStatus: 'NONE',
                slots: { query: { name: 'query', confirmationStatus: 'NONE' } }
              }
            }]
          }
        });
      }

      if (type === 'IntentRequest') {
        const intent = body.request.intent;
        const name = intent?.name;

        if (name === 'AMAZON.HelpIntent') {
          return alexaSpeak('Diga, por exemplo: procurar Breaking Bad.', false);
        }
        if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent') {
          return alexaSpeak('Ok.', true);
        }

        const slotQuery = intent?.slots?.query?.value || intent?.slots?.title?.value;
        if (slotQuery) {
          const query = cleanQuery(slotQuery);
          if (!query) return alexaSpeak('Não entendi o nome. Tente de novo.', false);
          await env.VOICE_KV.put('q', query, { expirationTtl: 300 });
          return alexaSpeak('Procurando ' + query + ' no Stremio.', true);
        }
      }

      return alexaSpeak('Ok.', true);
    }

    return json({ ok: true, service: 'nexotv-voice-bridge' });
  },
};

function cleanQuery(text) {
  let s = (text || '').toLowerCase().trim();
  s = s.replace(/\b(na|no|em)?\s*minha telinha\b/g, ' ').trim();
  const verbs = [
    'procurar por ', 'buscar por ', 'pesquisar por ',
    'procurar ', 'procura ', 'buscar ', 'busca ', 'pesquisar ', 'pesquisa ',
    'colocar ', 'coloca ', 'botar ', 'bota ', 'poe ', 'põe ',
    'abrir ', 'abre ', 'tocar ', 'toca ', 'passar ', 'passa ',
    'achar ', 'encontrar ', 'assistir ', 'ver '
  ];
  for (const v of verbs) {
    if (s.startsWith(v)) { s = s.slice(v.length); break; }
  }
  return s.replace(/\s+/g, ' ').trim();
}

// === Fonte 1: agenda POR CANAL (Sofascore via RapidAPI, com cota) ============

const AGENDA_CHANNELS = [
  [5613, 'Premiere'], [3179, 'Premiere 2'], [3180, 'Premiere 3'], [3181, 'Premiere 4'],
  [3182, 'Premiere 5'], [3191, 'Premiere 6'], [3307, 'Premiere 7'], [3308, 'Premiere 8'],
  [7213, 'Sportv'], [7214, 'Sportv 2'], [7215, 'Sportv 3'], [7216, 'Sportv 4'],
  [151, 'ESPN'], [1414, 'ESPN 2'], [4044, 'ESPN 3'], [684, 'ESPN 4'], [7408, 'ESPN 5'],
  [6049, 'TV Globo'], [7008, 'Globoplay'], [1811, 'SBT'], [7226, '+SBT'],
  [681, 'Band'], [946, 'BandSports'], [5264, 'DAZN'], [7225, 'Paramount+'], [7209, 'Disney+'],
  [1962, 'TNT'], [1738, 'Space'], [5906, 'NSports'], [7297, 'Canal Goat'], [6491, 'CazeTV'],
];

async function getAgendaCached(env) {
  const REFRESH_MS = parseInt(env.AGENDA_REFRESH_MS || '', 10) || 86400000; // 24h
  const CAP = parseInt(env.AGENDA_MONTHLY_CAP || '', 10) || 1000;
  const now = Date.now();

  const cachedRaw = await env.VOICE_KV.get('agenda');
  const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
  if (cached && now - cached.ts < REFRESH_MS) return cached.games;
  if (!env.SOFASCORE_RAPIDAPI_KEY) return cached ? cached.games : [];

  const month = new Date(now).toISOString().slice(0, 7);
  let cnt = null;
  try { cnt = JSON.parse((await env.VOICE_KV.get('agenda_count')) || 'null'); } catch {}
  if (!cnt || cnt.month !== month) cnt = { month, n: 0 };
  if (cnt.n + AGENDA_CHANNELS.length > CAP) return cached ? cached.games : [];

  const games = await buildAgenda(env);
  cnt.n += AGENDA_CHANNELS.length;
  await env.VOICE_KV.put('agenda_count', JSON.stringify(cnt), { expirationTtl: 3456000 });
  await env.VOICE_KV.put('agenda', JSON.stringify({ ts: now, games }));
  return games;
}

async function buildAgenda(env) {
  const host = env.SOFASCORE_RAPIDAPI_HOST || 'sofascore.p.rapidapi.com';
  const headers = { 'x-rapidapi-host': host, 'x-rapidapi-key': env.SOFASCORE_RAPIDAPI_KEY };
  const results = await Promise.all(AGENDA_CHANNELS.map(async ([id, name]) => {
    try {
      const r = await fetch(`https://${host}/tvchannels/get-schedules?channelId=${id}`, { headers });
      if (!r.ok) return { name, events: [] };
      const j = await r.json();
      return { name, events: Array.isArray(j && j.events) ? j.events : [] };
    } catch { return { name, events: [] }; }
  }));

  const byGame = new Map();
  for (const { name, events } of results) {
    for (const e of events) {
      if (e && e.sport && e.sport.slug && e.sport.slug !== 'football') continue;
      const home = e && e.homeTeam && e.homeTeam.name;
      const away = e && e.awayTeam && e.awayTeam.name;
      const ts = e && e.startTimestamp;
      if (!home || !away || !ts) continue;
      const startMs = ts * 1000;
      const d = new Date(startMs);
      const k = `${home}|${away}|${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`.toLowerCase();
      let g = byGame.get(k);
      if (!g) {
        g = { home, away, startMs, stopMs: startMs + 2.5 * 3600 * 1000, tournament: (e.tournament && e.tournament.name) || '', channels: [] };
        byGame.set(k, g);
      }
      if (!g.channels.includes(name)) g.channels.push(name);
    }
  }
  return [...byGame.values()];
}

// === Fonte 2: agenda POR TORNEIO (Sofascore via RapidAPI — confiável) ========
// Cobre QUALQUER campeonato listado aqui (não só a Copa). Pra cada torneio:
//   get-seasons → temporada atual (cacheada 7d) → get-next-matches → próximos jogos.
// `broadcasters` são nomes que o app já sabe mapear pros canais IPTV do usuário
// (TV Globo, Sportv, ESPN, CazeTV…); pra eventos em canais PPV nomeados pelos times,
// o app casa por nome de time de qualquer jeito. Adicionar campeonato = 1 linha
// { id, broadcasters }. id = uniqueTournament do Sofascore.
// Versão do formato do cache. Suba este número sempre que mudar a LÓGICA de montar os
// jogos (filtros, campos, etc.) → o cache antigo é ignorado no próximo deploy, sem
// precisar apagar nada no KV manualmente.
const CACHE_VERSION = 3;

// `name` = rótulo CANÔNICO (em PT) enviado ao app — não dependemos do nome cru do
// Sofascore, que vem inconsistente (ex.: a Copa do Mundo chega como "World Championship").
// A fase (mata-mata/grupo) é anexada a partir do nome cru em buildTournaments.
const TOURNAMENTS = [
  { id: 325, name: 'Brasileirão Série A', broadcasters: ['Premiere', 'Sportv', 'TV Globo'] },
  { id: 390, name: 'Brasileirão Série B', broadcasters: ['Sportv', 'Premiere'] },
  { id: 373, name: 'Copa do Brasil', broadcasters: ['Premiere', 'Sportv', 'TV Globo'] },
  { id: 384, name: 'Libertadores', broadcasters: ['Paramount+', 'SBT', 'ESPN'] },
  { id: 480, name: 'Copa Sul-Americana', broadcasters: ['Paramount+', 'ESPN'] },
  { id: 16,  name: 'Copa do Mundo', broadcasters: ['TV Globo', 'Sportv', 'CazeTV', 'SBT'] },
  { id: 357, name: 'Mundial de Clubes', broadcasters: ['CazeTV', 'TV Globo', 'Sportv', 'DAZN'] },
  { id: 7,   name: 'Champions League', broadcasters: ['TNT', 'Space', 'SBT'] },
  { id: 679, name: 'Europa League', broadcasters: ['ESPN', 'Disney+'] },
  { id: 17,  name: 'Premier League', broadcasters: ['ESPN', 'Disney+'] },
  { id: 8,   name: 'La Liga', broadcasters: ['ESPN', 'Disney+'] },
  { id: 23,  name: 'Italiano - Série A', broadcasters: ['CazeTV', 'ESPN'] },
];

async function getTournamentsCached(env) {
  // Fonte com cota → refresh mais espaçado que a por-canal. Ajuste TOURNAMENT_REFRESH_MS
  // / TOURNAMENT_MONTHLY_CAP conforme o limite do seu plano RapidAPI.
  const REFRESH_MS = parseInt(env.TOURNAMENT_REFRESH_MS || '', 10) || 86400000; // 24h (plano básico)
  const CAP = parseInt(env.TOURNAMENT_MONTHLY_CAP || '', 10) || 450;
  const now = Date.now();

  let cached = null;
  try { cached = JSON.parse((await env.VOICE_KV.get('agenda_cup')) || 'null'); } catch {}
  const fresh = cached && cached.v === CACHE_VERSION; // ignora cache de versão antiga
  if (fresh && now - cached.ts < REFRESH_MS) return cached.games;
  if (!env.SOFASCORE_RAPIDAPI_KEY) return fresh ? cached.games : [];

  const month = new Date(now).toISOString().slice(0, 7);
  let cnt = null;
  try { cnt = JSON.parse((await env.VOICE_KV.get('agenda_cup_count')) || 'null'); } catch {}
  if (!cnt || cnt.month !== month) cnt = { month, n: 0 };
  if (cnt.n + TOURNAMENTS.length > CAP) return fresh ? cached.games : [];

  let games;
  try { games = await buildTournaments(env); }
  catch { return fresh ? cached.games : []; }
  cnt.n += TOURNAMENTS.length; // 1 chamada next-matches por torneio (seasons quase sempre do cache)
  await env.VOICE_KV.put('agenda_cup_count', JSON.stringify(cnt), { expirationTtl: 3456000 });
  await env.VOICE_KV.put('agenda_cup', JSON.stringify({ v: CACHE_VERSION, ts: now, games }));
  return games;
}

async function sofaRapid(env, path) {
  const host = env.SOFASCORE_RAPIDAPI_HOST || 'sofascore.p.rapidapi.com';
  const headers = { 'x-rapidapi-host': host, 'x-rapidapi-key': env.SOFASCORE_RAPIDAPI_KEY };
  const r = await fetch(`https://${host}${path}`, { headers });
  if (!r || !r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// O wrapper do RapidAPI às vezes embrulha a resposta em `data` — pega o array onde estiver.
function pickArr(j, key) {
  if (!j) return [];
  if (Array.isArray(j[key])) return j[key];
  if (j.data) {
    if (Array.isArray(j.data[key])) return j.data[key];
    if (Array.isArray(j.data)) return j.data;
  }
  return [];
}

// Temporada atual do torneio, cacheada 7d (muda raramente → poupa cota).
async function getSeasonId(env, tid) {
  const cacheKey = `cupseason:${tid}`;
  const cached = await env.VOICE_KV.get(cacheKey);
  if (cached) return cached;
  const j = await sofaRapid(env, `/tournaments/get-seasons?tournamentId=${tid}`);
  const seasons = pickArr(j, 'seasons');
  const s0 = seasons[0];
  const sid = s0 && (s0.id || s0.seasonId);
  if (sid != null) await env.VOICE_KV.put(cacheKey, String(sid), { expirationTtl: 604800 });
  return sid != null ? String(sid) : null;
}

// Nome de time "fantasma" (chave de mata-mata ainda indefinida): W75, L80, A1, 12,
// "Winner …", "Group B" etc. Não é um jogo real ainda → não mostrar.
function isPlaceholderTeam(name) {
  const s = (name || '').trim();
  if (!s) return true;
  if (/^[A-Z]{0,2}\d{1,3}$/i.test(s)) return true;
  if (/\b(winner|loser|vencedor|perdedor)\b/i.test(s)) return true;
  if (/^(group|grupo)\b/i.test(s)) return true;
  return false;
}

async function buildTournaments(env) {
  const now = Date.now();
  const minStart = now - 3 * 3600 * 1000;
  const horizon = now + 10 * 24 * 3600 * 1000; // próximos 10 dias
  const out = [];
  for (const t of TOURNAMENTS) {
    const sid = await getSeasonId(env, t.id);
    if (!sid) continue;
    const j = await sofaRapid(env, `/tournaments/get-next-matches?tournamentId=${t.id}&seasonId=${sid}&pageIndex=0`);
    const evs = pickArr(j, 'events');
    const seen = new Set();
    for (const e of evs) {
      if (e && e.sport && e.sport.slug && e.sport.slug !== 'football') continue;
      const trn = (e && e.tournament && e.tournament.name) || '';
      // Pré-eliminatórias (Champions/Europa) não passam na TV BR → descartar.
      if (/qualif|preliminary|preliminar/i.test(trn)) continue;
      const home = e && e.homeTeam && e.homeTeam.name;
      const away = e && e.awayTeam && e.awayTeam.name;
      const ts = e && e.startTimestamp;
      if (!home || !away || !ts) continue;
      if (isPlaceholderTeam(home) || isPlaceholderTeam(away)) continue;
      const startMs = ts * 1000;
      if (startMs < minStart || startMs > horizon) continue;
      const k = `${home}|${away}|${startMs}`;
      if (seen.has(k)) continue; seen.add(k);
      // Nome canônico (por id) + fase extraída do nome cru (texto após a vírgula).
      const phase = trn.indexOf(',') >= 0 ? trn.slice(trn.indexOf(',') + 1).trim() : '';
      const label = t.name + (phase ? `, ${phase}` : '');
      out.push({
        home, away, startMs, stopMs: startMs + 2.5 * 3600 * 1000,
        tournament: label, channels: t.broadcasters.slice(),
      });
    }
  }
  return out;
}

// Mescla as duas fontes, sem repetir a mesma partida (times + janela de 3h).
function mergeGames(a, b) {
  const out = Array.isArray(a) ? a.slice() : [];
  for (const g of (Array.isArray(b) ? b : [])) {
    const dup = out.some(x => Math.abs((x.startMs || 0) - (g.startMs || 0)) < 3 * 3600 * 1000 && teamsOverlap(x, g));
    if (!dup) out.push(g);
  }
  return out;
}
function normTeam(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
function teamsOverlap(x, g) {
  const a = [normTeam(x.home), normTeam(x.away)];
  const b = [normTeam(g.home), normTeam(g.away)];
  for (const p of a) for (const q of b) if (p && q && (p === q || p.includes(q) || q.includes(p))) return true;
  return false;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function alexaSpeak(text, endSession) {
  return json({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: !!endSession,
    },
  });
}
