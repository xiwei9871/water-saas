import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
const [cx, cy, r] = [186, 102, 28];
const thr = 50;
const isInk = (x,y) => { const [p,q,b] = px(x,y); return p*0.3+q*0.5+b*0.2 < thr; };
for (const deg of [36,54,72,90,108,126]) {
  const rad = deg*Math.PI/180, dx=Math.sin(rad), dy=-Math.cos(rad);
  let line = '';
  for (let rr = 4; rr < 26; rr += 1) {
    let hit = 0;
    for (const o of [-1.5,0,1.5]) if (isInk(cx+dx*rr-dy*o, cy+dy*rr+dx*o)) hit=1;
    line += hit ? '#' : '.';
  }
  console.log(`${String(deg).padStart(3)}° ${line}`);
}
console.log('     r=4'+' '.repeat(6)+'r=10'+' '.repeat(6)+'r=16'+' '.repeat(6)+'r=22');
process.exit(0);
