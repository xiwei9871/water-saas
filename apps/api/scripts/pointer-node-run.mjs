// 纯 Node 复算指针读数：sharp 解码 + 注入 cv + 预计算边缘图喂 __debugPointerRead
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { sobelGray, __debugPointerRead, __setCvForTest } from './ptr-bundle.mjs';

// cv 在纯 Node 顶层同步注入（避开异步加载时序问题）
const cv = createRequire(import.meta.url)('/Users/xiwei/water-saas/node_modules/.pnpm/@techstark+opencv-js@4.10.0-release.1/node_modules/@techstark/opencv-js/dist/opencv.js');
if (!cv.Mat) cv.onRuntimeInitialized = () => { cv.__ready = true; };
await new Promise((res, rej) => {
  const t0 = Date.now();
  const it = setInterval(() => {
    if (cv.__ready || cv.Mat) { clearInterval(it); res(0); }
    if (Date.now() - t0 > 20000) { clearInterval(it); rej(new Error('cv init timeout')); }
  }, 50);
});
console.error('cv ready, fitEllipse =', typeof cv.fitEllipse);
__setCvForTest(cv);

const [imgPath, itemsPath] = process.argv.slice(2);
const base = sharp(imgPath).rotate();
const { data: rgba, info } = await base.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const img = { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: info.width, height: info.height };
const gw = Math.min(480, info.width);
const gray = await base.clone().resize({ width: gw }).greyscale().raw().toBuffer({ resolveWithObject: true });
const edge = { w: gray.info.width, h: gray.info.height, edge: sobelGray(new Uint8ClampedArray(gray.data.buffer, gray.data.byteOffset, gray.data.byteLength), gray.info.width, gray.info.height) };
const items = JSON.parse(readFileSync(itemsPath, 'utf8'));
console.error('decoded', info.width, 'x', info.height, 'edge', edge.w, 'x', edge.h, 'items', items.length);
const res = await __debugPointerRead(items, img, edge);
console.log('RESULT', JSON.stringify(res));
process.exit(0);
