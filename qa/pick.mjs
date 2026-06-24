import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(new URL('./rajada.config.json', import.meta.url), 'utf8'));
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1366, height: 820 } });
const p = await ctx.newPage();
const U = process.env.RAJADA_URL || 'http://localhost:4173/';
await p.goto(U, { waitUntil: 'domcontentloaded' });
await p.evaluate((c) => localStorage.setItem('rajada.config.v1', JSON.stringify(c)), cfg);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.pick-card', { timeout: 30000 }).catch(()=>{});
await p.waitForTimeout(12000); // espera a arte (poster/logos) chegar
await p.screenshot({ path: new URL('./out/00-pick.png', import.meta.url).pathname.replace(/^\//,'') });
console.log('pick shot ok');
await b.close();
