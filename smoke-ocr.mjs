import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const B = 'http://192.168.3.185:5185';
const img = readFileSync('/tmp/meter-bad.png').toString('base64');
const b = await chromium.launch();
const p = await b.newPage();
const logs = [];
p.on('console', (m) => { const t = m.text(); if (t.includes('[ptr]')) logs.push(t); });
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
await p.goto(B + '/login', { waitUntil: 'networkidle' });
await p.locator('input').nth(0).fill('cd-water');
await p.locator('input').nth(1).fill('admin');
await p.locator('input[type="password"]').fill('admin12345');
await p.click('button[type="submit"]');
await p.waitForTimeout(2500);
await p.evaluate(() => { window.__ocrDebug = true; });
// 先确认 release + opencv.js 可用
console.log('RELEASE:', await (await p.request.get(B + '/release.json')).json().then(j => j.commit ?? j).catch(() => 'n/a'));
const cvOk = await p.evaluate(async () => {
  const r = await fetch('/opencv/opencv.js', { method: 'HEAD' });
  return r.status + ' ' + (r.headers.get('content-length') || '?');
});
console.log('OPENCV-ASSET:', cvOk);
const res = await p.evaluate(async (b64) => {
  const hook = window.__meterOcr;
  if (!hook) return { err: 'no hook' };
  return await hook.recognizeMeterReading('data:image/png;base64,' + b64);
}, img);
console.log('OCR-RESULT:', JSON.stringify(res));
console.log('--- ptr logs ---');
logs.slice(-30).forEach((l) => console.log(l));
await b.close();
