// QA visual autônomo do Rajada: semeia a config no localStorage, abre o app,
// tira prints e coleta diagnóstico objetivo (dimensões reais de cada tile,
// imagens quebradas, e logos que deram 404). Roda: node qa/shoot.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const URL = process.env.RAJADA_URL || 'http://localhost:5173/';
const cfg = JSON.parse(readFileSync(join(HERE, 'rajada.config.json'), 'utf8'));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// Coleta de respostas com falha (404 etc.) — pra saber quais logos quebram.
const failed = [];
page.on('response', (r) => { if (!r.ok()) failed.push({ status: r.status(), url: r.url() }); });
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE-ERR:', m.text()); });

// 1) abre uma vez pra existir a origin, semeia o localStorage, recarrega.
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.evaluate((c) => {
    localStorage.setItem('rajada.config.v1', JSON.stringify(c));
}, cfg);
await page.reload({ waitUntil: 'domcontentloaded' });

const sleepN = (ms) => page.waitForTimeout(ms);

// 2) TELA INICIAL (3 cards).
try { await page.waitForSelector('.pick-cards .pick-card', { timeout: 30000 }); } catch { console.log('!! pick screen não apareceu'); }
await sleepN(1500);
await page.screenshot({ path: join(OUT, '00-pick.png') });

// 3) CANAIS → categorias.
await page.click('.pc-tv').catch(() => { });
try { await page.waitForSelector('.cat-grid .cat-card', { timeout: 90000 }); } catch { console.log('!! categorias de canais não apareceram'); }
await sleepN(1500);
await page.screenshot({ path: join(OUT, '01-categorias.png') });

// 4) entra numa categoria → lista + player ao vivo.
const cards = await page.$$('.cat-grid .cat-card');
if (cards.length) {
    // pega uma categoria com canais "normais" (não a 1ª que é Jogos) se houver
    await (cards[Math.min(2, cards.length - 1)]).click();
    try { await page.waitForSelector('.chan-live .chan-row', { timeout: 30000 }); } catch { }
    await sleepN(6000); // deixa logos/stream resolverem
    await page.screenshot({ path: join(OUT, '02-canais-ao-vivo.png') });
    // zapa 3 canais pra baixo (testa navegação)
    const stage = await page.$('.chan-live'); if (stage) await stage.focus();
    for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowDown'); await sleepN(500); }
    await sleepN(2000);
    await page.screenshot({ path: join(OUT, '03-zapping.png') });
}

// 5) FILMES (fileiras de pôster) pra conferir que continuam ok.
await page.click('.tabs-top button:has-text("Filmes")').catch(() => { });
try { await page.waitForSelector('.tiles .tile img', { timeout: 60000 }); } catch { }
await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await sleep(100); }
    window.scrollTo(0, 0); await sleep(200);
});
await sleepN(6000);
await page.screenshot({ path: join(OUT, '04-filmes.png'), fullPage: true });

// 6) diagnóstico das fileiras de filmes + da lista de canais.
const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.row, section.row')];
    const out = [];
    // pega TODAS as fileiras com tiles (inclui as sem classe .row explícita)
    const tileRows = [...document.querySelectorAll('.tiles')];
    for (const tr of tileRows) {
        const head = tr.parentElement?.querySelector('h2')?.textContent?.trim() || '(sem título)';
        const tiles = [...tr.querySelectorAll('.tile')].slice(0, 12).map((t) => {
            const img = t.querySelector('img');
            const r = t.getBoundingClientRect();
            const cls = t.className.replace('tile', '').trim();
            return {
                cls,
                w: Math.round(r.width), h: Math.round(r.height),
                ratio: +(r.width / r.height).toFixed(2),
                imgW: img?.naturalWidth || 0, imgH: img?.naturalHeight || 0,
                imgRatio: img?.naturalWidth ? +(img.naturalWidth / img.naturalHeight).toFixed(2) : 0,
                broken: !img || img.naturalWidth === 0,
                src: (img?.currentSrc || img?.src || '').slice(0, 90),
            };
        });
        out.push({ row: head, count: tr.querySelectorAll('.tile').length, tiles });
    }
    return out;
});

// 5) resumo de problemas: tiles com forma divergente dentro da mesma fileira +
//    imagens quebradas.
const summary = report.map((row) => {
    const shapes = [...new Set(row.tiles.map((t) => t.cls))];
    const broken = row.tiles.filter((t) => t.broken).length;
    return { row: row.row, count: row.count, shapesNaFileira: shapes, brokenVisiveis: broken };
});

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ summary, report, failedResponses: failed.filter(f => /\.(png|jpg|jpeg|svg|webp)|wsrv|placehold|image/i.test(f.url)).slice(0, 60) }, null, 2));
console.log('OK -> qa/out/00-home.png + report.json');
console.log('Fileiras:', summary.length, '| respostas com falha:', failed.length);
await browser.close();
