/**
 * Meter-dial image analysis — pure pixel math, no external deps.
 *
 * Two display families on Chinese mechanical meters:
 *  - roller windows (字轮): a horizontal strip of digit wheels, often with a
 *    red rightmost wheel marking the decimal boundary (photos 2 & 3);
 *  - pointer dials (指针): N small round dials each ×10^k, digits 0-9 laid
 *    out clockwise from the top (photo 1).
 *
 * Everything here works on raw grayscale / RGB buffers so the functions stay
 * unit-testable without sharp or tesseract.
 */

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RgbImage {
  data: Uint8Array; // 3 channels, row-major
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* ---------- roller-window band detection ---------- */

const at = (g: GrayImage, x: number, y: number): number => g.data[y * g.width + x];

/** Horizontal gradient magnitude per row, smoothed. */
const rowScores = (g: GrayImage): Float64Array => {
  const s = new Float64Array(g.height);
  for (let y = 1; y < g.height - 1; y++) {
    let acc = 0;
    for (let x = 1; x < g.width - 1; x++) {
      acc += Math.abs(at(g, x + 1, y) - at(g, x - 1, y));
    }
    s[y] = acc / (g.width - 2);
  }
  return s;
};

/**
 * Candidate horizontal strips that could be a digit-roller window.
 * Score-driven: digits produce strong vertical-edge energy across a tall
 * band. Returns ≤ `limit` non-overlapping boxes (padded), best first.
 */
export const findDigitBands = (g: GrayImage, limit = 3): Box[] => {
  const scores = rowScores(g);
  let mean = 0;
  for (const v of scores) mean += v;
  mean /= scores.length;
  let sd = 0;
  for (const v of scores) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / scores.length);
  const thresh = mean + 0.55 * sd;

  const minH = Math.round(g.height * 0.025);
  const maxH = Math.round(g.height * 0.22);
  const boxes: Array<Box & { score: number }> = [];
  let runTop = -1;
  for (let y = 0; y <= g.height; y++) {
    const hot = y < g.height && scores[y] > thresh;
    if (hot && runTop < 0) runTop = y;
    if (!hot && runTop >= 0) {
      const h = y - runTop;
      if (h >= minH && h <= maxH) {
        let peak = 0;
        for (let i = runTop; i < y; i++) peak = Math.max(peak, scores[i]);
        boxes.push({ top: runTop, height: h, left: 0, width: g.width, score: peak });
      }
      runTop = -1;
    }
  }
  // Pad vertically, clamp, sort by peak score, drop heavy overlaps.
  boxes.sort((a, b) => b.score - a.score);
  const picked: Box[] = [];
  for (const b of boxes) {
    const pad = Math.round(b.height * 0.35);
    const top = Math.max(0, b.top - pad);
    const height = Math.min(g.height - top, b.height + 2 * pad);
    const box = { left: 0, top, width: g.width, height };
    const overlaps = picked.some((p) => {
      const a0 = p.top;
      const a1 = p.top + p.height;
      const b0 = box.top;
      const b1 = box.top + box.height;
      return Math.min(a1, b1) - Math.max(a0, b0) > Math.min(p.height, box.height) * 0.5;
    });
    if (!overlaps) picked.push(box);
    if (picked.length >= limit) break;
  }
  return picked;
};

/**
 * Inside a candidate band, locate the digit-window x-extent by column ink
 * density (roller wheels are a dense, contiguous dark cluster; labels and
 * frame edges are thinner). Returns image-space x0/x1 or null.
 */
