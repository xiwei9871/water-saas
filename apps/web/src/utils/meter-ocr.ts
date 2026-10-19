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
  method: 'paddle-roller';
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

/**
 * 识别表底照片中的字轮整数读数。
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
  if (!picked) return null;
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
