// 水表读数本地识别（PaddleOCR PP-OCRv5 ONNX，浏览器内推理，不调用大模型）。
// 模型与 wasm 资源全部走本系统静态目录 /ocr-models、/ort，内网离线可用。
import type { OcrResult, OcrResultItem } from '@paddleocr/paddleocr-js';

export interface MeterOcrSuggestion {
  /** 数字读数（去前导零），如 "62" */
  value: string;
  /** 识别到的原始数字串（保留前导零），如 "00062" */
  digits: string;
  /** 0-100 */
  confidence: number;
  method: 'paddle-roller' | 'paddle-pointer';
  message?: string;
  /** 调试：识别到的全部文本框 */
  rawTexts?: string[];
}

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type PaddleOCRInstance = import('@paddleocr/paddleocr-js').PaddleOCR;
type AnyOcr = { predict(input: unknown): Promise<OcrResult[]> };

let ocrPromise: Promise<AnyOcr> | null = null;

async function getOcr(): Promise<AnyOcr> {
  if (!ocrPromise) {
    ocrPromise = (async () => {
      const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
      const ocr = (await PaddleOCR.create({
        lang: 'ch',
        ocrVersion: 'PP-OCRv6',
        // 本地静态资源，避免外网依赖（pilot 内网无外网）
        textDetectionModelName: 'PP-OCRv6_small_det',
        textRecognitionModelName: 'PP-OCRv6_small_rec',
        textDetectionModelAsset: { url: '/ocr-models/det-v6.tar' },
        textRecognitionModelAsset: { url: '/ocr-models/rec-v6.tar' },
        ortOptions: { backend: 'wasm', wasmPaths: '/ort/' },
        worker: false,
      })) as PaddleOCRInstance;
      return ocr as unknown as AnyOcr;
    })();
    ocrPromise.catch(() => {
      ocrPromise = null;
    });
  }
  return ocrPromise;
}

interface DigitBox {
  digits: string;
  score: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  red: boolean;
}

function boxOf(item: OcrResultItem) {
  const xs = item.poly.map((p) => p[0]);
  const ys = item.poly.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return { x0, y0, x1, y1, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

interface WarmStat {
  /** mean(r-g)：红/棕轮为正，黑轮/冷背景为负 */
  mrg: number;
  /** 暖色像素占比（亮红轮的兜底判据） */
  warm: number;
}

function warmStat(img: ImageData, x0: number, y0: number, x1: number, y1: number): WarmStat {
  const { data, width, height } = img;
  const sx0 = Math.max(0, Math.floor(x0));
  const sx1 = Math.min(width, Math.ceil(x1));
  const sy0 = Math.max(0, Math.floor(y0));
  const sy1 = Math.min(height, Math.ceil(y1));
  let warm = 0;
  let total = 0;
  let sumRG = 0;
  for (let y = sy0; y < sy1; y += 2) {
    for (let x = sx0; x < sx1; x += 2) {
      const i = (y * width + x) * 4;
      sumRG += data[i] - data[i + 1];
      total += 1;
      if (data[i] - data[i + 1] > 15 && data[i] - data[i + 2] > 5) warm += 1;
    }
  }
  return { mrg: total ? sumRG / total : 0, warm: total ? warm / total : 0 };
}

function isWarmStat(s: WarmStat): boolean {
  return s.mrg > 2 || s.warm > 0.12;
}

function isWarm(img: ImageData, b: { x0: number; y0: number; w: number; h: number }): boolean {
  return isWarmStat(warmStat(img, b.x0 + b.w * 0.15, b.y0 + b.h * 0.15, b.x0 + b.w * 0.85, b.y0 + b.h * 0.85));
}

/** 小数轮恒在整数轮右侧且为红/棕色：从右往左丢掉暖色条带对应字符，得到纯整数串 */
function dropTrailingRed(img: ImageData, b: { x0: number; y0: number; w: number; h: number }, digits: string): string {
  if (digits.length <= 1) return digits;
  const n = digits.length;
  const strips: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    const x0 = b.x0 + (b.w * i) / n;
    const x1 = b.x0 + (b.w * (i + 1)) / n;
    strips.push(isWarmStat(warmStat(img, x0, b.y0 + b.h * 0.15, x1, b.y0 + b.h * 0.85)));
  }
  let keep = n;
  while (keep > 1 && strips[keep - 1]) keep -= 1;
  return digits.slice(0, keep);
}

async function loadImageData(src: Blob | string): Promise<ImageData> {
  const bmp = typeof src === 'string' ? await createImageBitmap(await (await fetch(src)).blob()) : await createImageBitmap(src);
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height);
}

