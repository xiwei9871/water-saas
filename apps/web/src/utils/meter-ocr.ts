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
  if (typeof window === 'undefined' || (window as unknown as { __ocrDebug?: boolean }).__ocrDebug) {
    // eslint-disable-next-line no-console
    console.log('[ptr]', m, typeof v === 'object' ? JSON.stringify(v) : (v ?? ''));
  }
};

// ---------- OpenCV.js：表盘倾斜校正的现成轮子（浏览器本地 /opencv/opencv.js）----------
let cvPromise: Promise<any> | null = null;
let cvInjected: any = null;
/** Emscripten Module 是 thenable（带 .then）——过 Promise.resolve 会被吞并永不返回，包原型层屏蔽 */
function unwrapThenable(mod: any): any {
  const api = Object.create(mod);
  api.then = undefined;
  return api;
}
/** 测试/Node 复算注入已初始化的 cv 实例（生产浏览器走 script 标签自动加载） */
export function __setCvForTest(cv: any): void {
  cvInjected = cv && cv.then ? unwrapThenable(cv) : cv;
}
function getCv(): Promise<any> {
  if (cvInjected) return Promise.resolve(cvInjected);
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    const w = window as any;
    if (w.cv?.Mat) return unwrapThenable(w.cv);
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/opencv/opencv.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('opencv.js load failed'));
      document.head.appendChild(s);
    });
    const t0 = Date.now();
    while (!w.cv?.Mat) {
      if (Date.now() - t0 > 30000) throw new Error('opencv init timeout');
      await new Promise((r) => setTimeout(r, 120));
    }
    return unwrapThenable(w.cv);
  })().catch((e) => { cvPromise = null; throw e; });
  return cvPromise;
}

/** 旋转椭圆（cv.fitEllipse RotatedRect）：p = c + R(φ)·(u·w/2, v·h/2) */
interface DialEllipse { cx: number; cy: number; aw: number; ah: number; phi: number }
function ellNorm(e: DialEllipse, x: number, y: number): [number, number] {
  const dx = x - e.cx;
  const dy = y - e.cy;
  const c = Math.cos(e.phi);
  const s = Math.sin(e.phi);
  return [(dx * c + dy * s) / e.aw, (-dx * s + dy * c) / e.ah];
}
/** 表盘空间角 θ（0=表心正上, 顺+）：归一化后 atan2(u,-v) */
function ellTheta(e: DialEllipse, x: number, y: number): number {
  const [u, v] = ellNorm(e, x, y);
  return ((Math.atan2(u, -v) * 180) / Math.PI + 360) % 360;
}
/** 表盘空间角 → 椭圆上的原始图像坐标 */
function ellPoint(e: DialEllipse, thetaDeg: number): [number, number] {
  const t = (thetaDeg * Math.PI) / 180;
  const u = Math.sin(t) * e.aw;
  const v = -Math.cos(t) * e.ah;
  const c = Math.cos(e.phi);
  const s = Math.sin(e.phi);
  return [e.cx + u * c - v * s, e.cy + u * s + v * c];
}
function cvFitEllipse(cv: any, pts: { cx: number; cy: number }[]): DialEllipse | null {
  if (pts.length < 5) return null;
  const m = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap((p) => [Math.round(p.cx), Math.round(p.cy)]));
  try {
    const rr = cv.fitEllipse(m);
    return { cx: rr.center.x, cy: rr.center.y, aw: rr.size.width / 2, ah: rr.size.height / 2, phi: (rr.angle * Math.PI) / 180 };
  } catch {
    return null;
  } finally {
    m.delete();
  }
}

function imgToCanvas(img: ImageData): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}

/** Sobel 边缘图（纯函数，Node 可复算） */
export function sobelGray(gray: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w + 1] - 2 * gray[i - w] - gray[i + w + 1] + gray[i + w + 1] + 2 * gray[i + w] + gray[i + w + 1];
      if (gx * gx + gy * gy > 8100) edge[i] = 1; // |g|>90
    }
  }
  return edge;
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
  return { w, h, edge: sobelGray(gray, w, h) };
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
  let t = t0.toUpperCase().replace(/×|Ｘ/g, 'X').replace(/[，,]/g, '.').replace(/\s/g, '');
  if (/^\+/.test(t)) t = 'X' + t.slice(1); // "×" 被 OCR 误读为 "+"
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

type Px = (x: number, y: number) => readonly [number, number, number];

