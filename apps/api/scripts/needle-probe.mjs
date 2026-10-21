import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
// dial centers + r（ring-fit 椭圆空间位置，label 已确认倍率）
const dials = [
  ['x1000', 218,264,27], ['x100',169,222,28], ['x10',156,157,28], ['x1',186,102,28],
  ['x0.1',251,82,24], ['x0.01',292,108,28], ['x0.001',325,165,14], ['x0.0001',342,219,28],
];
for (const [name, cx, cy, r] of dials) {
  const lumas = [];
  for (let y = Math.floor(cy-r*0.7); y <= cy+r*0.7; y++) for (let x = Math.floor(cx-r*0.7); x <= cx+r*0.7; x++) {
    if (Math.hypot(x-cx,y-cy) > r*0.7) continue;
    const [pr,pg,pb] = px(x,y); lumas.push(pr*0.3+pg*0.5+pb*0.2);
  }
  lumas.sort((a,b)=>a-b);
  const thr = Math.min(95, lumas[Math.floor(lumas.length*0.2)]+8);
  let reds=0, tot=0;
  for (let y = Math.floor(cy-r*0.7); y <= cy+r*0.7; y++) for (let x = Math.floor(cx-r*0.7); x <= cx+r*0.7; x++) {
    if (Math.hypot(x-cx,y-cy) > r*0.7) continue;
    tot++; const [pr,pg,pb]=px(x,y); if (pr-pg>30&&pr-pb>15&&pr>80) reds++;
  }
  const isRed = reds > tot*0.06;
  // 环带 0.30-0.78r 内 ink 像素质心方向
  let sx=0, sy=0, n=0;
  for (let y = Math.floor(cy-r); y <= cy+r; y++) for (let x = Math.floor(cx-r); x <= cx+r; x++) {
    const dd = Math.hypot(x-cx,y-cy);
    if (dd < r*0.30 || dd > r*0.78) continue;
    const [pr,pg,pb]=px(x,y);
    const ink = isRed ? (pr-pg>30&&pr-pb>15&&pr>80) : (pr*0.3+pg*0.5+pb*0.2 < thr);
    if (ink) { sx += x-cx; sy += y-cy; n++; }
  }
  const ang = n>0 ? (Math.atan2(sx,-sy)*180/Math.PI+360)%360 : -1;
  console.log(name, 'red?', isRed, 'inkN', n, 'centroidAng', ang.toFixed(0), '→ digit≈', (ang/36).toFixed(1));
}
process.exit(0);
