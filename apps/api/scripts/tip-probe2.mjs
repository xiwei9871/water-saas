import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W } = info;
const px = (x, y) => { const i = ((y * W + x) * 4); return [rgba[i], rgba[i+1], rgba[i+2]]; };
const E = { cx: 247, cy: 183, aw: 84, ah: 106, phi: 146 * Math.PI / 180 };
const dials = [
  ['x1000',218,264,27],['x100',169,222,28],['x10',156,157,28],['x1',186,102,28],
  ['x0.1',251,82,24],['x0.0001',342,219,28],
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
  const rB = Math.ceil(r*0.85), bw=rB*2+1, x0=cx-rB, y0=cy-rB;
  const mask=new Uint8Array(bw*bw), seen=new Uint8Array(bw*bw);
  for (let y=0;y<bw;y++)for(let x=0;x<bw;x++){ if(Math.hypot(x0+x-cx,y0+y-cy)>r*0.78)continue; if(isInk(x0+x,y0+y))mask[y*bw+x]=1; }
  let sx=-1,sy=-1,sD=1e9;
  for(let y=0;y<bw;y++)for(let x=0;x<bw;x++){ if(!mask[y*bw+x])continue; const dd=Math.hypot(x0+x-cx,y0+y-cy); if(dd<=r*0.3&&dd<sD){sD=dd;sx=x;sy=y;} }
  if(sx<0){console.log(name,'no seed');continue;}
  const comp=[];const st=[sy*bw+sx];seen[sy*bw+sx]=1;
  while(st.length){const i=st.pop(),yy=i/bw|0,xx=i%bw;comp.push([x0+xx,y0+yy]);
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){const nx=xx+ox,ny=yy+oy;if(nx<0||ny<0||nx>=bw||ny>=bw)continue;const ni=ny*bw+nx;if(mask[ni]&&!seen[ni]){seen[ni]=1;st.push(ni);}}}
  let hX=0,hY=0,hN=0;for(const[x,y]of comp)if(Math.hypot(x-cx,y-cy)<r*0.3){hX+=x;hY+=y;hN++;}
  const hx=hN>5?hX/hN:cx, hy=hN>5?hY/hN:cy;
  for (const useEll of [false, true]) {
    const prof=new Float32Array(180); let maxD=0;
    const c=Math.cos(E.phi), s=Math.sin(E.phi);
    for(const[x,y]of comp){const dx=x-hx,dy=y-hy;const dd=Math.hypot(dx,dy);if(dd>maxD)maxD=dd;
      let th;
      if(useEll){const u=(dx*c+dy*s)/(E.aw/2),vv=(-dx*s+dy*c)/(E.ah/2);th=((Math.atan2(u,-vv)*180/Math.PI)+360)%360;}
      else th=((Math.atan2(dx,-dy)*180/Math.PI)+360)%360;
      const bi=Math.floor(th/2)%180;if(dd>prof[bi])prof[bi]=dd;}
    const sm=new Float32Array(180);
    for(let i=0;i<180;i++)for(let o=-2;o<=2;o++)sm[i]+=prof[(i+o+180)%180];
    let pk=-1,pkP=0;
    for(let i=0;i<180;i++){let side=1e9;for(let o=-30;o<=-5;o++)side=Math.min(side,sm[(i+o+180)%180]);for(let o=5;o<=30;o++)side=Math.min(side,sm[(i+o+180)%180]);const pr=sm[i]-side;if(pr>pkP){pkP=pr;pk=i;}}
    console.log(`${name.padEnd(7)} ell=${useEll} PEAK=${pk*2}° prom=${pkP.toFixed(1)}`);
  }
}
process.exit(0);
