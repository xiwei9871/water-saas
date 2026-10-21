import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const files = {
  bad: '/tmp/meter-bad.png',
  pointer: 'apps/api/testdata/meter-photos/pointer-all.jpg',
  roller1: 'apps/api/testdata/meter-photos/mixed-roller-1.jpg',
  roller2: 'apps/api/testdata/meter-photos/mixed-roller-2.jpg',
};
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('http://192.168.3.185:5185/login', { waitUntil: 'networkidle' });
for (const [k, f] of Object.entries(files)) {
  const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const durl = `data:${mime};base64,` + readFileSync(f).toString('base64');
  const items = await p.evaluate(async (d) => await window.__meterOcr.rawPredict(d), durl);
  writeFileSync(`/tmp/ocr-items-${k}.json`, JSON.stringify(items));
  console.log(k, 'items:', items.length);
}
await b.close();
