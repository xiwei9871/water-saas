import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => { const i = ((y * W + x) * 4); return [rgba[i], rgba[i+1], rgba[i+2]]; };
const [,, sx, sy, sr] = process.argv;
const cx = +sx, cy = +sy, r = +sr;
// 与 readNeedle 相同的阈值计算
const lumas = [];
for (let y = Math.floor(cy - r * 0.7); y <= cy + r * 0.7; y++) for (let x = Math.floor(cx - r * 0.7); x <= cx + r * 0.7; x++) {
  if (Math.hypot(x - cx, y - cy) > r * 0.7) continue;
  const [p, q, b] = px(x, y); lumas.push(Math.round(p * 0.3 + q * 0.5 + b * 0.2));
}
lumas.sort((a, b) => a - b);
const thr = Math.min(95, lumas[Math.floor(lumas.length * 0.2)] + 8);
console.log('thr', thr);
const rr = Math.ceil(r * 0.9);
for (let y = cy - rr; y <= cy + rr; y += 1) {
  let row = '';
  for (let x = cx - rr; x <= cx + rr; x += 1) {
    const d = Math.hypot(x - cx, y - cy);
    const [p, q, b] = px(x, y);
    const l = Math.round(p * 0.3 + q * 0.5 + b * 0.2);
    if (d > r * 0.9) row += ' ';
    else if (l < thr) row += '#';
    else if (l < thr + 25) row += '+';
    else row += '.';
  }
  console.log(row);
}
