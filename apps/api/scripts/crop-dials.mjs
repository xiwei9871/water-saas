import sharp from 'sharp';
// ring-fit 椭圆 E: cx=247,cy=183,aw=84,ah=106,phi=146° —— 归一化坐标系观察各盘位
// 检出盘（图像坐标）:
const dials = [
  ['th60', 218,264], ['th96',169,222], ['th133',156,157], ['th176',186,102],
  ['th223',251,82], ['th287',325,165], ['th318',342,219], ['th9-synth',295,277],
];
for (const [name, x, y] of dials) {
  await sharp('/tmp/meter-bad.png').extract({ left: Math.max(0,x-42), top: Math.max(0,y-42), width: 84, height: 84 }).resize(252).png().toFile(`/tmp/ring-${name}.png`);
}
// 全景降采样
await sharp('/tmp/meter-bad.png').resize(988).png().toFile('/tmp/ring-full.png');
console.log('done');
