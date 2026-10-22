import { createRequire } from 'node:module';
import sharp from 'sharp';
const cv = createRequire(import.meta.url)('/Users/xiwei/water-saas/node_modules/.pnpm/@techstark+opencv-js@4.10.0-release.1/node_modules/@techstark/opencv-js/dist/opencv.js');
await new Promise((res, rej) => { if (cv.Mat) return res(); const t=setInterval(()=>{ if(cv.Mat){clearInterval(t);res()} },50); setTimeout(()=>rej(new Error('timeout')),20000); });

const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x,y) => { const i=(Math.max(0,Math.min(H-1,Math.round(y)))*W+Math.max(0,Math.min(W-1,Math.round(x))))*4; return [rgba[i],rgba[i+1],rgba[i+2]]; };

// 对表盘 rim 采样边缘点：沿径向找梯度最大点
const dials = [ ['x1',186,102,28], ['x10',156,157,28], ['x100',169,222,28], ['x1000',218,264,27], ['x0.1',251,82,24] ];
for (const [name, cx, cy, r] of dials) {
  const pts = [];
  for (let a = 0; a < 360; a += 4) {
    const rad = a*Math.PI/180, dx=Math.sin(rad), dy=-Math.cos(rad);
    let bestG=0, bestR=-1;
    for (let rr = r*0.8; rr < r*1.25; rr += 1) {
      const [p1] = [px(cx+dx*(rr-2), cy+dy*(rr-2))]; const l1 = p1[0]*0.3+p1[1]*0.5+p1[2]*0.2;
      const [p2] = [px(cx+dx*(rr+2), cy+dy*(rr+2))]; const l2 = p2[0]*0.3+p2[1]*0.5+p2[2]*0.2;
      const g = Math.abs(l2-l1);
      if (g > bestG) { bestG=g; bestR=rr; }
    }
    if (bestR>0 && bestG>25) pts.push([cx+dx*bestR, cy+dy*bestR]);
  }
  console.log(name, 'rim pts', pts.length);
  if (pts.length >= 5) {
    const m = cv.matFromArray(pts.length,1,cv.CV_32FC2,pts.flat());
    try {
      const rr = cv.fitEllipse(m);
      console.log('   ell', JSON.stringify({cx:+rr.center.x.toFixed(1),cy:+rr.center.y.toFixed(1),w:+rr.size.width.toFixed(1),h:+rr.size.height.toFixed(1),ang:+rr.angle.toFixed(1)}));
    } catch(e){ console.log('   ERR', e.message); }
    m.delete();
  }
}
process.exit(0);
