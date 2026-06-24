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
// entra direto nos canais (auto-play)
await p.waitForSelector('.chan-row', { timeout: 60000 }).catch(()=>{});
await p.waitForTimeout(6000);
await p.screenshot({ path: out('07-canais-entrada.png') });
const head = await p.$eval('.chan-scroll .chan-divider span', e => e.textContent).catch(()=>null);
const onName = await p.$eval('.chan-row.on .chan-name', e => e.textContent).catch(()=>null);
console.log('1o divisor:', head, '| canal tocando:', onName);
// abre categorias na lista
await p.click('.chan-list-head .back').catch(()=>{});
await p.waitForSelector('.cat-row', { timeout: 15000 }).catch(()=>{});
await p.waitForTimeout(1500);
await p.screenshot({ path: out('08-canais-categorias.png') });
const firstCats = await p.$$eval('.cat-row .cat-row-name', els => els.slice(0,4).map(e=>e.textContent));
console.log('1as categorias:', JSON.stringify(firstCats));
await b.close();
