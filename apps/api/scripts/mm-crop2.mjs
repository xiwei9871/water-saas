import sharp from 'sharp';
const dials = [
  ['x1', 186, 102], ['x01', 251, 82], ['x10', 156, 157],
  ['x100', 169, 222], ['x1000', 218, 264],
];
for (const [name, cx, cy] of dials) {
  const size = 80;
  await sharp('/tmp/meter-bad.png')
    .extract({ left: cx - size/2, top: cy - size/2, width: size, height: size })
    .resize(600, 600, { kernel: 'lanczos3' })
    .modulate({ brightness: 1.15, saturation: 1.3 })
    .sharpen({ sigma: 1.5 })
    .toFile(`/tmp/mm2-${name}.png`);
}
console.log('done');
