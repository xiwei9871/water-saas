const cv = require('/Users/xiwei/water-saas/node_modules/.pnpm/@techstark+opencv-js@4.10.0-release.1/node_modules/@techstark/opencv-js/dist/opencv.js');

cv.onRuntimeInitialized = () => {
  // 已知椭圆：中心(250,170)，半轴 a=120(沿30°方向), b=80(垂直) → 点 = c + R(30°)·(120cost, 80sint)
  const H=250, K=170, A=120, B=80, PHI=30*Math.PI/180;
  const pts = [];
  for (let t=0; t<360; t+=10) {
    const r = t*Math.PI/180;
    const u = A*Math.cos(r), v = B*Math.sin(r);
    pts.push([Math.round(H + u*Math.cos(PHI) - v*Math.sin(PHI)), Math.round(K + u*Math.sin(PHI) + v*Math.cos(PHI))]);
  }
  const m = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat());
  const rr = cv.fitEllipse(m);
  console.log('fitted:', JSON.stringify({cx:+rr.center.x.toFixed(1), cy:+rr.center.y.toFixed(1), w:+rr.size.width.toFixed(1), h:+rr.size.height.toFixed(1), angle:+rr.angle.toFixed(1)}));
  // 试验：点 p 是否满足 |R(-φ')·(p-c)/(w/2,h/2)| ≈ 1 ?
  for (const phiDeg of [rr.angle, rr.angle-90, rr.angle+90]) {
    const phi = phiDeg*Math.PI/180;
    let err = 0;
    for (const [x,y] of pts.slice(0,8)) {
      const dx=x-rr.center.x, dy=y-rr.center.y;
      const u = (dx*Math.cos(phi)+dy*Math.sin(phi))/(rr.size.width/2);
      const v = (-dx*Math.sin(phi)+dy*Math.cos(phi))/(rr.size.height/2);
      err += Math.abs(Math.hypot(u,v)-1);
    }
    console.log('phi=',phiDeg.toFixed(1),'err=',(err/8).toFixed(4));
  }
  m.delete();
  process.exit(0);
};
