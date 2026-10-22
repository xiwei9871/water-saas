import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
const dials = [
  ['x1000', 218,264,27], ['x100',169,222,28], ['x10',156,157,28], ['x1',186,102,28],
  ['x0.1',251,82,24], ['x0.01',292,108,28], ['x0.001',325,165,16], ['x0.0001',342,219,28],
];
for (const [name, cx, cy, r] of dials) {
  const lumas = [];
  for (let y = Math.floor(cy-r*0.72); y <= cy+r*0.72; y++) for (let x = Math.floor(cx-r*0.72); x <= cx+r*0.72; x++) {
    if (Math.hypot(x-cx,y-cy) > r*0.72) continue;
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
  // dist^3 加权角度直方图：针尖=最远墨簇
  const hist = new Float64Array(180);
  for (let y = Math.floor(cy-r*0.75); y <= cy+r*0.75; y++) for (let x = Math.floor(cx-r*0.75); x <= cx+r*0.75; x++) {
    const dx=x-cx, dy=y-cy, dd=Math.hypot(dx,dy);
    if (dd < r*0.30 || dd > r*0.75) continue;
    const [pr,pg,pb]=px(x,y);
    const ink = isRed ? (pr-pg>30&&pr-pb>15&&pr>80) : (pr*0.3+pg*0.5+pb*0.2 < thr);
    if (ink) { const a=Math.atan2(dx,-dy)*180/Math.PI; const w=Math.pow(dd/r,3); hist[Math.floor(((a+360)%360)/2)] += w; }
  }
  // 平滑找峰
  const sm = new Float64Array(180); let bi=0;
  for (let i=0;i<180;i++){ for(let o=-3;o<=3;o++) sm[i]+=hist[(i+o+180)%180]; if(sm[i]>sm[bi])bi=i; }
  console.log(name, 'red?', isRed, 'tipAng', (bi*2).toFixed(0), '→ v≈', (bi*2/36).toFixed(1), 'top3:', [...Array(3)].map((_,k)=>{let j=[...sm.keys()].sort((a,b)=>sm[b]-sm[a])[k];return j*2}).join(','));
}
process.exit(0);
