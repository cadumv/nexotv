/**
 * NexoTV ↔ Stremio voice bridge — Cloudflare Worker (free plan, no credit card).
 *
 * Two jobs in one tiny endpoint:
 *  1. Alexa skill backend (HTTPS endpoint): receives the Alexa request, extracts
 *     the spoken search query, stores it, and replies to Alexa.
 *  2. Relay for the Fire TV app: GET /get returns (and clears) the last query so
 *     the NexoTV app on the TV can fire it into Stremio.
 *
 * Storage: a Workers KV namespace bound as VOICE_KV (single key "q").
 *
 * Security: SHARED_SECRET (Worker secret/var) must match on /get and /set so
 * random people can't read/inject your queries. The Alexa POST path is open
 * (Alexa servers call it) but only stores text — harmless.
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

    // --- Manual/testing inject (and could be used by other clients) ---
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

      // Launch ("Alexa, abrir minha telinha") with no query yet → elicit the
      // query slot so the user can answer with JUST the movie name ("top gun"),
      // no trigger word needed.
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

        // Any intent that captured a "query" slot (SearchIntent, DirectSearchIntent,
        // or an elicited slot) is a search. Clean leading carrier verbs as a safety
        // net so a catch-all match like "colocar top gun" still yields "top gun".
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

// Strip leading carrier verbs and any "minha telinha" remnants, so whatever slot
// captured ("colocar top gun", "top gun", ...) reduces to the clean title.
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
