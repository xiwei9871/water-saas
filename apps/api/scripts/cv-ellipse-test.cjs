const cv = require('/Users/xiwei/water-saas/node_modules/.pnpm/@techstark+opencv-js@4.10.0-release.1/node_modules/@techstark/opencv-js/dist/opencv.js');
const sharp = require('sharp');

cv.onRuntimeInitialized = async () => {
  const imgPath = process.argv[2];
  const { data, info } = await sharp(imgPath).rotate().resize({ width: 480 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const mat = cv.matFromArray(H, W, cv.CV_8UC1, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const edges = new cv.Mat();
  cv.Canny(mat, edges, 60, 160);
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  console.log('contours:', contours.size());
  const out = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const n = c.rows;
    if (n < 80) { c.delete(); continue; }
    try {
      const rr = cv.fitEllipse(c);
      const a = rr.size.width / 2, b = rr.size.height / 2;
      out.push({ n, cx: +rr.center.x.toFixed(1), cy: +rr.center.y.toFixed(1), a: +(Math.max(a, b)).toFixed(1), b: +(Math.min(a, b)).toFixed(1), ang: +rr.angle.toFixed(1) });
    } catch (e) {}
    c.delete();
  }
  out.sort((x, y) => y.a - x.a);
  console.log(JSON.stringify(out.slice(0, 12)));
  process.exit(0);
};