function makePx(img: ImageData): Px {
  const { width: W, height: H, data } = img;
  return (x, y) => {
    const xx = Math.max(0, Math.min(W - 1, Math.round(x)));
    const yy = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (yy * W + xx) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
}

interface PtrDial {
  cx: number;
  cy: number;
  r: number;
  cw: boolean | null;
  mult: number | null;
}

/**
 * 指针角度采样：自适应暗度阈值（针+刻字≈盘面最暗20%），红针盘改红色掩码；
 * 逐角度射线采样取径向最长连续命中，峰邻域加权质心精化。
 * ell = 表盘环椭圆（cv.fitEllipse 倾斜校正）；正拍/无拟合时按圆形映射。
 */
function readNeedle(px: Px, d: PtrDial): { digit: number; sharp: number; v: number; ang: number } {
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

  const isInk = (x: number, y: number) => {
    const [pr, pg, pb] = px(x, y);
    return isRedDial
      ? pr - pg > 30 && pr - pb > 15 && pr > 80
      : Math.round(pr * 0.3 + pg * 0.5 + pb * 0.2) < thr;
  };
  // 宽松墨判定：接回阈值附近断开的细针杆（洪泛蔓延用；种子仍用严格阈值）
  const isInkLoose = (x: number, y: number) => {
    const [pr, pg, pb] = px(x, y);
    return isRedDial
      ? pr - pg > 24 && pr - pb > 10 && pr > 70
      : Math.round(pr * 0.3 + pg * 0.5 + pb * 0.2) < thr + 25;
  };
  // 针形隔离：从毂心最近的墨像素洪泛出"针+毂"连通域——盘面数字是独立连通域、
  // 不与毂相连，天然排除。方向 = 离毂最远端像素簇（maxDist×0.85）的质心——
  // 球状毂+短尖的水滴针，分位数簇会被球肩拉偏，只有极值簇落在真针尖上。
  // 两档阈值：严格掩码优先；尖端伸展不足时用宽松掩码重试（限 0.6r 内防桥接数字）。
  let cx = d.cx;
  let cy = d.cy;
  const rBox = Math.ceil(d.r * 0.85);
  const x0 = Math.floor(cx - rBox);
  const y0 = Math.floor(cy - rBox);
  const bw = rBox * 2 + 1;
  let needleAng = -1;
  let needleN = 0;
  let needleTip = 0;
  let needleProm = 0;
  for (const [ink, rLim] of [[isInk, 0.78], [isInkLoose, 0.6]] as const) {
    const mask = new Uint8Array(bw * bw); // 1=ink
    const seen = new Uint8Array(bw * bw);
    for (let y = 0; y < bw; y++) {
      for (let x = 0; x < bw; x++) {
        const gx = x0 + x;
        const gy = y0 + y;
        if (Math.hypot(gx - cx, gy - cy) > d.r * rLim) continue;
        if (ink(gx, gy)) mask[y * bw + x] = 1;
      }
    }
    // 毂心种子：内环 0.3r 内最近的严格墨点
    const rSeed = d.r * 0.3;
    let sx = -1;
    let sy = -1;
    let sD = 1e9;
    for (let y = 0; y < bw; y++) {
      for (let x = 0; x < bw; x++) {
        const gx = x0 + x;
        const gy = y0 + y;
        const dist = Math.hypot(gx - cx, gy - cy);
        if (dist > rSeed || !isInk(gx, gy)) continue;
        if (dist < sD) { sD = dist; sx = x; sy = y; }
      }
    }
    if (sx < 0) continue;
    // BFS 收集针组件
    const compX: number[] = [];
    const compY: number[] = [];
    const stack = [sy * bw + sx];
    seen[sy * bw + sx] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const yy = (idx / bw) | 0;
      const xx = idx % bw;
      compX.push(x0 + xx);
      compY.push(y0 + yy);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = xx + ox;
          const ny = yy + oy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bw) continue;
          const ni = ny * bw + nx;
          if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
    }
    // 毂心修正：组件内距原点<0.3r 的像素质心
    let hX = 0, hY = 0, hN = 0;
    for (let i = 0; i < compX.length; i++) {
      if (Math.hypot(compX[i] - d.cx, compY[i] - d.cy) < d.r * 0.3) { hX += compX[i]; hY += compY[i]; hN++; }
    }
    if (hN > 5) { cx = hX / hN; cy = hY / hN; }
    // 径向剖面法：每 2° bin 取组件像素最大距 → ±4° 平滑 →
    // prominence = 峰值 − 两侧 ±10~60° 最小值。针尖=狭窄突出（两侧骤降），
    // 毂缘=宽平台 prominence≈0 → 峰即针尖方向
    const prof = new Float32Array(180);
    let maxD = 0;
    for (let i = 0; i < compX.length; i++) {
      const dx = compX[i] - cx;
      const dy = compY[i] - cy;
      const dd = Math.hypot(dx, dy);
      if (dd > maxD) maxD = dd;
      const th = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      const bi = Math.floor(th / 2) % 180;
      if (dd > prof[bi]) prof[bi] = dd;
    }
    const sm = new Float32Array(180);
    for (let i = 0; i < 180; i++) for (let o = -2; o <= 2; o++) sm[i] += prof[(i + o + 180) % 180];
    let pk = -1;
    let pkP = 0;
    for (let i = 0; i < 180; i++) {
      let side = Infinity;
      for (let o = -30; o <= -5; o++) side = Math.min(side, sm[(i + o + 180) % 180]);
      for (let o = 5; o <= 30; o++) side = Math.min(side, sm[(i + o + 180) % 180]);
      const pr = sm[i] - side;
      if (pr > pkP) { pkP = pr; pk = i; }
    }
    if (pk >= 0 && pkP > 2) {
      // 峰邻域（≥70% 峰）加权质心精化
      let wN = 0, wD = 0;
      let off = 0;
      while (off < 12 && sm[(pk + off) % 180] >= sm[pk] * 0.7) { wN += sm[(pk + off) % 180] * off; wD += sm[(pk + off) % 180]; off++; }
      off = -1;
      while (off > -12 && sm[(pk + off + 180) % 180] >= sm[pk] * 0.7) { wN += sm[(pk + off + 180) % 180] * off; wD += sm[(pk + off + 180) % 180]; off--; }
      const th = (((pk + (wD ? wN / wD : 0)) * 2) % 360 + 360) % 360;
      needleAng = th;
      needleN = compX.length;
      needleTip = maxD;
      needleProm = pkP;
      ptrDbg('needle-comp', { mult: d.mult, n: compX.length, th: +th.toFixed(1), tip: +needleTip.toFixed(1), prom: +pkP.toFixed(1) });
    }
    if (needleTip >= d.r * 0.42) break; // 尖端伸展足够 → 不再用宽松掩码
  }
  // sharp：组件有规模 + 径向剖面有真突起（prominence）+ 尖端伸展 ≥0.45r
  const bestA = needleAng;
  const sharp = needleN >= 12 && bestA >= 0 && needleProm > 12 ? needleTip / (d.r * 0.45) : 0;
  const cw = d.cw ?? true;
  const v = cw ? bestA / 36 : (360 - bestA) / 36;
  const digit = ((Math.floor(v) % 10) + 10) % 10;
  ptrDbg('needle', { mult: d.mult, cx: Math.round(d.cx), cy: Math.round(d.cy), deg: +bestA.toFixed(1), digit, v: +v.toFixed(2), sharp: +sharp.toFixed(2), thr, red: isRedDial });
  return { digit, sharp, v, ang: cw ? bestA : (360 - bestA) % 360 };
}

