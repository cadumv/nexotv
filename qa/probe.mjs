import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
const url = 'https://wsrv.nl/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiptv-org%2Fdb%2Fmaster%2Flogos%2FCNNBrasil.png&w=320&trim=10';
const r = await p.evaluate(async (u) => {
  const test = (cors) => new Promise((res) => {
    const im = new Image(); if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => { let canvas='no'; try{const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d');x.drawImage(im,0,0);x.getImageData(0,0,1,1);canvas='ok';}catch(e){canvas=String(e).slice(0,50);} res({ok:true,w:im.naturalWidth,canvas}); };
    im.onerror = (e) => res({ok:false});
    im.src = u;
  });
  return { semCors: await test(false), comCors: await test(true) };
}, url);
console.log(JSON.stringify(r,null,2));
await b.close();
