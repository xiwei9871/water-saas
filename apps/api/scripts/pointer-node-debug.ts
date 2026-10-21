/* Node 复算指针读数：sharp 解码 + 预计算边缘图喂 __debugPointerRead。 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { sobelGray, __debugPointerRead } from '../../web/src/utils/meter-ocr';
import type { OcrResultItem } from '@paddleocr/paddleocr-js';

const main = async () => {
  const [, , imgPath, itemsPath] = process.argv;
  const base = sharp(imgPath).rotate();
  const { data: rgba, info } = await base.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: info.width, height: info.height } as ImageData;
  const gw = Math.min(480, info.width);
  const gray = await base.clone().resize({ width: gw }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const edge = { w: gray.info.width, h: gray.info.height, edge: sobelGray(new Uint8ClampedArray(gray.data.buffer, gray.data.byteOffset, gray.data.byteLength), gray.info.width, gray.info.height) };
  const items = JSON.parse(readFileSync(itemsPath, 'utf8')) as OcrResultItem[];
  console.error('decoded', info.width, 'x', info.height, 'edge', edge.w, 'x', edge.h, 'items', items.length);
  const res = await __debugPointerRead(items, img, edge);
  console.log('RESULT', JSON.stringify(res));
};
main().catch((e) => { console.error(e); process.exit(1); });
