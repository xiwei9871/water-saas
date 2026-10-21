import sharp from 'sharp';
// pointer-all.jpg 整图放大 + 上半部（整数盘区）
await sharp('testdata/meter-photos/pointer-all.jpg')
  .resize(1200, null, { kernel: 'lanczos3' })
  .sharpen({ sigma: 1.2 })
  .toFile('/tmp/mm3-pall.png');
console.log('done');
