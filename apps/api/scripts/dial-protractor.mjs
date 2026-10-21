import sharp from 'sharp';
const src = sharp('/tmp/meter-bad.png').rotate();
const { data: rgba, info } = await src.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
// 每盘画 0-9 刻度线（0=上，CW）+ 中心点，输出大图
const out = Buffer.from(rgba); // copy
const put=(x,y,c)=>{ x=Math.round(x);y=Math.round(y); if(x<0||y<0||x>=W||y>=H)return; const i=(y*W+x)*4; out[i]=c[0];out[i+1]=c[1];out[i+2]=c[2];out[i+3]=255; };
const dials = [
  ['x1',186,102,28],['x10',156,157,28],['x100',169,222,28],['x1000',218,264,27],
  ['x0.1',251,82,24],['x0.01',300,110,26],['x0.001',325,155,26],['x0.0001',342,219,28],
];
for (const [n,cx,cy,r] of dials) {
  for (let d=0; d<10; d++) {
    const a=d*36*Math.PI/180, dx=Math.sin(a), dy=-Math.cos(a);
    for (let rr=r*0.55; rr<r*0.95; rr++) put(cx+dx*rr, cy+dy*rr, d===0?[255,0,255]:[0,150,255]);
  }
  // 中心十字
  for (let k=-3;k<=3;k++){put(cx+k,cy,[0,255,0]);put(cx,cy+k,[0,255,0]);}
}
await sharp(out, { raw: { width: W, height: H, channels: 4 } }).resize(W*2).png().toFile('/tmp/protractor.png');
console.log('done');
process.exit(0);
