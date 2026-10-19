/* Debug: dump detected bands + per-variant OCR text for a photo. */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';
import { findDigitBands, redSplitX } from '../src/modules/metering/ocr/image-utils.js';

const main = async () => {
  const buf = readFileSync(process.argv[2]);
  const resized = sharp(buf).rotate().resize({ width: 1500, withoutEnlargement: true });
  const png = await resized.clone().png().toBuffer();
  const { data, info } = await resized.clone().greyscale().normalise().raw().toBuffer({ resolveWithObject: true });
  const { data: rgb, info: rgbInfo } = await resized.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const g = { data, width: info.width, height: info.height };
  const c = { data: rgb, width: rgbInfo.width, height: rgbInfo.height };
  console.log('size', g.width, 'x', g.height);

  const bands = findDigitBands(g, 6);
  console.log('bands:', JSON.stringify(bands));

  const w = await createWorker('eng', undefined, { langPath: './tessdata', cacheMethod: 'none', gzip: false });
  for (const [i, band] of bands.entries()) {
    const redX = redSplitX(c, band);
    console.log(`\n--- band ${i} top=${band.top} h=${band.height} redX=${redX}`);
    const base = sharp(png).extract({ left: 0, top: band.top, width: g.width, height: band.height }).resize({ height: 140 }).greyscale().normalise();
    const variants: Array<[string, sharp.Sharp]> = [
      ['norm', base.clone()],
      ['thr150', base.clone().threshold(150)],
      ['thr100', base.clone().threshold(100)],
      ['thr190', base.clone().threshold(190)],
      ['neg', base.clone().negate().normalise()],
    ];
    for (const [name, v] of variants) {
      const out = await v.png().toBuffer();
      await sharp(out).png().toFile(`/tmp/band-${i}-${name}.png`);
      await w.setParameters({ tessedit_char_whitelist: '0123456789xX.m³', tessedit_pageseg_mode: PSM.SINGLE_LINE });
      const r1 = await w.recognize(out);
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      const r2 = await w.recognize(out);
      console.log(`  ${name}: line=${JSON.stringify(r1.data.text.trim())} (${Math.round(r1.data.confidence)}) block=${JSON.stringify(r2.data.text.trim().slice(0, 60))}`);
    }
  }
  await w.terminate();
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
