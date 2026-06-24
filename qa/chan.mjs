import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('./rajada.config.json', import.meta.url), 'utf8'));
const b = await chromium.launch({ headless: true });
const out = (n) => new URL('./out/' + n, import.meta.url).pathname.replace(/^\//, '');
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const p = await ctx.newPage();
await p.goto(process.env.RAJADA_URL || 'http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await p.evaluate((c) => localStorage.setItem('rajada.config.v1', JSON.stringify(c)), cfg);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.pick-card', { timeout: 30000 }).catch(()=>{});
await p.click('.pc-channels').catch(()=>{});
await p.waitForSelector('.cat-row, .chan-row', { timeout: 60000 }).catch(()=>{});
await p.waitForTimeout(4000);
await p.screenshot({ path: out('07-canais-categorias.png') });
// clica numa categoria (ex: 4K / Abertos) — pega a 2a
const cr = await p.$$('.cat-row');
console.log('categorias na lista:', cr.length);
if (cr.length) { await cr[Math.min(2, cr.length-1)].click(); await p.waitForSelector('.chan-row', {timeout:15000}).catch(()=>{}); await p.waitForTimeout(5000); await p.screenshot({ path: out('08-canais-lista.png') }); }
await b.close();
