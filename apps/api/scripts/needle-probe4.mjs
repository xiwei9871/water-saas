import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = (Math.max(0,Math.min(H-1,Math.round(y))) * W + Math.max(0,Math.min(W-1,Math.round(x)))) * 4; return [rgba[i], rgba[i+1], rgba[i+2]]; };
const dials = [
  ['x1000',218,264,27],['x100',169,222,28],['x10',156,157,28],['x1',186,102,28],
  ['x0.1',251,82,24],['x0.01',300,110,26],['x0.001',325,155,26],['x0.0001',342,219,28],
];
for (const [name, cx0, cy0, r] of dials) {
  const lumas=[];
  for (let y=Math.floor(cy0-r*0.72);y<=cy0+r*0.72;y++)for(let x=Math.floor(cx0-r*0.72);x<=cx0+r*0.72;x++){
    if(Math.hypot(x-cx0,y-cy0)>r*0.72)continue;const[p,q,b]=px(x,y);lumas.push(p*0.3+q*0.5+b*0.2);
  }
  lumas.sort((a,b)=>a-b);
  const thr=Math.min(95,lumas[Math.floor(lumas.length*0.2)]+8);
  let reds=0,tot=0;
  for (let y=Math.floor(cy0-r*0.7);y<=cy0+r*0.7;y++)for(let x=Math.floor(cx0-r*0.7);x<=cx0+r*0.7;x++){
    if(Math.hypot(x-cx0,y-cy0)>r*0.7)continue;tot++;const[p,q,b]=px(x,y);if(p-q>30&&p-b>15&&p>80)reds++;
  }
  const isRed=reds>tot*0.06;
  const isInk=(x,y)=>{const[p,q,b]=px(x,y);return isRed?(p-q>30&&p-b>15&&p>80):(p*0.3+q*0.5+b*0.2<thr);};
  // 毂心 = 0-0.35r 墨质心
  let hx=0,hy=0,hn=0;
  for (let y=Math.floor(cy0-r*0.35);y<=cy0+r*0.35;y++)for(let x=Math.floor(cx0-r*0.35);x<=cx0+r*0.35;x++){
    if(Math.hypot(x-cx0,y-cy0)>r*0.35)continue;
    if(isInk(x,y)){hx+=x;hy+=y;hn++;}
  }
  const cx=hn>5?hx/hn:cx0, cy=hn>5?hy/hn:cy0;
  // 针尖 = 0.38-0.72r 环带墨质心方向（相对毂心）
  let sx=0,sy=0,n=0;
  for (let y=Math.floor(cy-r*0.72);y<=cy+r*0.72;y++)for(let x=Math.floor(cx-r*0.72);x<=cx+r*0.72;x++){
    const dd=Math.hypot(x-cx,y-cy);
    if(dd<r*0.38||dd>r*0.72)continue;
    if(isInk(x,y)){sx+=x-cx;sy+=y-cy;n++;}
  }
  const ang=n>3?((Math.atan2(sx,-sy)*180/Math.PI)+360)%360:-1;
  console.log(name.padEnd(7),'red?',isRed,'hubOff',hn>5?Math.hypot(cx-cx0,cy-cy0).toFixed(1):'-','tipAng',ang.toFixed(0),'→v≈',(ang/36).toFixed(1));
}
process.exit(0);