interface PtrPart {
  mult: number;
  digit: number;
  sharp: number;
  v: number;
  ang: number;
}

/**
 * 机械联动枚举裁决：每盘"针落在哪两个数字之间"取整（floor），frac 贴近整界
 *（≥0.78/≤0.22）时附加相邻数字作借位候选；联合枚举全局相位 δ（吸收照片 roll/表盘零位偏差）
 * 与整数位数字组合，使各盘量测针位尽量落在机械期望区间 [digit+(T mod m)/m, +1/m) 内——
 * ×1 盘区间宽 1（只约束整数位，小数 slack 天然吸收）。总分/单盘偏差超标 → null 拒识。
 */
function pointerChain(
  parts: PtrPart[],
  tenthRead: { digit: number; sharp: number; v: number; ang: number } | null,
): { value: string; confidence: number } | null {
  const ints = parts.filter((p) => p.mult >= 1).sort((a, b) => a.mult - b.mult); // ×1→×1000
  if (ints.length < 3) return null;
  const norm10 = (x: number) => ((x % 10) + 10) % 10;
  // v 到环上区间 [lo, lo+w) 的距离（内部→0）
  const segDev = (v: number, lo: number, w: number) => {
    const dIn = norm10(v - lo);
    return dIn < w ? 0 : Math.min(dIn - w, 10 - dIn);
  };
  const n = ints.length;
  type Sol = { score: number; maxDev: number; digits: number[]; delta: number };
  const box: { best: Sol | null } = { best: null };
  for (let delta = -30; delta <= 30; delta += 3) {
    const vs = ints.map((p) => norm10(p.ang / 36 - delta / 36));
    const cands = vs.map((v) => {
      const fl = ((Math.floor(v) % 10) + 10) % 10;
      const fr = v - Math.floor(v);
      const c = [fl];
      if (fr >= 0.78) c.push((fl + 1) % 10);
      if (fr <= 0.22) c.push((fl + 9) % 10);
      return c;
    });
    const dig = new Array<number>(n);
    const dfs = (i: number, t: number, score: number, mx: number) => {
      if (box.best && score >= box.best.score) return;
      if (i === n) {
        box.best = { score, maxDev: mx, digits: [...dig], delta };
        return;
      }
      const m = ints[i].mult;
      const lower = t / m; // 低位盘合计占本盘周期比例（t<m 恒成立）
      for (const d of cands[i]) {
        const dev = segDev(vs[i], norm10(d + lower), 1 / m);
        dig[i] = d;
        dfs(i + 1, t + d * m, score + dev, Math.max(mx, dev));
      }
    };
    dfs(0, 0, 0, 0);
    ptrDbg('cal-δ', { delta, cands });
  }
  const best = box.best;
  if (!best) return null;
  const avg = best.score / n;
  if (avg > 0.34 || best.maxDev > 0.56) {
    ptrDbg('chain-reject', { score: +best.score.toFixed(2), avg: +avg.toFixed(2), maxDev: +best.maxDev.toFixed(2), digits: best.digits, delta: best.delta });
    return null;
  }
  const intStr = ints
    .slice()
    .sort((a, b) => b.mult - a.mult)
    .map((p) => String(best.digits[ints.indexOf(p)]))
    .join('');
  let tenth: number | null = null;
  if (tenthRead) tenth = ((Math.floor(norm10((tenthRead.ang - best.delta) / 36)) % 10) + 10) % 10;
  else {
    const v1 = ints.find((p) => p.mult === 1);
    if (v1) {
      const f = norm10(v1.ang / 36 - best.delta / 36);
      tenth = Math.round((f - Math.floor(f)) * 10) % 10;
    }
  }
  const value = tenth != null ? `${intStr}.${tenth}` : intStr;
  const minSharp = Math.min(...parts.map((p) => p.sharp));
  const confidence = Math.round(Math.max(35, Math.min(85, 72 - best.score * 22 + Math.min(12, minSharp * 3))));
  ptrDbg('read', { intStr, tenth, value, conf: confidence, score: +best.score.toFixed(2), delta: best.delta });
  return { value, confidence };
}

