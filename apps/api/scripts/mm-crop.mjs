import sharp from 'sharp';
const img = sharp('/tmp/meter-bad.png');
// 各盘中心（来自检测输出）: ×1(186,102) ×0.1(251,82) ×10(156,157) ×100(169,222) ×1000(218,264)
const dials = [
  ['x1', 186, 102], ['x01', 251, 82], ['x10', 156, 157],
  ['x100', 169, 222], ['x1000', 218, 264],
];
for (const [name, cx, cy] of dials) {
  const size = 90;
  await img.clone()
    .extract({ left: cx - size/2, top: cy - size/2, width: size, height: size })
    .resize(360, 360, { kernel: 'lanczos3' })
    .toFile(`/tmp/mm-${name}.png`);
  console.log('saved /tmp/mm-' + name + '.png');
}
// 全图放大版
await img.clone().resize(1482, null, { kernel: 'lanczos3' }).toFile('/tmp/mm-full.png');
console.log('saved /tmp/mm-full.png');