export const digitWindowX = (g: GrayImage, band: Box): { x0: number; x1: number } | null => {
  const y0 = Math.max(0, band.top);
  const y1 = Math.min(g.height, band.top + band.height);
  const h = y1 - y0;
  if (h < 4) return null;
  // local ink threshold: bands containing digits sit well below the band mean
  let acc = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < g.width; x++) acc += at(g, x, y);
  }
  const inkT = Math.min(130, (acc / (h * g.width)) * 0.62);

  const col = new Float64Array(g.width);
  for (let x = 0; x < g.width; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (at(g, x, y) < inkT) n++;
    col[x] = n / h;
  }
  // Wide-kernel smoothing merges the per-wheel gaps, then expand around the
  // peak while the smoothed profile stays ≥35% of it — the digit window is
  // the dominant ink structure inside a true roller band.
  const kRad = Math.max(10, Math.round(g.width * 0.045));
  const sm = new Float64Array(g.width);
  for (let x = 0; x < g.width; x++) {
    let s = 0;
    let n = 0;
    for (let k = -kRad; k <= kRad; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < g.width) {
        s += col[xx];
        n++;
      }
    }
    sm[x] = s / n;
  }
  // Search the central 40% — the roller window sits near image center;
  // label text ('H·B', 'm³') and dark photo edges live outside it.
  const lo = Math.round(g.width * 0.30);
  const hi = Math.round(g.width * 0.70);
  let peak = 0;
  let px = -1;
  for (let x = lo; x < hi; x++) {
    if (sm[x] > peak) {
      peak = sm[x];
      px = x;
    }
  }
  if (px < 0 || peak < 0.08) return null; // no ink structure at all
  const floor = peak * 0.35;
  let x0 = px;
  let x1 = px;
  while (x0 > lo && sm[x0 - 1] >= floor && px - x0 < g.width * 0.45) x0--;
  while (x1 < hi - 1 && sm[x1 + 1] >= floor && x1 - px < g.width * 0.45) x1++;
  const pad = Math.round((x1 - x0) * 0.12) + 4;
  return { x0: Math.max(0, x0 - pad), x1: Math.min(g.width, x1 + pad) };
};

/* ---------- red decimal-wheel boundary ---------- */

const isRed = (rgb: RgbImage, x: number, y: number): boolean => {
  const i = (y * rgb.width + x) * 3;
  const r = rgb.data[i];
  const g = rgb.data[i + 1];
  const b = rgb.data[i + 2];
  // Meter 'red' is often a dark maroon under field lighting — r must still
  // clearly lead the other channels.
  return r > 80 && r > g + 35 && r > b + 35;
};

/** Saturated red — for pointer detection where brown artifacts would mislead. */
const isRedStrong = (rgb: RgbImage, x: number, y: number): boolean => {
  const i = (y * rgb.width + x) * 3;
  const r = rgb.data[i];
  return r > 110 && r > rgb.data[i + 1] + 45 && r > rgb.data[i + 2] + 45;
};

/**
 * X coordinate (in full-image pixels) where the red decimal zone starts,
 * or null. The decimal wheels / decimal pointers of Chinese meters are
 * printed red — a vertical red cluster inside the digit strip marks the
 * integer/decimal boundary. Cluster must span ≥ 12% of band height.
 */
export const redSplitX = (
  rgb: RgbImage,
  band: Box,
  within?: { x0: number; x1: number },
): number | null => {
  const { top, height } = band;
  const colScore = new Float64Array(rgb.width);
  const y0 = Math.max(0, top);
  const y1 = Math.min(rgb.height, top + height);
  const xLo = Math.max(0, within?.x0 ?? 0);
  const xHi = Math.min(rgb.width, within?.x1 ?? rgb.width);
  for (let x = xLo; x < xHi; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (isRed(rgb, x, y)) n++;
    colScore[x] = n / (y1 - y0);
  }
  // A decimal wheel is ~5-15% of image width; scan right-to-left for a
  // contiguous cluster whose column fill exceeds 8%.
  const need = Math.max(3, Math.round(rgb.width * 0.025));
  for (let x = xHi - need; x >= xLo; x--) {
    let ok = true;
    for (let k = 0; k < need; k++) {
      if (colScore[x + k] < 0.05) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // Extend left while columns stay red (wider red zones).
      let s = x;
      while (s > xLo && colScore[s - 1] >= 0.05 && x - s < rgb.width * 0.2) s--;
      return s;
    }
  }
  return null;
};

/* ---------- pointer-dial detection (Hough circles) ---------- */

export interface DialCircle {
  x: number;
  y: number;
  r: number;
  score: number;
}

