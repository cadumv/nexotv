// Proxy de logos local p/ VALIDAR a detecção de fundo (espelha o que o Cloudflare
// Worker /img fará em produção): busca o logo via wsrv (resize+trim, transparência
// preservada) e devolve com Access-Control-Allow-Origin:* + cache. CORS-limpo.
import http from 'node:http';

const cache = new Map(); // u -> {buf, type}
const PORT = 8787;

http.createServer(async (req, res) => {
    try {
        const u = new URL(req.url, `http://localhost:${PORT}`);
        if (u.pathname !== '/img') { res.writeHead(404); return res.end('no'); }
        const orig = u.searchParams.get('u');
        if (!orig) { res.writeHead(400); return res.end('missing u'); }
        const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' };
        if (cache.has(orig)) { const c = cache.get(orig); res.writeHead(200, { 'Content-Type': c.type, ...cors }); return res.end(c.buf); }
        const wsrv = `https://wsrv.nl/?url=${encodeURIComponent(orig)}&w=320&trim=10`;
        const r = await fetch(wsrv);
        if (!r.ok) { res.writeHead(502, cors); return res.end('upstream ' + r.status); }
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type') || 'image/png';
        cache.set(orig, { buf, type });
        res.writeHead(200, { 'Content-Type': type, ...cors });
        res.end(buf);
    } catch (e) {
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*' }); res.end(String(e));
    }
}).listen(PORT, () => console.log(`imgproxy CORS-limpo em http://localhost:${PORT}/img?u=<url>`));
