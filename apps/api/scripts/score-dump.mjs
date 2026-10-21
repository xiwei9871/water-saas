import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
for (const [name,cx,cy,r] of [['x1',186,102,28],['x0.1',251,82,24]]) {
  const lumas=[];
  for (let y=Math.floor(cy-r*0.7);y<=cy+r*0.7;y++)for(let x=Math.floor(cx-r*0.7);x<=cx+r*0.7;x++){
    if(Math.hypot(x-cx,y-cy)>r*0.7)continue;const[p,q,b]=px(x,y);lumas.push(p*0.3+q*0.5+b*0.2);
  }
  lumas.sort((a,b)=>a-b);
  const thr=Math.min(95,lumas[Math.floor(lumas.length*0.2)]+8);
  let reds=0,tot=0;
  for (let y=Math.floor(cy-r*0.7);y<=cy+r*0.7;y++)for(let x=Math.floor(cx-r*0.7);x<=cx+r*0.7;x++){
    if(Math.hypot(x-cx,y-cy)>r*0.7)continue;tot++;const[p,q,b]=px(x,y);if(p-q>30&&p-b>15&&p>80)reds++;
  }
  const isRed = reds>tot*0.06;
  const isInk=(x,y)=>{const[p,q,b]=px(x,y);return isRed?(p-q>30&&p-b>15&&p>80):(p*0.3+q*0.5+b*0.2<thr);};
  const rA=r*0.25,rB=r*0.8,rStep=1.6,nSmp=Math.floor((rB-rA)/rStep);
  const rows=[];
  for(let deg=0;deg<360;deg+=2){
    const rad=deg*Math.PI/180,dx=Math.sin(rad),dy=-Math.cos(rad);
    let run=0,best=0;
    for(let k=0;k<nSmp;k++){
      const rr=rA+k*rStep;let hit=0;
      for(const o of[-1,0,1]){const ox=-dy*o,oy=dx*o;if(isInk(cx+dx*rr+ox,cy+dy*rr+oy))hit=1;}
      if(hit){run++;if(run>best)best=run;}else run=0;
    }
    rows.push([deg,best]);
  }
  rows.sort((a,b)=>b[1]-a[1]);
  console.log(name,'red?',isRed,'thr',thr,'top:',rows.slice(0,8).map(r=>`${r[0]}°:${r[1]}`).join(' '));
}
process.exit(0);