/** OCR 文本框 → 刻度数字点 + 倍率标签 */
function pointerOcrParts(items: OcrResultItem[]): { digitPts: { v: number; cx: number; cy: number }[]; labels: { cx: number; cy: number; mult: number }[] } {
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
  return { digitPts, labels };
}

/** 刻度数字点角度回归判表盘顺/逆时针 */
function dialCw(digitPts: { v: number; cx: number; cy: number }[], cx: number, cy: number, r: number): boolean | null {
  const ring = digitPts.filter((d) => {
    const dist = Math.hypot(d.cx - cx, d.cy - cy);
    return dist > r * 0.45 && dist < r * 1.35;
  });
  if (ring.length < 4) return null;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const n = ring.length;
  const meanD = ring.reduce((s, d) => s + d.v, 0) / n;
  const meanT = ring.reduce((s, d) => s + ((Math.atan2(d.cx - cx, cy - d.cy) * 180) / Math.PI + 360) % 360, 0) / n;
  for (const d of ring) {
    const th = ((Math.atan2(d.cx - cx, cy - d.cy) * 180) / Math.PI + 360) % 360;
    const thu = th - Math.round((th - meanT) / 360) * 360;
    sxy += (d.v - meanD) * (thu - meanT);
    syy += (thu - meanT) * (thu - meanT);
    sxx += (d.v - meanD) * (d.v - meanD);
  }
  if (sxx > 1 && syy > 1) {
    const fit = sxy / Math.sqrt(sxx * syy);
    if (Math.abs(fit) > 0.6) return fit > 0;
  }
  return null;
}

/**
 * 指针表读数：Hough 圆检定位表盘 → 像素射线采样定指针角度 →
 * OCR 刻度数字回归判顺/逆时针 → 标签+列约定分配倍率 → 组合整数 + ×0.1 小数。
 * 不确定一律返回 null。
 */
function readPointerDialsGrid(items: OcrResultItem[], img: ImageData, edgeIn?: { w: number; h: number; edge: Uint8Array }): { value: string; confidence: number } | null {
  const { w, h, edge } = edgeIn ?? edgeMap(img);
  const scale = img.width / w;
  const circles = detectCircles(edge, w, h)
    .map((c) => ({ cx: c.cx * scale, cy: c.cy * scale, r: c.r * scale, cover: c.cover }))
    .filter((c) => c.r > 14 && c.r < img.width * 0.16);
  ptrDbg('circles', circles.map((c) => [Math.round(c.cx), Math.round(c.cy), Math.round(c.r), +c.cover.toFixed(2)]));
  if (circles.length < 4) return null;

  const px = makePx(img);
  const { digitPts, labels } = pointerOcrParts(items);

  const dials: PtrDial[] = [];
  for (const c of circles) {
    const ring = digitPts.filter((d) => {
      const dist = Math.hypot(d.cx - c.cx, d.cy - c.cy);
      return dist > c.r * 0.45 && dist < c.r * 1.25;
    });
    if (ring.length < 3 && !(c.r >= img.width * 0.05 && c.cover >= 0.45)) continue;
    dials.push({ ...c, mult: null, cw: dialCw(digitPts, c.cx, c.cy, c.r) });
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
      dec01Dial = { cx: l01.cx, cy: l01.cy - rMed * 1.25, r: rMed, mult: 0.1, cw: null };
      ptrDbg('synthetic-0.1', { cx: Math.round(l01.cx), cy: Math.round(l01.cy - rMed * 1.25), r: Math.round(rMed) });
    }
  }
  const intDials = members.filter((d) => d.mult != null && d.mult >= 1);
  const need = [1000, 100, 10, 1];
  ptrDbg('mult', members.map((d) => [d.mult, Math.round(d.cx), Math.round(d.cy)]));
  if (!need.every((k) => intDials.some((d) => d.mult === k))) return null;

  const parts = intDials
    .filter((d) => need.includes(d.mult!))
    .map((d) => ({ mult: d.mult!, ...readNeedle(px, d) }))
    .sort((a, b) => b.mult - a.mult);
  const tenthRead = dec01Dial ? readNeedle(px, dec01Dial) : null;
  return pointerChain(parts, tenthRead);
}


