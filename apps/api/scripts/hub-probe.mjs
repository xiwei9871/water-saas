import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W } = info;
const px = (x, y) => { const i = ((y * W + x) * 4); return [rgba[i], rgba[i+1], rgba[i+2]]; };
const dials = [
  ['x1000',218,264,27],['x100',169,222,28],['x10',156,157,28],['x10-bad',161,152,28],['x1',186,102,28],
  ['x0.1',251,82,24],['x0.1-bad',255,78,24],
];
for (const [name, cx, cy, r] of dials) {
  const lumas = [];
  for (let y = Math.floor(cy - r*0.7); y <= cy + r*0.7; y++) for (let x = Math.floor(cx - r*0.7); x <= cx + r*0.7; x++) {
    if (Math.hypot(x-cx,y-cy) > r*0.7) continue;
    const [p,q,b] = px(x,y); lumas.push(p*0.3+q*0.5+b*0.2);
  }
  lumas.sort((a,b)=>a-b);
  const thr = Math.min(95, lumas[Math.floor(lumas.length*0.2)]+8);
  const isInk = (x,y) => { const [p,q,b]=px(x,y); return p*0.3+q*0.5+b*0.2 < thr; };
  const rB = Math.ceil(r*0.9), bw=rB*2+1, x0=cx-rB, y0=cy-rB;
  const mask=new Uint8Array(bw*bw), seen=new Uint8Array(bw*bw);
  for (let y=0;y<bw;y++)for(let x=0;x<bw;x++){ if(Math.hypot(x0+x-cx,y0+y-cy)>r*0.78)continue; if(isInk(x0+x,y0+y))mask[y*bw+x]=1; }
  let sx=-1,sy=-1,sD=1e9;
  for(let y=0;y<bw;y++)for(let x=0;x<bw;x++){ if(!mask[y*bw+x])continue; const dd=Math.hypot(x0+x-cx,y0+y-cy); if(dd<=r*0.3&&dd<sD){sD=dd;sx=x;sy=y;} }
  if(sx<0){console.log(name,'no seed');continue;}
  const compSet=new Set();const st=[sy*bw+sx];seen[sy*bw+sx]=1;
  while(st.length){const i=st.pop(),yy=i/bw|0,xx=i%bw;compSet.add(yy*bw+xx);
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const nx=xx+ox,ny=yy+oy;if(nx<0||ny<0||nx>=bw||ny>=bw)continue;const ni=ny*bw+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;st.push(ni);}}}
  // 腐蚀求毂心：两轮8邻域腐蚀后剩余像素质心
  let cur = new Set(compSet);
  for (let pass = 0; pass < 2; pass++) {
    const nxt = new Set();
    for (const i of cur) {
      const yy = i / bw | 0, xx = i % bw;
      let ok = true;
      for (let oy = -1; oy <= 1 && ok; oy++) for (let ox = -1; ox <= 1 && ok; ox++) if (!cur.has((yy + oy) * bw + xx + ox)) ok = false;
      if (ok) nxt.add(i);
    }
    if (nxt.size < 4) break;
    cur = nxt;
  }
  let hX = 0, hY = 0;
  for (const i of cur) { hX += i % bw; hY += i / bw | 0; }
  const hx = x0 + hX / cur.size, hy = y0 + hY / cur.size;
  // prominence peak from hub
  const prof = new Float32Array(180);
  for (const i of compSet) { const xx = i % bw, yy = i / bw | 0; const dd = Math.hypot(xx - (hx - x0), yy - (hy - y0)); const th = ((Math.atan2(xx - (hx - x0), -(yy - (hy - y0))) * 180 / Math.PI) + 360) % 360; const bi = Math.floor(th / 2) % 180; if (dd > prof[bi]) prof[bi] = dd; }
  const sm = new Float32Array(180);
  for (let i = 0; i < 180; i++) for (let o = -2; o <= 2; o++) sm[i] += prof[(i + o + 180) % 180];
  let pk = -1, pkP = 0;
  for (let i = 0; i < 180; i++) { let side = 1e9; for (let o = -30; o <= -5; o++) side = Math.min(side, sm[(i + o + 180) % 180]); for (let o = 5; o <= 30; o++) side = Math.min(side, sm[(i + o + 180) % 180]); const pr = sm[i] - side; if (pr > pkP) { pkP = pr; pk = i; } }
  console.log(`${name.padEnd(8)} hub=(${hx.toFixed(1)},${hy.toFixed(1)}) coreN=${cur.size} PEAK=${pk * 2}° prom=${pkP.toFixed(1)}`);
}
process.exit(0);
