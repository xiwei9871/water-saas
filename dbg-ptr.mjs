import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const dataUrl = 'data:image/png;base64,' + readFileSync('/tmp/meter-bad.png').toString('base64');
const b = await chromium.launch();
const p = await b.newPage();
p.on('console', m => { if (m.text().includes('[ptr]')) console.log(m.text()); });
await p.goto('http://192.168.3.185:5185/login', { waitUntil: 'networkidle' });
await p.evaluate(() => { window.__ocrDebug = true; });
const out = await p.evaluate(async (durl) => {
  const fn = window.__meterOcr;
  if (!fn) return 'NO_HOOK';
  const raw = await fn.rawPredict(durl);
  const items = raw.map(i => ({ t: i.text, x: Math.round((Math.min(...i.poly.map(p=>p[0]))+Math.max(...i.poly.map(p=>p[0])))/2), y: Math.round((Math.min(...i.poly.map(p=>p[1]))+Math.max(...i.poly.map(p=>p[1])))/2) }));
  const rec = await fn.recognizeMeterReading(durl);
  return { items, rec };
}, dataUrl);
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
await b.close();
