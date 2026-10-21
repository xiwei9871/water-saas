import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
const dial = ['x1',186,102,28];  // 看 ×1
const [name, cx, cy, r] = dial;
const lumas = [];
for (let y = Math.floor(cy-r); y <= cy+r; y++) for (let x = Math.floor(cx-r); x <= cx+r; x++) {
  if (Math.hypot(x-cx,y-cy) > r) continue;
  const [pr,pg,pb] = px(x,y); lumas.push(pr*0.3+pg*0.5+pb*0.2);
}
lumas.sort((a,b)=>a-b);
const thr = Math.min(95, lumas[Math.floor(lumas.length*0.2)]+8);
console.log('thr', thr);
// 生成掩码图：ink=红、非ink=灰度原图
const S = 4, size = Math.ceil(r*2.2)*S;
const out = Buffer.alloc(size*size*3);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const ix = cx - r*1.1 + (x/S), iy = cy - r*1.1 + (y/S);
  const [pr,pg,pb] = px(ix,iy);
  const luma = pr*0.3+pg*0.5+pb*0.2;
  const dd = Math.hypot(ix-cx, iy-cy);
  const ink = luma < thr;
  const i = (y*size+x)*3;
  if (dd > r) { out[i]=out[i+1]=out[i+2]=200; continue; }
  if (ink) { out[i]=255; out[i+1]=0; out[i+2]=0; }
  else { out[i]=out[i+1]=out[i+2]=Math.min(255,luma+60); }
}
// 画两条射线：54°(绿) 96°(蓝)，0.25-0.8r
for (const [deg,col] of [[54,[0,200,0]],[96,[0,0,255]],[78,[255,200,0]]]) {
  const rad = deg*Math.PI/180, dx=Math.sin(rad), dy=-Math.cos(rad);
  for (let rr=r*0.25; rr<r*0.8; rr+=0.5) {
    const sx = Math.round((cx+dx*rr - (cx-r*1.1))*S), sy = Math.round((cy+dy*rr - (cy-r*1.1))*S);
    if (sx>=0&&sx<size&&sy>=0&&sy<size) { const i=(sy*size+sx)*3; out[i]=col[0];out[i+1]=col[1];out[i+2]=col[2]; }
  }
}
await sharp(out, { raw: { width: size, height: size, channels: 3 } }).png().toFile('/tmp/mask-x1.png');
console.log('saved', size);
process.exit(0);
