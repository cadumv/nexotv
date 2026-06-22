// Entry point for the NexoTV server running inside the Android APK (nodejs-mobile).
// Configures runtime env, boots the bundled Express/Stremio backend, then warms
// up the cache so the IPTV catalogs are already loaded by the time Stremio opens.
//
// >>> FILL IN YOUR OWN VALUES BELOW (placeholders shipped for safety). <<<

process.env.CONFIG_SECRET = process.env.CONFIG_SECRET || 'CHANGE_ME_CONFIG_SECRET';
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'CHANGE_ME_TMDB_API_KEY';
process.env.CACHE_ENABLED = process.env.CACHE_ENABLED || 'true';
process.env.PORT = process.env.PORT || '7000';
process.env.DEBUG_MODE = process.env.DEBUG_MODE || 'false';
// Keep VOD/series data in RAM longer to reduce re-fetches (no SQLite persistence on mobile).
process.env.DATA_MEMORY_TTL_MS = process.env.DATA_MEMORY_TTL_MS || '3600000';
// Local single-user server: rate limiting only hurts here.
process.env.IP_RATE_LIMIT_ENABLED = process.env.IP_RATE_LIMIT_ENABLED || 'false';
process.env.TOKEN_RATE_LIMIT_ENABLED = process.env.TOKEN_RATE_LIMIT_ENABLED || 'false';

try {
    require('./packages/backend/dist/server.js');
} catch (e) {
    console.error('[NEXOTV-MOBILE] Failed to start server:', e && e.stack ? e.stack : e);
}

// --- Warm-up: pre-fetch the IPTV data on boot, in the background ---
// WARM_TOKEN is a base64url config token for YOUR Xtream account (same one the
// Stremio addon uses). Generate it from your config; do NOT commit a real one.
const http = require('http');
const PORT = process.env.PORT || '7000';
const WARM_TOKEN = process.env.WARM_TOKEN || 'CHANGE_ME_BASE64URL_CONFIG_TOKEN';

let warmTries = 0;
function warmUp() {
    warmTries++;
    const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/' + WARM_TOKEN + '/catalog/movie/nexotv_vod.json', timeout: 90000 },
        (res) => {
            let n = 0;
            res.on('data', (c) => { n += c.length; });
            res.on('end', () => { console.log('[NEXOTV-MOBILE] warm-up complete, catalog bytes=' + n); });
        }
    );
    req.on('error', () => { if (warmTries < 15) setTimeout(warmUp, 3000); });
    req.on('timeout', () => { req.destroy(); });
}
setTimeout(warmUp, 2500);

// --- Voice search bridge (port 7001) ---
let pendingQuery = '';
const voiceServer = http.createServer((req, res) => {
    try {
        const u = new URL(req.url, 'http://127.0.0.1:7001');
        if (u.pathname === '/voice/search') {
            pendingQuery = (u.searchParams.get('q') || '').trim();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, queued: pendingQuery }));
        } else if (u.pathname === '/voice/pending') {
            const q = pendingQuery; pendingQuery = '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ query: q }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
    }
});
voiceServer.on('error', (e) => console.error('[NEXOTV-VOICE] bridge error: ' + e.message));
voiceServer.listen(7001, '127.0.0.1', () => console.log('[NEXOTV-VOICE] voice bridge listening on 7001'));

// --- Cloud poller: pull voice queries from your Cloudflare Worker (fed by the
// Alexa skill). Fill these after deploying the Worker (see alexa-bridge/). ---
const CLOUD_BRIDGE_URL = process.env.CLOUD_BRIDGE_URL || '';     // e.g. 'https://your-worker.workers.dev'
const CLOUD_BRIDGE_SECRET = process.env.CLOUD_BRIDGE_SECRET || ''; // must match the Worker's SHARED_SECRET

const https = require('https');
function pollCloud() {
    if (!CLOUD_BRIDGE_URL || !CLOUD_BRIDGE_SECRET) return;
    const u = CLOUD_BRIDGE_URL.replace(/\/$/, '') + '/get?secret=' + encodeURIComponent(CLOUD_BRIDGE_SECRET);
    const req = https.get(u, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
            try {
                const q = (JSON.parse(data).query || '').trim();
                if (q) { pendingQuery = q; console.log('[NEXOTV-VOICE] cloud query -> ' + q); }
            } catch (e) { /* ignore */ }
        });
    });
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
}
if (CLOUD_BRIDGE_URL && CLOUD_BRIDGE_SECRET) {
    setInterval(pollCloud, 2500);
    console.log('[NEXOTV-VOICE] cloud poller active');
}
