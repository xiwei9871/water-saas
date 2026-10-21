import sharp from 'sharp';
const { data: rgba, info } = await sharp('/tmp/meter-bad.png').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W } = info;
const px = (x, y) => { const i = ((y * W + x) * 4); return [rgba[i], rgba[i+1], rgba[i+2]]; };
const [,, sx, sy, sr] = process.argv;
const cx = +sx, cy = +sy, r = +sr;
const lumas = [];
for (let y = Math.floor(cy - r * 0.7); y <= cy + r * 0.7; y++) for (let x = Math.floor(cx - r * 0.7); x <= cx + r * 0.7; x++) {
  if (Math.hypot(x - cx, y - cy) > r * 0.7) continue;
  const [p, q, b] = px(x, y); lumas.push(Math.round(p * 0.3 + q * 0.5 + b * 0.2));
}
lumas.sort((a, b) => a - b);
const thr = Math.min(95, lumas[Math.floor(lumas.length * 0.2)] + 8);
const isInk = (x, y) => { const [p, q, b] = px(x, y); return Math.round(p * 0.3 + q * 0.5 + b * 0.2) < thr; };
const isInkL = (x, y) => { const [p, q, b] = px(x, y); return Math.round(p * 0.3 + q * 0.5 + b * 0.2) < thr + 25; };
const rB = Math.ceil(r * 0.9), bw = rB * 2 + 1, x0 = cx - rB, y0 = cy - rB;
const mask = new Uint8Array(bw * bw), seen = new Uint8Array(bw * bw);
for (let y = 0; y < bw; y++) for (let x = 0; x < bw; x++) {
  const d = Math.hypot(x0 + x - cx, y0 + y - cy);
  if (d > r * 0.72) continue;
  if (isInkL(x0 + x, y0 + y)) mask[y * bw + x] = 1;
}
// seed = strict ink nearest center within 0.3r
let sx2 = -1, sy2 = -1, sD = 1e9;
for (let y = 0; y < bw; y++) for (let x = 0; x < bw; x++) {
  if (!mask[y * bw + x] || !isInk(x0 + x, y0 + y)) continue;
  const dd = Math.hypot(x0 + x - cx, y0 + y - cy);
  if (dd <= r * 0.3 && dd < sD) { sD = dd; sx2 = x; sy2 = y; }
}
const comp = [];
const st = [sy2 * bw + sx2]; seen[sy2 * bw + sx2] = 1;
while (st.length) {
  const i = st.pop(), yy = i / bw | 0, xx = i % bw;
  comp.push([x0 + xx, y0 + yy]);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const nx = xx + ox, ny = yy + oy;
    if (nx < 0 || ny < 0 || nx >= bw || ny >= bw) continue;
    const ni = ny * bw + nx;
    if (mask[ni] && !seen[ni]) { seen[ni] = 1; st.push(ni); }
  }
}
// 毂心
let hX = 0, hY = 0, hN = 0;
for (const [x, y] of comp) if (Math.hypot(x - cx, y - cy) < r * 0.3) { hX += x; hY += y; hN++; }
const hx = hN > 5 ? hX / hN : cx, hy = hN > 5 ? hY / hN : cy;
const dists = comp.map(([x, y]) => Math.hypot(x - hx, y - hy));
const mx = Math.max(...dists);
const compSet = new Set(comp.map(([x, y]) => x * 1000 + y));
const farSet = new Set();
comp.forEach(([x, y], i) => { if (dists[i] >= mx * 0.85) farSet.add(x * 1000 + y); });
let fx = 0, fy = 0, fn = 0;
farSet.forEach(k => { const x = k / 1000 | 0, y = k % 1000; fx += x - hx; fy += y - hy; fn++; });
const ang = ((Math.atan2(fx, -fy) * 180 / Math.PI) + 360) % 360;
console.log(`hub(${hx.toFixed(1)},${hy.toFixed(1)}) n=${comp.length} max=${mx.toFixed(1)} far=${fn} ang=${ang.toFixed(0)}`);
for (let y = y0; y <= y0 + bw; y++) {
  let row = '';
  for (let x = x0; x <= x0 + bw; x++) {
    const k = x * 1000 + y;
    if (farSet.has(k)) row += '@';
    else if (compSet.has(k)) row += '#';
    else if (Math.abs(x - hx) < 1 && Math.abs(y - hy) < 1) row += 'o';
    else row += '.';
  }
  console.log(row);
}