/** 从 OCR 文本框中抽取整数表轮数字串（5 位），红轮小数部分剔除 */
export function pickRollerDigits(items: OcrResultItem[], img: ImageData, imgW: number, imgH: number): { digits: string; confidence: number } | null {
  const boxes: DigitBox[] = [];
  for (const it of items) {
    // 只接受纯数字文本框——"X0.001"、"N1.5BH" 等刻度/铭牌字样不参与
    if (!/^\d+$/.test(it.text.trim())) continue;
    let digits = it.text.trim();
    const b = boxOf(it);
    // 框内若含红轮尾段（如 "0088"+"7" 合并框），逐字条带红度截断
    digits = dropTrailingRed(img, b, digits);
    if (!digits) continue;
    boxes.push({
      digits,
      score: it.score,
      cx: b.cx,
      cy: b.cy,
      w: b.w,
      h: b.h,
      red: isWarm(img, b),
    });
  }
  if (!boxes.length) return null;

  // 全指针表：表盘周圈散布大量小数字框（≥8 个 len≤2 且高度 <5% 图高）。
  // 这类图不存在字轮，直接返回 null 走服务端指针识别兜底，避免误并出假读数。
  const smallSingles = boxes.filter((b) => b.digits.length <= 2 && b.h < imgH * 0.05);
  if (smallSingles.length >= 8) return null;

  // 非红色数字框按行聚类（cy 接近）
  const nonRed = boxes.filter((b) => !b.red).sort((a, b) => a.cy - b.cy);
  const rows: DigitBox[][] = [];
  for (const b of nonRed) {
    const row = rows.find((r) => Math.abs(r[0].cy - b.cy) < Math.max(b.h, r[0].h) * 0.6);
    if (row) row.push(b);
    else rows.push([b]);
  }

  interface Cand {
    digits: string;
    score: number;
    exact5: boolean;
  }
  const cands: Cand[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.cx - b.cx);
    // 相邻框（横向间距 < 1.5 倍框高）合并为数字串
    let run: DigitBox[] = [];
    const flush = () => {
      if (!run.length) return;
      const text = run.map((r) => r.digits).join('');
      const score = run.reduce((s, r) => s + r.score, 0) / run.length;
      // 整数轮 4-6 位；更长的是串号/铭牌，拒绝而非截断（防 "10106120641"→"10106"）
      if (text.length >= 4 && text.length <= 6) {
        cands.push({ digits: text, score, exact5: text.length === 5 });
      }
      run = [];
    };
    for (const b of row) {
      const prev = run[run.length - 1];
      if (prev && b.cx - prev.cx > Math.max(prev.h, b.h) * 1.6) flush();
      run.push(b);
    }
    flush();
  }
  // 单个文本框本身就是数字串（整行一个检测框）
  for (const b of nonRed) {
    if (b.digits.length >= 4 && b.digits.length <= 6) {
      cands.push({ digits: b.digits, score: b.score, exact5: b.digits.length === 5 });
    }
  }
  if (!cands.length) return null;

  // 优先恰好 5 位、置信度高；图像中央偏上的表轮区加分
  const scored = cands.map((c) => {
    const ref = nonRed.find((b) => b.digits.includes(c.digits.slice(0, Math.min(5, c.digits.length))));
    const cyNorm = ref ? ref.cy / imgH : 1;
    const cxNorm = ref ? ref.cx / imgW : 0;
    const centerBonus = cyNorm > 0.15 && cyNorm < 0.75 ? 0.05 : 0;
    const cxBonus = cxNorm > 0.15 && cxNorm < 0.85 ? 0.03 : 0;
    return { ...c, rank: c.score + (c.exact5 ? 0.15 : 0) + centerBonus + cxBonus };
  });
  scored.sort((a, b) => b.rank - a.rank);
  const best = scored[0];
  if (best.digits.length < 4) return null;
  return { digits: best.digits, confidence: Math.round(Math.min(0.99, best.score) * 100) };
}

