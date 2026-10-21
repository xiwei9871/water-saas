const cv = require('/Users/xiwei/water-saas/node_modules/.pnpm/@techstark+opencv-js@4.10.0-release.1/node_modules/@techstark/opencv-js/dist/opencv.js');

cv.onRuntimeInitialized = () => {
  // 清洗后假设的盘心点（8 真盘 + 噪声）
  const sets = {
    'all14': [[169,222],[342,218],[218,264],[243,148],[136,173],[251,82],[156,157],[338,242],[186,102],[152,185],[325,165],[214,78],[358,181],[238,279]],
    'est8': [[186,102],[251,82],[335,80],[345,155],[335,228],[225,262],[155,225],[145,150]],
    'est8-miss01': [[186,102],[251,82],[345,155],[335,228],[225,262],[155,225],[145,150]], // 缺 x0.01
  };
  for (const [name, pts] of Object.entries(sets)) {
    const m = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat());
    try {
      const rr = cv.fitEllipse(m);
      console.log(name, '→', JSON.stringify({cx:+rr.center.x.toFixed(1), cy:+rr.center.y.toFixed(1), w:+rr.size.width.toFixed(1), h:+rr.size.height.toFixed(1), ang:+rr.angle.toFixed(1)}));
    } catch(e) { console.log(name, 'ERR', e.message); }
    m.delete();
  }
  process.exit(0);
};