/**
 * 表盘环路径：指针表盘环绕表心一圈，沿顺时针方向每步倍率 ÷10
 *（×1→×0.1→×0.01→×0.001→×0.0001→×1000→×100→×10→回 ×1）。
 * 流程：圆检候选 → 同中心去重 → 轴对齐椭圆拟合（抗倾斜投影）→ 归一化角排序 →
 * 等角槽位补齐缺失盘 → 倍率标签/红黑色弧锚定 → 针角采样 → 机械链裁决。
 * 任一环节不确定 → null（调用方回退网格路径）。
 */
async function readPointerDialsRing(
  items: OcrResultItem[],
  img: ImageData,
  edgeIn?: { w: number; h: number; edge: Uint8Array },
): Promise<{ value: string; confidence: number } | null> {
  ptrDbg('ring:enter');
  let cv: any;
  try {
    cv = await getCv();
  } catch (e) {
    ptrDbg('ring:opencv-unavailable', (e as Error).message);
    return null;
  }
  ptrDbg('ring:cv-ready');
  const { w, h, edge } = edgeIn ?? edgeMap(img);
  const scale = img.width / w;
  const px = makePx(img);
  const circles = detectCircles(edge, w, h)
    .map((c) => ({ cx: c.cx * scale, cy: c.cy * scale, r: c.r * scale, cover: c.cover }))
    .filter((c) => c.r > 11 && c.r < img.width * 0.16);
  ptrDbg('r-circles', circles.map((c) => [Math.round(c.cx), Math.round(c.cy), Math.round(c.r), +c.cover.toFixed(2)]));
  if (circles.length < 5) return null;

  // 同中心合并：毂部小圆若落在某大圆内则是同一表盘
  const byR = [...circles].sort((a, b) => b.r - a.r);
  const cands: typeof circles = [];
  for (const c of byR) {
    if (cands.some((k) => Math.hypot(k.cx - c.cx, k.cy - c.cy) < Math.max(k.r, c.r) * 0.55)) continue;
    cands.push(c);
  }
  if (cands.length < 5) return null;

  // 离群剔除 ①：环内杂点（中央齿轮/星形件）—— 到质心距离 < 中位距 0.45
  const cx0 = [...cands].sort((p, q) => p.cx - q.cx)[Math.floor(cands.length / 2)].cx;
  const cy0 = [...cands].sort((p, q) => p.cy - q.cy)[Math.floor(cands.length / 2)].cy;
  const dists = cands.map((c) => Math.hypot(c.cx - cx0, c.cy - cy0)).sort((a, b) => a - b);
  const dMed = dists[Math.floor(dists.length / 2)];
  const near = cands.filter((c) => Math.hypot(c.cx - cx0, c.cy - cy0) > dMed * 0.45);

  // 离群剔除 ②：证据加权 NMS —— 真表盘中心必有深色针毂或红针；空白板上的假圆没有。
  // 分高的先占坑，0.6·盘距内的低分候选剔除。
  const rBigs = near.map((c) => c.r).filter((r) => r > img.width * 0.04).sort((a, b) => a - b);
  const rBig = rBigs[Math.floor(rBigs.length / 2)] ?? Math.max(...near.map((c) => c.r));
  const minSep = Math.max(40, rBig * 2.6);
  const scored = near
    .map((c) => {
      // 中心毂区暗/红占比 + 局部底版亮度自适应
      const rr = c.r * 0.38;
      let dark = 0;
      let reds = 0;
      let tot = 0;
      const bg: number[] = [];
      for (let y = Math.floor(c.cy - c.r * 1.7); y <= c.cy + c.r * 1.7; y += 2) {
        for (let x = Math.floor(c.cx - c.r * 1.7); x <= c.cx + c.r * 1.7; x += 2) {
          const dd = Math.hypot(x - c.cx, y - c.cy);
          if (dd > c.r * 1.25 && dd < c.r * 1.7) {
            const [pr, pg, pb] = px(x, y);
            bg.push(pr * 0.3 + pg * 0.5 + pb * 0.2);
          }
          if (dd <= rr) {
            tot++;
            const [pr, pg, pb] = px(x, y);
            if (pr * 0.3 + pg * 0.5 + pb * 0.2 < 90) dark++;
            if (pr - pg > 30 && pr - pb > 15 && pr > 80) reds++;
          }
        }
      }
      bg.sort((a, b) => a - b);
      const bgMed = bg[Math.floor(bg.length / 2)] ?? 120;
      void bgMed;
      const score = dark / (tot || 1) + (reds / (tot || 1)) * 1.6 + c.cover * 0.15;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
  let keep: typeof circles = [];
  for (const s of scored) {
    if (keep.some((k) => Math.hypot(k.cx - s.c.cx, k.cy - s.c.cy) < minSep * 0.6)) continue;
    keep.push(s.c);
    if (keep.length >= 9) break;
  }
  ptrDbg('keep', keep.map((c) => [Math.round(c.cx), Math.round(c.cy), Math.round(c.r)]));
  if (keep.length < 4) return null;

  // ---- cv.fitEllipse 倾斜校正：盘心点集 → 旋转椭圆（RANSAC 抗离群）----
  if (keep.length < 5) return null;
  const sane = (e: DialEllipse | null) =>
    !!e &&
    Math.min(e.aw, e.ah) > img.width * 0.1 &&
    Math.max(e.aw, e.ah) < img.width * 0.75 &&
    Math.min(e.aw, e.ah) / Math.max(e.aw, e.ah) > 0.4; // 倾角 <~66°
  const inliersOf = (e: DialEllipse, cs: typeof keep) =>
    cs.filter((c) => {
      const [u, v] = ellNorm(e, c.cx, c.cy);
      return Math.abs(Math.hypot(u, v) - 1) < 0.14;
    });
  let best: { ell: DialEllipse; inl: typeof keep } | null = null;
  const tries = keep.length <= 8 ? 120 : 200;
  for (let t = 0; t < tries; t++) {
    const sample = [...keep].sort(() => Math.random() - 0.5).slice(0, 5);
    const e = cvFitEllipse(cv, sample);
    if (!sane(e)) continue;
    const inl = inliersOf(e!, keep);
    if (!best || inl.length > best.inl.length) best = { ell: e!, inl };
  }
  // 内点角度覆盖检验：拟合椭圆要求内点大致环绕整圈（最大顺时角隙 <160°）
  const maxGap = (e: DialEllipse, cs: typeof keep) => {
    const ths = cs.map((c) => ellTheta(e, c.cx, c.cy)).sort((a, b) => a - b);
    let g = 0;
    for (let i = 0; i < ths.length; i++) g = Math.max(g, (ths[(i + 1) % ths.length] - ths[i] + 360) % 360);
    return g;
  };
  if (best && (best.inl.length < 5 || !sane(best.ell) || maxGap(best.ell, best.inl) > 160)) best = null;
  let ell: DialEllipse | null = null;
  if (best) {
    const e2 = cvFitEllipse(cv, best.inl);
    ell = sane(e2) ? e2 : best.ell;
    keep = best.inl;
  }
  if (!ell) {
    ptrDbg('ring-fit', 'failed');
    return null; // 无倾斜校正 → 拒识（不再退质心坐标系硬读）
  }
  const E = ell;
  ptrDbg('ring-fit', { cx: Math.round(E.cx), cy: Math.round(E.cy), aw: Math.round(E.aw), ah: Math.round(E.ah), deg: Math.round((E.phi * 180) / Math.PI), n: keep.length });
  const onRing = keep
    .map((c) => {
      const [u, v] = ellNorm(E, c.cx, c.cy);
      return { c, rn: Math.hypot(u, v), th: ellTheta(E, c.cx, c.cy) };
    })
    .sort((a, b) => a.th - b.th);
  ptrDbg('onRing', onRing.map((e) => [Math.round(e.c.cx), Math.round(e.c.cy), Math.round(e.th), +e.rn.toFixed(2)]));
  if (onRing.length < 4) return null;

  // 同槽多检去重（角距 <14°）
  const pts: typeof onRing = [];
  for (const e of onRing) {
    const last = pts[pts.length - 1];
    if (last && e.th - last.th < 14) {
      if (e.c.r > last.c.r) pts[pts.length - 1] = e;
      continue;
    }
    pts.push(e);
  }
  if (pts.length > 1 && pts[0].th + 360 - pts[pts.length - 1].th < 14) {
    if (pts[pts.length - 1].c.r > pts[0].c.r) pts.shift();
    else pts.pop();
  }
  if (pts.length < 4) return null;

  // ---- 倍率环序锚定：标签钉绝对位，颜色沿钉整数/小数边界，锚点间步差决定隐藏盘 ----
  const { digitPts, labels } = pointerOcrParts(items);
  const rReal = pts.map((e) => e.c.r).filter((r) => r > img.width * 0.04).sort((a, b) => a - b);
  const rMed = rReal[Math.floor(rReal.length / 2)] ?? 28;
  const redFracOf = (cx: number, cy: number, r: number) => {
    let reds = 0;
    let total = 0;
    const rr = r * 0.6;
    for (let y = Math.floor(cy - rr); y <= cy + rr; y += 1) {
      for (let x = Math.floor(cx - rr); x <= cx + rr; x += 1) {
        if (Math.hypot(x - cx, y - cy) > rr) continue;
        total++;
        const [pr, pg, pb] = px(x, y);
        if (pr - pg > 30 && pr - pb > 15 && pr > 80) reds++;
      }
    }
    return total ? reds / total : 0;
  };
  // 盘序：θ 升序（顺时针）逐一走，每步倍率 ÷10
  interface Slot {
    cx: number;
    cy: number;
    th: number;
    real: (typeof circles)[number] | null;
    idx: number; // seqIdx（相对标准 8 环）
    redFrac: number;
    cw: boolean | null;
  }
  const dials = pts.map((e) => ({ c: e.c, th: e.th }));
  for (const d of dials) (d as any).redFrac = redFracOf(d.c.cx, d.c.cy, d.c.r > rMed * 0.6 ? d.c.r : rMed);
  ptrDbg('dial-colors', dials.map((d) => [Math.round(d.th), (d as any).redFrac > 0.05 ? 'R' : (d as any).redFrac < 0.02 ? 'B' : '?']));

  // 环序候选：标准 8 盘 → 7 盘（无×0.0001）→ 6 盘（无×0.001），取首个锚点自洽方案
  const SEQ_CANDIDATES = [
    [1, 0.1, 0.01, 0.001, 0.0001, 1000, 100, 10],
    [1, 0.1, 0.01, 0.001, 1000, 100, 10],
    [1, 0.1, 0.01, 1000, 100, 10],
  ];
  interface Anchor { th: number; idx: number; kind: string }
  const color = dials.map((d) => ((d as any).redFrac > 0.05 ? 'R' : (d as any).redFrac < 0.02 ? 'B' : '?'));
  const nD = dials.length;
  const trySeq = (SEQ: number[]): { slots: Slot[]; anchors: Anchor[] } | null => {
    const N = SEQ.length;
    const idx1000 = SEQ.indexOf(1000);
    const anchors: Anchor[] = [];
    const usedDial = new Set<number>();
    for (const l of labels) {
      const idx = SEQ.indexOf(l.mult);
      if (idx < 0) continue;
      const near = dials
        .map((d, i) => ({ i, dist: Math.hypot(d.c.cx - l.cx, d.c.cy - l.cy) }))
        .filter((e) => e.dist < rMed * 2.0 && !usedDial.has(e.i))
        .sort((a, b) => a.dist - b.dist)[0];
      if (!near) continue;
      usedDial.add(near.i);
      anchors.push({ th: dials[near.i].th, idx, kind: `label:${l.mult}` });
    }
    // 颜色沿：B→R 边界 = ×1→×0.1（前盘 idx0）；R→B = ×0.001→×1000（后盘 idx1000）
    for (let i = 0; i < nD; i++) {
      const a = color[i];
      const b2 = color[(i + 1) % nD];
      if (a === 'B' && b2 === 'R') anchors.push({ th: dials[i].th, idx: 0, kind: 'color:BR' });
      else if (a === 'R' && b2 === 'B') anchors.push({ th: dials[(i + 1) % nD].th, idx: idx1000, kind: 'color:RB' });
    }
    anchors.sort((a, b) => a.th - b.th);
    // 同位锚点合并：θ 相同的锚须 idx 一致；冲突时保留 label，双 label/双 color 冲突→矛盾
    const merged: Anchor[] = [];
    for (const a of anchors) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(a.th - prev.th) < 3) {
        if (prev.idx === a.idx) continue;
        const pL = prev.kind.startsWith('label');
        const aL = a.kind.startsWith('label');
        if (pL !== aL) {
          if (aL) merged[merged.length - 1] = a;
          continue;
        }
        return null;
      }
      merged.push(a);
    }
    if (merged.length < 2) return null;

    // 一致性：相邻锚点步差 d 须 ≥ 其间已检盘数+1，且均分步距 ≥18°（过挤=锚点矛盾）
    const slots: Slot[] = [];
    const seenIdx = new Set<number>();
    for (let i = 0; i < anchors.length; i++) {
      const a1 = anchors[i];
      const a2 = anchors[(i + 1) % anchors.length];
      const d = ((a2.idx - a1.idx) % N + N) % N || N;
      const g = (a2.th - a1.th + 360) % 360;
      if (g / d < 18) return null;
      const inGap = dials.filter((dd) => {
        const rel = (dd.th - a1.th + 360) % 360;
        return rel > 1e-6 && rel < g;
      });
      if (d < inGap.length + 1) return null;
      const taken = new Set<number>();
      for (const dd of inGap) {
        const step = Math.max(1, Math.min(d - 1, Math.round(((dd.th - a1.th + 360) % 360) / (g / d))));
        taken.add(step);
        const idx = (a1.idx + step) % N;
        if (seenIdx.has(idx)) return null;
        seenIdx.add(idx);
        slots.push({ cx: dd.c.cx, cy: dd.c.cy, th: dd.th, real: dd.c, idx, redFrac: (dd as any).redFrac, cw: null });
      }
      const synthN = d - 1 - inGap.length;
      for (let s = 1; s <= synthN; s++) {
        let step = s;
        while (taken.has(step)) step++;
        taken.add(step);
        const idx = (a1.idx + step) % N;
        if (seenIdx.has(idx)) return null;
        seenIdx.add(idx);
        const th = a1.th + (g * step) / d;
        const [cx, cy] = ellPoint(E, th);
        slots.push({ cx, cy, th: th % 360, real: null, idx, redFrac: redFracOf(cx, cy, rMed), cw: null });
        ptrDbg('synth-slot', { idx, th: Math.round(th % 360), cx: Math.round(cx), cy: Math.round(cy) });
      }
      const ra = dials.filter((dd) => Math.abs(dd.th - a1.th) < 0.5)[0];
      if (seenIdx.has(a1.idx)) return null;
      seenIdx.add(a1.idx);
      if (ra) slots.push({ cx: ra.c.cx, cy: ra.c.cy, th: ra.th, real: ra.c, idx: a1.idx, redFrac: (ra as any).redFrac, cw: null });
      else {
        const [cx, cy] = ellPoint(E, a1.th);
        slots.push({ cx, cy, th: a1.th, real: null, idx: a1.idx, redFrac: redFracOf(cx, cy, rMed), cw: null });
      }
    }
    if (slots.length !== N) return null; // 槽位总数须正好一环
    return { slots, anchors };
  };
  let SEQ = SEQ_CANDIDATES[0];
  let anchored: { slots: Slot[]; anchors: Anchor[] } | null = null;
  for (const cand of SEQ_CANDIDATES) {
    anchored = trySeq(cand);
    if (anchored) {
      SEQ = cand;
      break;
    }
  }
  if (!anchored) return null;
  const { slots, anchors } = anchored;
  ptrDbg('anchors', anchors.map((a) => [a.kind, 'th', Math.round(a.th), 'idx', a.idx]));
  ptrDbg('slots', slots.map((s) => ['idx' + s.idx, 'th' + Math.round(s.th), 'mult' + SEQ[s.idx], s.real ? 'real' : 'synth']));

  for (const s of slots) {
    const r = s.real && s.real.r > rMed * 0.6 ? s.real.r : rMed;
    s.cw = dialCw(digitPts, s.cx, s.cy, r);
  }

  const needInt = [1000, 100, 10, 1].filter((k) => SEQ.includes(k));
  const readSlots = slots.filter((s) => needInt.includes(SEQ[s.idx]) || SEQ[s.idx] === 0.1);
  if (!needInt.every((k) => readSlots.some((s) => SEQ[s.idx] === k))) return null;

  const reads: { mult: number; ang: number; sharp: number; synth: boolean }[] = [];
  for (const s of readSlots) {
    const mult = SEQ[s.idx];
    const r = s.real && s.real.r > rMed * 0.6 ? s.real.r : rMed;
    const rd = readNeedle(px, { cx: s.cx, cy: s.cy, r, cw: s.cw, mult });
    if (rd.sharp < 1.04) {
      ptrDbg('needle-weak', { mult, sharp: +rd.sharp.toFixed(2) });
      if (mult >= 1) return null; // 整数位读不出 → 拒识
      continue;
    }
    reads.push({ mult, ang: rd.ang, sharp: rd.sharp, synth: !s.real });
  }
  // ---- 机械链枚举裁决：δ相位×逐位取整组合联合搜索（详见 pointerChain）----
  const intReads = reads.filter((r) => r.mult >= 1);
  const tenthRead0 = reads.find((r) => r.mult === 0.1) ?? null;
  const parts: PtrPart[] = intReads.map((r) => {
    const v = ((r.ang / 36) % 10 + 10) % 10;
    return { mult: r.mult, digit: Math.floor(v) % 10, sharp: r.sharp, v, ang: r.ang };
  });
  const out = pointerChain(parts, tenthRead0 && tenthRead0.sharp >= 1.15
    ? { digit: 0, sharp: tenthRead0.sharp, v: 0, ang: tenthRead0.ang }
    : null);
  if (!out) return null;
  const synthCnt = readSlots.filter((s) => !s.real).length;
  const anchoredByLabel = anchors.some((a) => a.kind.startsWith('label'));
  const conf = Math.round(out.confidence - synthCnt * 6 - (anchoredByLabel ? 0 : 6));
  return { value: out.value, confidence: Math.max(30, conf) };
}

/** 指针表读数分发：优先环模型（cv 倾斜校正/缺盘合成），失败回退网格路径 */
async function readPointerDials(
  items: OcrResultItem[],
  img: ImageData,
  edgeIn?: { w: number; h: number; edge: Uint8Array },
): Promise<{ value: string; confidence: number } | null> {
  const ring = await readPointerDialsRing(items, img, edgeIn);
  if (ring) return ring;
  return readPointerDialsGrid(items, img, edgeIn);
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
    const pointer = await readPointerDials(res.items, imgData);
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
  await readPointerDials(res.items, imgData);
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

/** Node 侧调试：注入预计算边缘图跑指针读数全链路（仅测试用） */
export function __debugPointerRead(
  items: OcrResultItem[],
  img: ImageData,
  edge: { w: number; h: number; edge: Uint8Array },
): Promise<{ value: string; confidence: number } | null> {
  return readPointerDials(items, img, edge);
}