/** 指针表盘列约定：左列 ×1/×10/×100/×1000 自上至下，右列小数位（只读 ×0.1）。 */
const PTR_LEFT_MULTS = [1, 10, 100, 1000];

const ptrDbg = (m: string, v?: unknown) => {
  if (typeof window !== 'undefined' && (window as unknown as { __ocrDebug?: boolean }).__ocrDebug) {
    // eslint-disable-next-line no-console
    console.log('[ptr]', m, typeof v === 'object' ? JSON.stringify(v) : (v ?? ''));
  }
};

function imgToCanvas(img: ImageData): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}

/** 降采样灰度 + Sobel 边缘图 */
function edgeMap(img: ImageData, targetW = 480): { w: number; h: number; edge: Uint8Array } {
  const scale = Math.min(1, targetW / img.width);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(imgToCanvas(img), 0, 0, w, h);
  const ds = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (ds[i * 4] * 3 + ds[i * 4 + 1] * 4 + ds[i * 4 + 2]) >> 3;
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      if (gx * gx + gy * gy > 8100) edge[i] = 1; // |g|>90
    }
  }
  return { w, h, edge };
}

interface Circle { cx: number; cy: number; r: number; cover: number }

/** 粗网格 Hough 圆检 + 周长覆盖率验证 + NMS */
function detectCircles(edge: Uint8Array, w: number, h: number): Circle[] {
  const rMin = Math.max(10, Math.round(w * 0.028));
  const rMax = Math.round(w * 0.085);
  const cell = 4;
  const wCell = Math.floor(w / cell);
  const acc = new Map<number, number>();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!edge[y * w + x]) continue;
      for (let r = rMin; r <= rMax; r += 2) {
        for (let a = 0; a < 360; a += 12) {
          const rad = (a * Math.PI) / 180;
          const cx = Math.round((x - r * Math.cos(rad)) / cell);
          const cy = Math.round((y - r * Math.sin(rad)) / cell);
          if (cx < 0 || cy < 0 || cx >= wCell || cy * cell >= h) continue;
          const key = (cy * wCell + cx) * 64 + r;
          acc.set(key, (acc.get(key) ?? 0) + 1);
        }
      }
    }
  }
  const cand: (Circle & { votes: number })[] = [];
  for (const [key, votes] of acc) {
    const r = key % 64;
    const rest = (key - r) / 64;
    const cx = (rest % wCell) * cell;
    const cy = Math.floor(rest / wCell) * cell;
    // 周长上理论票数 ≈ 2πr，弱边缘表盘取 30% 阈值
    if (votes < 2 * Math.PI * r * 0.3) continue;
    let on = 0;
    for (let a = 0; a < 360; a += 360 / 48) {
      const rad = (a * Math.PI) / 180;
      const x = Math.round(cx + r * Math.cos(rad));
      const y = Math.round(cy + r * Math.sin(rad));
      let hit = 0;
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && edge[yy * w + xx]) {
            hit = 1;
            break;
          }
        }
      }
      on += hit;
    }
    const cover = on / 48;
    if (cover >= 0.35) cand.push({ cx, cy, r, cover, votes });
  }
  cand.sort((a, b) => b.votes - a.votes);
  const kept: Circle[] = [];
  for (const c of cand) {
    if (kept.some((k) => Math.hypot(k.cx - c.cx, k.cy - c.cy) < (c.r + k.r) * 0.6)) continue;
    kept.push(refineCircle(edge, w, h, c) ?? c);
    if (kept.length >= 14) break;
  }
  return kept;
}

