/* Standalone tuning harness: tsx scripts/meter-ocr-try.ts <photo...> */
import { readFileSync } from 'node:fs';
import { MeterOcrService } from '../src/modules/metering/ocr/meter-ocr.service.js';

const main = async () => {
  const svc = new MeterOcrService();
  for (const file of process.argv.slice(2)) {
    const b64 = readFileSync(file).toString('base64');
    const t0 = Date.now();
    const r = await svc.recognize(b64);
    console.log(`\n=== ${file} (${Date.now() - t0}ms)`);
    console.log(JSON.stringify(r, null, 1).slice(0, 2400));
  }
  await svc.onModuleDestroy();
  process.exit(0);
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