const sobel = (g: GrayImage): { mag: Float32Array; dx: Float32Array; dy: Float32Array } => {
  const { width: w, height: h } = g;
  const mag = new Float32Array(w * h);
  const dx = new Float32Array(w * h);
  const dy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -at(g, x - 1, y - 1) - 2 * at(g, x - 1, y) - at(g, x - 1, y + 1) +
        at(g, x + 1, y - 1) + 2 * at(g, x + 1, y) + at(g, x + 1, y + 1);
      const gy =
        -at(g, x - 1, y - 1) - 2 * at(g, x, y - 1) - at(g, x + 1, y - 1) +
        at(g, x - 1, y + 1) + 2 * at(g, x, y + 1) + at(g, x + 1, y + 1);
      const i = y * w + x;
      mag[i] = Math.sqrt(gx * gx + gy * gy);
      dx[i] = gx;
      dy[i] = gy;
    }
  }
  return { mag, dx, dy };
};

/**
 * Gradient-directed Hough circle detection over the dial radius range.
 * Coarse 2D accumulator per radius; returns up to `limit` circles,
 * strongest first.
 */
export const detectCircles = (
  g: GrayImage,
  opts: { rMin?: number; rMax?: number; limit?: number; edgeT?: number } = {},
): DialCircle[] => {
  const { width: w, height: h } = g;
  const rMin = opts.rMin ?? Math.round(Math.min(w, h) * 0.04);
  const rMax = opts.rMax ?? Math.round(Math.min(w, h) * 0.12);
  const limit = opts.limit ?? 12;
  const edgeT = opts.edgeT ?? 60;
  const { mag, dx, dy } = sobel(g);

  interface Hit { x: number; y: number; r: number; score: number }
  const hits: Hit[] = [];
  for (let r = rMin; r <= rMax; r += 3) {
    const acc = new Map<number, number>();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (mag[i] < edgeT) continue;
        const len = Math.hypot(dx[i], dy[i]) || 1;
        const nx = dx[i] / len;
        const ny = dy[i] / len;
        for (const s of [1, -1]) {
          const cx = Math.round(x - s * nx * r);
          const cy = Math.round(y - s * ny * r);
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
          const k = cy * w + cx;
          acc.set(k, (acc.get(k) ?? 0) + 1);
        }
      }
    }
    const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    for (const [k, score] of top) hits.push({ x: k % w, y: Math.floor(k / w), r, score });
  }
  // NMS across radii: keep strongest, suppress circles within 0.8*r.
  hits.sort((a, b) => b.score - a.score);
  const picked: DialCircle[] = [];
  for (const c of hits) {
    if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > Math.min(p.r, c.r) * 0.8)) {
      picked.push({ x: c.x, y: c.y, r: c.r, score: c.score });
    }
    if (picked.length >= limit) break;
  }
  return picked;
};

/* ---------- pointer angle ---------- */

/**
 * Pointer direction on one dial, in dial-position units 0..10
 * (0 = straight up, clockwise; each integer = one digit).
 * Samples an inner annulus (r*0.3..0.65) where the needle body lives but
 * the printed rim digits don't. Prefers red pixels when the pointer is
 * red, else dark pixels.
 */
