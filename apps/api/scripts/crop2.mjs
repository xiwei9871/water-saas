import sharp from 'sharp';
// 更大视野裁各盘（带标签区）
for (const [n,x,y] of [['x1',186,102],['x01',251,82],['x10',156,157],['x100',169,222],['x1000',218,264],['x001',325,155],['x01miss',300,112]]) {
  await sharp('/tmp/meter-bad.png').extract({ left: Math.max(0,x-55), top: Math.max(0,y-50), width: 110, height: 110 }).resize(330).png().toFile(`/tmp/big-${n}.png`);
}
console.log('done');