/** Kasa 最小二乘圆拟合精修中心：取候选圆周 ±3px 内的边缘点拟合 */
function refineCircle(edge: Uint8Array, w: number, h: number, c: Circle): Circle | null {
  const pts: [number, number][] = [];
  const r0 = c.r - 3;
  const r1 = c.r + 3;
  const x0 = Math.max(0, Math.floor(c.cx - r1));
  const x1 = Math.min(w - 1, Math.ceil(c.cx + r1));
  const y0 = Math.max(0, Math.floor(c.cy - r1));
  const y1 = Math.min(h - 1, Math.ceil(c.cy + r1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!edge[y * w + x]) continue;
      const rr = Math.hypot(x - c.cx, y - c.cy);
      if (rr >= r0 && rr <= r1) pts.push([x, y]);
    }
  }
  if (pts.length < c.r) return null;
  // 解 (x²+y²) + D x + E y + F = 0 → 中心 (-D/2, -E/2)
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const [x, y] of pts) {
    const z = -(x * x + y * y);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const n = pts.length;
  // 3x3 正规方程
  const m = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const b = [sxz, syz, sz];
  // 高斯消元
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r2 = col + 1; r2 < 3; r2++) if (Math.abs(m[r2][col]) > Math.abs(m[piv][col])) piv = r2;
    [m[col], m[piv]] = [m[piv], m[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    if (Math.abs(m[col][col]) < 1e-9) return null;
    for (let r2 = col + 1; r2 < 3; r2++) {
      const f = m[r2][col] / m[col][col];
      for (let c2 = col; c2 < 3; c2++) m[r2][c2] -= f * m[col][c2];
      b[r2] -= f * b[col];
    }
  }
  const F = b[2] / m[2][2];
  const E = (b[1] - m[1][2] * F) / m[1][1];
  const D = (b[0] - m[0][1] * E - m[0][2] * F) / m[0][0];
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = Math.sqrt(Math.max(1, (D * D + E * E) / 4 - F));
  // 合理性：拟合中心偏移 < 0.4r
  if (Math.hypot(cx - c.cx, cy - c.cy) > c.r * 0.4) return null;
  return { cx, cy, r: r2, cover: c.cover };
}

/** 倍率标签解析（容忍 OCR 噪声与倒置文本） */
function parseMultLabel(t0: string): number | null {
  const t = t0.toUpperCase().replace(/×|Ｘ/g, 'X').replace(/[，,]/g, '.').replace(/\s/g, '');
  if (!/X/.test(t)) return null;
  if (t === 'XI' || t === 'XL' || t === 'XI.') return 1;
  if (!/\d/.test(t)) return null;
  if (/^X0\.0*1$/.test(t)) return Number(t.slice(1));
  if (/^X1\.0{3}$/.test(t)) return 1000;
  const m = t.match(/^X(10{0,3})$/);
  if (m) return Number(m[1]);
  const rev = t.match(/^([0-9.]+)X$/);
  if (rev) {
    const d = [...rev[1]].reverse().join('');
    if (/^10{0,3}$/.test(d)) return Number(d);
    if (/^0\.0*1$/.test(d)) return Number(d);
  }
  return null;
}

/**
 * 指针表读数：Hough 圆检定位表盘 → 像素射线采样定指针角度 →
 * OCR 刻度数字回归判顺/逆时针 → 标签+列约定分配倍率 → 组合整数 + ×0.1 小数。
 * 不确定一律返回 null。
 */