export const pointerPosition = (
  gray: GrayImage,
  rgb: RgbImage | null,
  c: { x: number; y: number; r: number },
): { pos: number; peak: number } => {
  const BINS = 72; // 5° resolution
  const bins = new Float64Array(BINS);
  const useRed = (() => {
    if (!rgb) return false;
    // If ≥8 red pixels inside the dial it's a red-pointer dial.
    let n = 0;
    for (let y = Math.max(0, c.y - c.r); y < Math.min(rgb.height, c.y + c.r); y++) {
      for (let x = Math.max(0, c.x - c.r); x < Math.min(rgb.width, c.x + c.r); x++) {
        if (Math.hypot(x - c.x, y - c.y) <= c.r * 0.7 && isRedStrong(rgb, x, y)) n++;
      }
    }
    return n >= 8;
  })();

  const darkT = (() => {
    // local threshold: percentile ~35% inside the dial
    let acc = 0;
    let n = 0;
    for (let y = Math.max(0, c.y - c.r); y < Math.min(gray.height, c.y + c.r); y += 2) {
      for (let x = Math.max(0, c.x - c.r); x < Math.min(gray.width, c.x + c.r); x += 2) {
        if (Math.hypot(x - c.x, y - c.y) <= c.r * 0.65) {
          acc += at(gray, x, y);
          n++;
        }
      }
    }
    return n ? acc / n - 25 : 110;
  })();

  for (let b = 0; b < BINS; b++) {
    const th = (b / BINS) * Math.PI * 2 - Math.PI / 2; // 0 bin = up
    const cth = Math.cos(th);
    const sth = Math.sin(th);
    let hits = 0;
    let steps = 0;
    for (let rr = c.r * 0.28; rr <= c.r * 0.55; rr += Math.max(1, c.r * 0.05)) {
      const x = Math.round(c.x + cth * rr);
      const y = Math.round(c.y + sth * rr);
      if (x < 0 || y < 0 || x >= gray.width || y >= gray.height) continue;
      steps++;
      if (useRed && rgb) {
        if (isRedStrong(rgb, x, y)) hits += 2;
      } else if (at(gray, x, y) < darkT) {
        hits++;
      }
    }
    bins[b] = steps ? hits / steps : 0;
  }
  // Smooth and take the densest ±10° window.
  const smooth = new Float64Array(BINS);
  for (let b = 0; b < BINS; b++) {
    smooth[b] = (bins[(b + BINS - 1) % BINS] + 2 * bins[b] + bins[(b + 1) % BINS]) / 4;
  }
  let peak = 0;
  let peakBin = 0;
  for (let b = 0; b < BINS; b++) {
    if (smooth[b] > peak) {
      peak = smooth[b];
      peakBin = b;
    }
  }
  // Refine: weighted centroid around the peak ±2 bins.
  let num = 0;
  let den = 0;
  for (let k = -2; k <= 2; k++) {
    const bi = (peakBin + k + BINS) % BINS;
    num += bi === 0 && k > 0 ? BINS * smooth[bi] : (bi + (bi < peakBin - 2 ? BINS : 0)) * smooth[bi];
    den += smooth[bi];
  }
  const center = den ? num / den : peakBin;
  const pos = (((center % BINS) + BINS) % BINS) / (BINS / 10); // 0..10
  return { pos: pos >= 10 ? 0 : pos, peak };
};

/**
 * Compose the integer reading from detected dials assuming the standard
 * LXSC layout: two columns — left column (top→bottom) = ×1, ×10, ×100,
 * ×1000; right column = decimals (ignored for the integer read).
 * Returns null when the layout doesn't fit (not two clear columns).
 */
export const composePointerInteger = (
  dials: Array<{ x: number; y: number; pos: number }>,
): { value: number; digits: number[]; inferred: boolean } | null => {
  if (dials.length < 4) return null;
  // Split columns by x median.
  const xs = [...dials].sort((a, b) => a.x - b.x);
  const midX = (xs[Math.floor(xs.length / 2) - 1].x + xs[Math.floor(xs.length / 2)].x) / 2;
  const left = dials.filter((d) => d.x <= midX).sort((a, b) => a.y - b.y);
  const right = dials.filter((d) => d.x > midX);
  if (left.length < 4 || right.length === 0) return null;
  // Left column top→bottom on the standard plate is ×1, ×10, ×100, ×1000 —
  // take the 4 lowest-x dials (tolerates 5-dial left columns: extra is ×10k).
  const intDials = left.slice(-4).length === 4 ? left.slice(-4) : left.slice(0, 4);
  const digits = intDials.map((d) => Math.floor(d.pos) % 10);
  const value = digits.reduce((acc, d, i) => acc + d * 10 ** i, 0);
  return { value, digits, inferred: true };
};

/* ---------- text helpers ---------- */

/** Longest run of digits in OCR text (≥ min), else null. */
export const longestDigitRun = (text: string, min = 4): string | null => {
  const m = text.match(/\d+/g)?.filter((s) => s.length >= min).sort((a, b) => b.length - a.length);
  return m?.[0] ?? null;
};
