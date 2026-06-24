import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('./rajada.config.json', import.meta.url), 'utf8'));
const b = await chromium.launch({ headless: true });
const U = process.env.RAJADA_URL || 'http://localhost:4173/';
const out = (n) => new URL('./out/' + n, import.meta.url).pathname.replace(/^\//, '');

// 1) tela inicial num viewport BAIXO (pra garantir que cabe sem rolar)
const ctx = await b.newContext({ viewport: { width: 1366, height: 820 } });
const p = await ctx.newPage();
await p.goto(U, { waitUntil: 'domcontentloaded' });
await p.evaluate((c) => localStorage.setItem('rajada.config.v1', JSON.stringify(c)), cfg);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.pick-card', { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(13000); // arte dos backdrops
const sc = await p.evaluate(() => ({ s: document.documentElement.scrollHeight, c: document.documentElement.clientHeight }));
console.log('viewport 660 -> scrollH', sc.s, 'clientH', sc.c, sc.s > sc.c + 2 ? 'ROLA!' : 'cabe');
await p.screenshot({ path: out('00-pick.png') });

// 2) abre Jogos ao vivo
await p.click('.pc-games').catch(() => {});
await p.waitForSelector('.row, .status', { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(7000);
await p.screenshot({ path: out('06-jogos.png'), fullPage: true });
const rows = await p.$$eval('.row h2', els => els.map(e => e.textContent));
console.log('Jogos - fileiras:', JSON.stringify(rows));
await b.close();