function readPointerDials(items: OcrResultItem[], img: ImageData): { value: string; confidence: number } | null {
  const { w, h, edge } = edgeMap(img);
  const scale = img.width / w;
  const circles = detectCircles(edge, w, h)
    .map((c) => ({ cx: c.cx * scale, cy: c.cy * scale, r: c.r * scale, cover: c.cover }))
    .filter((c) => c.r > 14 && c.r < img.width * 0.16);
  ptrDbg('circles', circles.map((c) => [Math.round(c.cx), Math.round(c.cy), Math.round(c.r), +c.cover.toFixed(2)]));
  if (circles.length < 4) return null;

  const { width: W, height: H, data } = img;
  const px = (x: number, y: number) => {
    const xx = Math.max(0, Math.min(W - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (yy * W + xx) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };

  const digitPts: { v: number; cx: number; cy: number }[] = [];
  const labels: { cx: number; cy: number; mult: number }[] = [];
  for (const it of items) {
    const xs = it.poly.map((p) => p[0]);
    const ys = it.poly.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const t = it.text.trim();
    if (/^\d$/.test(t)) {
      digitPts.push({ v: Number(t), cx, cy });
      continue;
    }
    const mult = parseMultLabel(t);
    if (mult != null) labels.push({ cx, cy, mult });
  }
  ptrDbg('labels', labels.map((l) => [l.mult, Math.round(l.cx), Math.round(l.cy)]));

  interface Dial extends Circle { mult: number | null; cw: boolean | null }
  const dials: Dial[] = [];
  for (const c of circles) {
    const ring = digitPts.filter((d) => {
      const dist = Math.hypot(d.cx - c.cx, d.cy - c.cy);
      return dist > c.r * 0.45 && dist < c.r * 1.25;
    });
    if (ring.length < 3 && !(c.r >= img.width * 0.05 && c.cover >= 0.45)) continue;
    let cw: boolean | null = null;
    if (ring.length >= 4) {
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      const n = ring.length;
      const meanD = ring.reduce((s, d) => s + d.v, 0) / n;
      const meanT =
        ring.reduce((s, d) => s + ((Math.atan2(d.cx - c.cx, c.cy - d.cy) * 180) / Math.PI + 360) % 360, 0) / n;
      for (const d of ring) {
        const th = ((Math.atan2(d.cx - c.cx, c.cy - d.cy) * 180) / Math.PI + 360) % 360;
        const thu = th - Math.round((th - meanT) / 360) * 360;
        sxy += (d.v - meanD) * (thu - meanT);
        syy += (thu - meanT) * (thu - meanT);
        sxx += (d.v - meanD) * (d.v - meanD);
      }
      if (sxx > 1 && syy > 1) {
        const fit = sxy / Math.sqrt(sxx * syy);
        if (Math.abs(fit) > 0.6) cw = fit > 0;
      }
    }
    dials.push({ ...c, mult: null, cw });
  }
  ptrDbg('dials', dials.map((d) => [Math.round(d.cx), Math.round(d.cy), Math.round(d.r), d.cw === null ? '?' : d.cw ? 'cw' : 'ccw']));
  if (dials.length < 4) return null;

  // 只把"大圆"（真表盘）作为网格成员；小圆不参与倍率分配
  const members = dials.filter((d) => d.r >= img.width * 0.05);
  if (members.length < 4) return null;
  // 1) 标签近邻分配（成员间竞争最近者）
  for (const l of labels) {
    const near = members
      .map((d) => ({ d, dist: Math.hypot(d.cx - l.cx, d.cy - l.cy) }))
      .filter((e) => e.dist < e.d.r * 1.7)
      .sort((a, b) => a.dist - b.dist)[0];
    if (near) {
      if (near.d.mult != null && near.d.mult !== l.mult) {
        ptrDbg('label-conflict', { label: l.mult, dial: [Math.round(near.d.cx), Math.round(near.d.cy)], had: near.d.mult });
        return null; // 同一盘两个不一致倍率 → 布局异常，拒识
      }
      near.d.mult = l.mult;
    }
  }
  // 2) 缺失整数位插值：按行序把未标注的整数列成员填入缺失倍率（仅当缺失唯一/可定位）
  const intLabeled = members.filter((d) => d.mult != null && d.mult >= 1);
  if (intLabeled.length >= 2) {
    const intCx = intLabeled.reduce((s, d) => s + d.cx, 0) / intLabeled.length;
    const missingInt = PTR_LEFT_MULTS.filter((k) => !intLabeled.some((d) => d.mult === k));
    const cands = members
      .filter((d) => d.mult == null && Math.abs(d.cx - intCx) < img.width * 0.18)
      .sort((a, b) => a.cy - b.cy);
    if (missingInt.length === 1 && cands.length === 1) {
      cands[0].mult = missingInt[0];
    } else if (missingInt.length === cands.length) {
      // 全部缺失位与候选一一对应：按行序插值到缺失倍率序列
      cands.forEach((d, i) => (d.mult = missingInt[i]));
    }
  }
  // 3) ×0.1：已标注优先；标签存在但圆未检出时，用标签正上方 ~1.25r 合成表盘
  let dec01Dial = members.find((d) => d.mult === 0.1) ?? null;
  if (!dec01Dial) {
    const l01 = labels.find((l) => l.mult === 0.1);
    if (l01) {
      const rMed = members.map((m) => m.r).sort((a, b) => a - b)[Math.floor(members.length / 2)] ?? img.width * 0.065;
      dec01Dial = { cx: l01.cx, cy: l01.cy - rMed * 1.25, r: rMed, cover: 0, mult: 0.1, cw: null };
      ptrDbg('synthetic-0.1', { cx: Math.round(l01.cx), cy: Math.round(l01.cy - rMed * 1.25), r: Math.round(rMed) });
    }
  }
  const intDials = members.filter((d) => d.mult != null && d.mult >= 1);
  const need = [1000, 100, 10, 1];
  ptrDbg('mult', members.map((d) => [d.mult, Math.round(d.cx), Math.round(d.cy)]));
  if (!need.every((k) => intDials.some((d) => d.mult === k))) return null;

  const readOne = (d: Dial): { digit: number; sharp: number; v: number } => {
    // 自适应暗度阈值：针+刻字约占盘面最暗 20%；红针盘改用红色掩码。
    const rStat = d.r * 0.7;
    const lumas: number[] = [];
    let reds = 0;
    let total = 0;
    for (let y = Math.floor(d.cy - rStat); y <= d.cy + rStat; y++) {
      for (let x = Math.floor(d.cx - rStat); x <= d.cx + rStat; x++) {
        const dx = x - d.cx;
        const dy = y - d.cy;
        if (Math.hypot(dx, dy) > rStat) continue;
        total++;
        const [pr, pg, pb] = px(x, y);
        lumas.push(Math.round(pr * 0.3 + pg * 0.5 + pb * 0.2));
        if (pr - pg > 30 && pr - pb > 15 && pr > 80) reds++;
      }
    }
    lumas.sort((a, b) => a - b);
    const isRedDial = reds > total * 0.06;
    const thr = Math.min(95, lumas[Math.floor(lumas.length * 0.2)] + 8);

    // 射线法：越过针毂（0.32r 起）到数字环下沿（0.62r），
    // 逐角度统计暗/红像素占比 —— 指针射线全程连续命中，数字只覆盖局部。
    const isInk = (x: number, y: number) => {
      const [pr, pg, pb] = px(x, y);
      return isRedDial
        ? pr - pg > 30 && pr - pb > 15 && pr > 80
        : Math.round(pr * 0.3 + pg * 0.5 + pb * 0.2) < thr;
    };
    // 针=径向连续长线；内环=切向短段 → 评分 = 径向最长连续命中
    const rA = d.r * 0.25;
    const rB = d.r * 0.80;
    const rStep = 1.6;
    const nSmp = Math.floor((rB - rA) / rStep);
    const scores = new Float32Array(180); // 2° 步长
    for (let deg = 0; deg < 360; deg += 2) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      let run = 0;
      let bestRun = 0;
      for (let k = 0; k < nSmp; k++) {
        const rr = rA + k * rStep;
        let hit = 0;
        for (const o of [-1, 0, 1]) {
          const ox = -dy * o;
          const oy = dx * o;
          if (isInk(d.cx + dx * rr + ox, d.cy + dy * rr + oy)) hit = 1;
        }
        if (hit) {
          run++;
          if (run > bestRun) bestRun = run;
        } else run = 0;
      }
      scores[deg / 2] = bestRun;
    }
    // 环形平滑（±4°）找峰，再对峰邻域（score≥0.7·max）做加权质心精化
    const sm = new Float32Array(180);
    let best = 0;
    let bestS = -1;
    let sum = 0;
    for (let i = 0; i < 180; i++) {
      for (let o = -2; o <= 2; o++) sm[i] += scores[(i + o + 180) % 180];
      sum += sm[i];
      if (sm[i] > bestS) {
        bestS = sm[i];
        best = i;
      }
    }
    // 峰邻域环形质心：连续高分扇区取加权平均角
    let wNum = 0;
    let wDen = 0;
    let off = 0;
    while (off < 20 && sm[(best + off) % 180] >= bestS * 0.7) {
      wNum += sm[(best + off) % 180] * off;
      wDen += sm[(best + off) % 180];
      off++;
    }
    off = -1;
    while (off > -20 && sm[(best + off + 180) % 180] >= bestS * 0.7) {
      wNum += sm[(best + off + 180) % 180] * off;
      wDen += sm[(best + off + 180) % 180];
      off--;
    }
    const bestA = (((best + (wDen ? wNum / wDen : 0)) * 2) % 360 + 360) % 360;
    const sharp = bestS / (sum / 180 || 1);
    const cw = d.cw ?? true;
    const v = cw ? bestA / 36 : (360 - bestA) / 36;
    const digit = ((Math.floor(v) % 10) + 10) % 10;
    ptrDbg('needle', { mult: d.mult, cx: Math.round(d.cx), cy: Math.round(d.cy), deg: +bestA.toFixed(1), digit, v: +v.toFixed(2), sharp: +sharp.toFixed(2), thr, red: isRedDial });
    return { digit, sharp, v };
  };

  const parts = intDials
    .filter((d) => need.includes(d.mult!))
    .map((d) => ({ mult: d.mult!, ...readOne(d) }))
    .sort((a, b) => b.mult - a.mult);
  const tenthRead = dec01Dial ? readOne(dec01Dial) : null;
  const tenth = tenthRead ? tenthRead.digit : null;
  // 机械联动裁决（自 ×0.1 向高位逐级）：高位盘 frac 应 ≈ 低位组合占本盘周期比例。
  // 实测 frac>0.7 而低位显示接近周期开头（<0.35）→ 针刚越界 → +1；
  // frac<0.3 而低位接近周期末尾（>0.65）→ 针未越界 → -1。
  const asc = [...parts].sort((a, b) => a.mult - b.mult); // ×1 → ×1000
  const chain = tenthRead ? [{ mult: 0.1, ...tenthRead }, ...asc] : asc;
  let lowerVal = 0;
  let prevMult = 0;
  for (const p of chain) {
    if (prevMult > 0) {
      const frac = p.v - Math.floor(p.v);
      // 低位组合占本盘周期的比例（×10 盘 ← 个位值/10；×100 盘 ← 低两位/100 …）
      const expFrac = (lowerVal % p.mult) / p.mult;
      if (frac > 0.7 && expFrac < 0.35) {
        p.digit = (Math.floor(p.v) + 1) % 10;
        ptrDbg('carry+', { mult: p.mult, v: +p.v.toFixed(2), expFrac: +expFrac.toFixed(2), digit: p.digit });
      } else if (frac < 0.3 && expFrac > 0.65) {
        p.digit = (Math.floor(p.v) + 9) % 10;
        ptrDbg('carry-', { mult: p.mult, v: +p.v.toFixed(2), expFrac: +expFrac.toFixed(2), digit: p.digit });
      }
    }
    lowerVal += p.digit * p.mult;
    prevMult = p.mult;
  }
  const intStr = asc
    .slice()
    .sort((a, b) => b.mult - a.mult)
    .map((p) => String(p.digit))
    .join('');
  const value = tenth != null ? `${intStr}.${tenth}` : intStr;
  const minSharp = Math.min(...parts.map((p) => p.sharp));
  const confidence = Math.round(Math.max(30, Math.min(85, 40 + minSharp * 16)));
  ptrDbg('read', { intStr, tenth, value, conf: confidence });
  return { value, confidence };
}

/**
 * 识别表底照片中的字轮整数读数；字轮为空时尝试指针表盘读数。
 * @param image 压缩后的 JPEG（Blob 或 dataURL）
 * @returns 识别建议；无可靠结果返回 null
 */
export async function recognizeMeterReading(image: Blob | string): Promise<MeterOcrSuggestion | null> {
  const ocr = await getOcr();
  const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image;
  const [imgData, results] = await Promise.all([loadImageData(blob), ocr.predict(blob)]);
  const res = results[0];
  if (!res || !res.items.length) return null;
  const picked = pickRollerDigits(res.items, imgData, res.image.width, res.image.height);
  if (!picked) {
    const pointer = readPointerDials(res.items, imgData);
    if (!pointer) return null;
    return {
      value: pointer.value,
      digits: pointer.value,
      confidence: pointer.confidence,
      method: 'paddle-pointer',
      message: `本地指针表推断 ${pointer.value}（置信度 ${pointer.confidence}%），务必人工核对`,
      rawTexts: res.items.map((i) => i.text),
    };
  }
  const { digits, confidence } = picked;
  const value = String(Number(digits));
  return {
    value,
    digits,
    confidence,
    method: 'paddle-roller',
    message:
      confidence >= 70
        ? `本地识别表轮 ${digits}，请与表底核对`
        : `本地识别置信度低（${confidence}%），请人工核对表轮 ${digits}`,
    rawTexts: res.items.map((i) => i.text),
  };
}

/** 预加载模型（可在页面空闲时调用，首次识别不必等待下载/初始化） */
export function warmupMeterOcr(): void {
  getOcr().catch(() => undefined);
}

/** 诊断：返回原始 OCR 文本框（不做表轮解析） */
/** 诊断：对图片跑完整识别并返回叠加调试图（圆+指针射线）的 dataURL */
export async function debugPointerOverlay(image: Blob | string): Promise<string | null> {
  const ocr = await getOcr();
  const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image;
  const [imgData, results] = await Promise.all([loadImageData(blob), ocr.predict(blob)]);
  const res = results[0];
  if (!res) return null;
  const { w, h, edge } = edgeMap(imgData);
  const scale = imgData.width / w;
  const circles = detectCircles(edge, w, h).map((c) => ({ cx: c.cx * scale, cy: c.cy * scale, r: c.r * scale, cover: c.cover }));
  const cv = imgToCanvas(imgData);
  const ctx = cv.getContext('2d')!;
  ctx.strokeStyle = 'lime';
  ctx.lineWidth = 2;
  for (const c of circles) {
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  readPointerDials(res.items, imgData);
  return cv.toDataURL('image/jpeg', 0.85);
}

/** 诊断：返回原始 OCR 文本框（不做表轮解析） */
export async function rawPredict(image: Blob | string): Promise<OcrResultItem[]> {
  const ocr = await getOcr();
  const blob = typeof image === 'string' ? await (await fetch(image)).blob() : image;
  const [res] = await ocr.predict(blob);
  return res?.items ?? [];
}

// 诊断钩子：console/自动化测试可直接调用 __meterOcr.recognizeMeterReading(dataUrl)
if (typeof window !== 'undefined') {
  (window as unknown as { __meterOcr?: unknown }).__meterOcr = { recognizeMeterReading, warmupMeterOcr, rawPredict };
}
