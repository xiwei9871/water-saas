import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import {
  composePointerInteger,
  detectCircles,
  digitWindowX,
  findDigitBands,
  pointerPosition,
  redSplitX,
  type Box,
  type GrayImage,
  type RgbImage,
} from './image-utils.js';

export type MeterOcrMethod = 'roller' | 'pointer' | 'llm' | 'none';

export interface MeterOcrResult {
  /** Suggested dial reading as a decimal string, or null when unreadable. */
  value: string | null;
  confidence: number;
  method: MeterOcrMethod;
  /** integer-part digit count used (roller) or dial count (pointer). */
  details: {
    candidates: Array<{ text: string; conf: number; band: number }>;
    dials?: Array<{ x: number; y: number; r: number; pos: number }>;
    redBoundary?: boolean;
    flags: string[];
  };
  /** Human-readable hint for the operator UI. */
  message?: string;
}

const DIGIT_WHITELIST = '0123456789';
const MIN_DIGITS = 4;
/** Residential DN15 plates carry ≤6 integer wheels; longer runs are serials/barcodes. */
const MAX_INT_DIGITS = 6;
const TARGET_HEIGHT = 140; // band crop normalize height
const TIMEOUT_MS = 25_000;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('OCR_TIMEOUT')), ms)),
  ]);

/**
 * Non-LLM meter-dial recognition.
 * Path 1 (roller): horizontal digit-strip detection → digits-whitelist OCR
 * → red decimal-wheel boundary split.
 * Path 2 (pointer): Hough circle dials → needle-angle → ×1/×10/×100/×1000
 * left-column composition (standard LXSC plate layout, inferred — low
 * confidence by design).
 * Output is advisory only: operators always confirm before submit.
 */
@Injectable()
export class MeterOcrService implements OnModuleDestroy {
  private readonly logger = new Logger(MeterOcrService.name);
  private workerPromise: Promise<Worker> | null = null;
  private disabled = process.env.METER_OCR === 'off';

  private tessdataDir(): string {
    return process.env.TESSDATA_DIR ?? join(process.cwd(), 'tessdata');
  }

  private async worker(): Promise<Worker> {
    if (!this.workerPromise) {
      this.workerPromise = createWorker('eng', undefined, {
        langPath: this.tessdataDir(),
        cacheMethod: 'none',
        gzip: false,
      });
      this.workerPromise.catch((err) => {
        this.logger.warn(`tesseract worker init failed: ${String(err)}`);
        this.workerPromise = null;
      });
    }
    return this.workerPromise;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.workerPromise) {
      const w = await this.workerPromise.catch(() => null);
      await w?.terminate().catch(() => undefined);
      this.workerPromise = null;
    }
  }

  /** Entry point — `dataUrl` is the mobile client's compressed jpeg. */
  async recognize(dataUrl: string, prev?: number): Promise<MeterOcrResult> {
    if (this.disabled) {
      return this.empty('OCR_DISABLED', '识别模块已停用，请人工读数');
    }
    let local: MeterOcrResult;
    try {
      local = await withTimeout(this.pipeline(dataUrl), TIMEOUT_MS);
    } catch (err) {
      this.logger.warn(`meter ocr failed: ${String(err)}`);
      local = this.empty(
        err instanceof Error && err.message === 'OCR_TIMEOUT' ? 'OCR_TIMEOUT' : 'OCR_FAILED',
        '照片识别失败，请人工读数',
      );
    }
    // 本地结果足够可信直接返回；低置信/拒识 → 多模态 LLM 兜底（若已配置）
    if (local.value !== null && local.confidence >= 70) return local;
    const llm = await this.tryLlm(dataUrl, prev).catch((err) => {
      this.logger.warn(`meter ocr llm failed: ${String(err)}`);
      return null;
    });
    if (llm) return llm;
    // LLM 不可用时只余弱本地推断：压置信度到预填阈值（55）以下，避免错值自动入框
    if (local.value !== null && local.method === 'pointer' && local.confidence < 70) {
      local.confidence = Math.min(local.confidence, 50);
    }
    return local;
  }

  private empty(flag: string, message: string): MeterOcrResult {
    return { value: null, confidence: 0, method: 'none', details: { candidates: [], flags: [flag] }, message };
  }

  private async pipeline(dataUrl: string): Promise<MeterOcrResult> {
    const img = sharp(Buffer.from(dataUrl, 'base64'), { failOn: 'error' }).rotate();
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return this.empty('IMAGE_INVALID', '图片无法解析，请人工读数');

    const resized = img.clone().resize({ width: 1500, withoutEnlargement: true });
    const [{ data: rgbData, info: rgbInfo }, { data: grayData, info: grayInfo }, pngBuf] =
      await Promise.all([
        resized.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true }),
        resized.clone().greyscale().normalise().raw().toBuffer({ resolveWithObject: true }),
        resized.clone().png().toBuffer(),
      ]);
    const rgb: RgbImage = { data: rgbData, width: rgbInfo.width, height: rgbInfo.height };
    const gray: GrayImage = { data: grayData, width: grayInfo.width, height: grayInfo.height };

    // Classify first: ≥6 dial circles means a pure pointer plate — serials
    // and labels there mimic digit strips and would fool the roller path.
    const small = resized.clone().resize({ width: 750, withoutEnlargement: true });
    const [{ data: sRgb, info: sRgbI }, { data: sGray, info: sGrayI }] = await Promise.all([
      small.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      small.clone().greyscale().normalise().raw().toBuffer({ resolveWithObject: true }),
    ]);
    const sGrayI_ = { data: sGray, width: sGrayI.width, height: sGrayI.height };
    const sRgb_ = { data: sRgb, width: sRgbI.width, height: sRgbI.height };
    const circles = detectCircles(sGrayI_, { limit: 12 });
    // Strong circles only — a real pointer plate has many large dials whose
    // rims vote heavily; mixed meters' tiny sub-dials / noise stay weak.
    const strong = circles.filter((c) => c.score >= 20);
    if (strong.length >= 6) return this.tryPointer(sGrayI_, sRgb_);

    const roller = await this.tryRoller(pngBuf, gray, rgb);
    if (roller) return roller;

    return this.tryPointer(sGrayI_, sRgb_);
  }

  /* ---------- path 1: roller window ---------- */

  private async ocrDigits(worker: Worker, buf: Buffer): Promise<Array<{
    text: string;
    conf: number;
    symbols: Array<{ text: string; x0: number; x1: number }>;
  }>> {
    const r = await worker.recognize(buf, {}, { blocks: true });
    const out: Array<{ text: string; conf: number; symbols: Array<{ text: string; x0: number; x1: number }> }> = [];
    for (const b of r.data.blocks ?? []) {
      for (const p of b.paragraphs ?? []) {
        for (const l of p.lines ?? []) {
          for (const w of l.words ?? []) {
            const symbols = (w.symbols ?? [])
              .filter((s) => /\d/.test(s.text))
              .map((s) => ({ text: s.text, x0: s.bbox.x0, x1: s.bbox.x1 }))
              .sort((a, b) => a.x0 - b.x0);
            if (symbols.length >= MIN_DIGITS) {
              out.push({ text: symbols.map((s) => s.text).join(''), conf: w.confidence ?? 0, symbols });
            }
          }
        }
      }
    }
    return out;
  }

  private async tryRoller(
    pngBuf: Buffer,
    gray: GrayImage,
    rgb: RgbImage,
  ): Promise<MeterOcrResult | null> {
    const bands = findDigitBands(gray, 3);
    if (bands.length === 0) return null;

    let worker: Worker;
    try {
      worker = await this.worker();
    } catch {
      return this.empty('OCR_UNAVAILABLE', '识别组件不可用，请人工读数');
    }
    await worker.setParameters({
      tessedit_char_whitelist: DIGIT_WHITELIST,
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
    });

    interface Cand {
      value: string;
      conf: number;
      text: string;
      bandIdx: number;
      red: boolean;
      flags: string[];
    }
    const cands: Cand[] = [];
    const rawSeen: Array<{ text: string; conf: number; band: number }> = [];

    for (const [bandIdx, band] of bands.entries()) {
      const scale = TARGET_HEIGHT / band.height;
      const win = digitWindowX(gray, band);
      // The decimal wheel often sits slightly below the detected strip —
      // scan for the red boundary on a vertically-expanded band.
      const redX = redSplitX(
        rgb,
        { ...band, height: Math.min(gray.height - band.top, Math.round(band.height * 2.6)) },
        win ?? { x0: Math.round(gray.width * 0.15), x1: Math.round(gray.width * 0.85) },
      );
      // Two x-crops per band: the detected window (when found) and the
      // central 70% strip — whichever yields higher-conf digits wins.
      const xBoxes: Array<{ x0: number; x1: number }> = [];
      if (win) xBoxes.push(win);
      const c70 = { x0: Math.round(gray.width * 0.15), x1: Math.round(gray.width * 0.85) };
      if (!win || Math.abs(win.x0 - c70.x0) + Math.abs(win.x1 - c70.x1) > 40) {
        xBoxes.push(c70);
      }

      for (const { x0: cx0, x1: cx1 } of xBoxes) {
        const cropBase = sharp(pngBuf)
          .extract({ left: cx0, top: band.top, width: cx1 - cx0, height: band.height })
          .resize({ height: TARGET_HEIGHT })
          .greyscale()
          .normalise();

        const variants = [cropBase.clone(), cropBase.clone().negate().normalise()];
        // Dark night-reading bands get a gamma-lifted third variant.
        let bandMean = 0;
        for (let y = band.top; y < band.top + band.height && y < gray.height; y++) {
          for (let x = cx0; x < cx1; x++) bandMean += gray.data[y * gray.width + x];
        }
        bandMean /= Math.max(1, band.height * (cx1 - cx0));
        variants.push(
          bandMean < 115
            ? cropBase.clone().gamma(2.2).normalise()
            : cropBase.clone().threshold(150),
        );
        const psms = [PSM.SPARSE_TEXT, PSM.SINGLE_LINE];

        for (const variant of variants) {
          for (const psm of psms) {
            await worker.setParameters({
              tessedit_char_whitelist: DIGIT_WHITELIST,
              tessedit_pageseg_mode: psm,
            });
            const png = await variant.png().toBuffer();
            for (const w of await this.ocrDigits(worker, png)) {
              rawSeen.push({ text: w.text, conf: w.conf, band: bandIdx });
              // symbol x → image x: crop offset + undo height-normalize scale
              const imgX = (s: { x0: number; x1: number }) =>
                cx0 + (s.x0 + s.x1) / 2 / scale;
              let intSyms = w.symbols;
              let decSyms: typeof w.symbols = [];
              let red = redX !== null;
              if (redX !== null) {
                const cut = w.symbols.findIndex((s) => imgX(s) >= redX);
                if (cut > 0) {
                  intSyms = w.symbols.slice(0, cut);
                  decSyms = w.symbols.slice(cut);
                }
              }
              const flags: string[] = [];
              if (red && decSyms.length === 0) flags.push('decimal_wheel_dropped');
              // ≥4 wheels total (int+dec); the integer side may shrink to
              // 3 when the red split peels off the last digit.
              if (intSyms.length + decSyms.length < MIN_DIGITS || intSyms.length === 0) continue;
              if (intSyms.length > MAX_INT_DIGITS + 1) continue;
              let conf = w.conf;
              if (intSyms.length > MAX_INT_DIGITS && !red) {
                flags.push('long_digit_run');
                conf *= 0.55;
              }
              if (!red && intSyms.length > 4) {
                flags.push('no_red_boundary');
                conf *= 0.8;
              }
              const intPart = intSyms.map((s) => s.text).join('').replace(/^0+(?=\d)/, '');
              const decPart = decSyms.map((s) => s.text).join('');
              cands.push({
                value: decPart ? `${intPart}.${decPart}` : intPart,
                conf,
                text: w.text,
                bandIdx,
                red,
                flags,
              });
            }
          }
        }
      }
    }

    if (cands.length === 0) return null;
    cands.sort((a, b) => b.conf - a.conf);
    const best = cands[0];
    return {
      value: best.value,
      confidence: Math.min(99, Math.round(best.conf)),
      method: 'roller',
      details: {
        candidates: rawSeen.slice(0, 12),
        redBoundary: best.red,
        flags: best.flags,
      },
      message: best.conf < 55 ? '识别置信度低，请仔细核对' : undefined,
    };
  }

  /* ---------- path 3: multimodal LLM fallback ---------- */

  private llmCfg(): { baseUrl: string; apiKey: string; model: string } | null {
    const baseUrl = process.env.METER_OCR_LLM_BASE_URL?.trim();
    const apiKey = process.env.METER_OCR_LLM_API_KEY?.trim();
    if (!baseUrl || !apiKey) return null;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      model: process.env.METER_OCR_LLM_MODEL?.trim() || 'gpt-6.1-sol',
    };
  }

  /**
   * 多模态 LLM 兜底：仅当本地管线拒识/低置信且已配置 METER_OCR_LLM_* 时调用。
   * 结果仍要过机械联动校验（各整数盘的 fractional 位置必须与同一总数自洽），
   * 不一致只降置信不拒识——本端点是建议性输出，人工总会确认。
   */
  private async tryLlm(dataUrl: string, prev?: number): Promise<MeterOcrResult | null> {
    const cfg = this.llmCfg();
    if (!cfg) return null;
    const jpeg = await sharp(Buffer.from(dataUrl, 'base64'), { failOn: 'error' })
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const prompt =
      '这是一张指针式或字轮式水表照片。指针表每个小表盘下方标有倍率' +
      '（×1000、×100、×10、×1、×0.1、×0.01等），表盘印有0-9十个数字，' +
      '指针落在某两个数字之间。请对每个整数位盘（×1000/×100/×10/×1）和×0.1盘' +
      '判断指针落在哪两个数字之间，报"下限数字.位置"（如在2和3之间偏下报2.4），' +
      '并用机械联动规则交叉验证（×1盘的小数部分等于总读数的小数部分）。' +
      '若是字轮表直接读黑色整数轮。只输出JSON：' +
      '{"x1000":n.n,"x100":n.n,"x10":n.n,"x1":n.n,"x01":n.n,"total":"XXXX.X"}。';
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(75_000),
    });
    if (!r.ok) {
      this.logger.warn(`llm ocr http ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content ?? '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
    const num = (k: string): number | null => {
      const v = Number(parsed[k]);
      return Number.isFinite(v) && v >= 0 && v < 10 ? v : null;
    };
    const d1000 = num('x1000');
    const d100 = num('x100');
    const d10 = num('x10');
    const d1 = num('x1');
    const d01 = num('x01');
    const total = typeof parsed.total === 'string' ? parsed.total.trim() : '';
    if (d1000 === null && d100 === null && d10 === null && d1 === null) {
      // 字轮表回答：total 即整数
      const t = total.match(/^(\d+)(?:\.(\d))?/);
      if (!t) return null;
      const intPart = t[1].replace(/^0+(?=\d)/, '');
      if (intPart.length > MAX_INT_DIGITS) return null;
      return {
        value: t[2] ? `${t[1]}.${t[2]}` : t[1],
        confidence: 72,
        method: 'llm',
        details: { candidates: [], flags: ['LLM_ROLLER'] },
        message: 'AI 辅助识别结果，请人工核对',
      };
    }
    if (d1000 === null || d100 === null || d10 === null || d1 === null) return null;
    // 机械链校验：整数位取 floor，小数部分须等于 (T mod m)/m
    const baseDigits = [d1000, d100, d10, d1].map(Math.floor);
    let intStr = baseDigits.join('');
    const tenth = d01 !== null ? Math.floor(d01) : Math.floor((d1 % 1) * 10 + 0.5) % 10;
    const flags: string[] = [];
    // 上期止度约束：仅当逐盘推导的读数相对上期"不合理"（回退或用量跳变超上限）
    // 时，枚举各整数位 ±1 翻位取可行域内离上期最近的读数——修正 LLM 把整位
    // 读错一格的情况（9→0 边界尤甚）。base 已合理时不动，避免上期值拉歪真值。
    if (typeof prev === 'number' && Number.isFinite(prev) && prev >= 0) {
      const cap = Math.max(500, prev * 0.5); // 期用量上限：居民远小于此，异常跳变判不合理
      const baseT = Number(intStr) + tenth / 10;
      const plausible = baseT >= prev - 0.05 && baseT - prev <= cap;
      if (!plausible) {
        const mults = [1000, 100, 10, 1];
        let bestT = baseT;
        let bestDist = Infinity;
        for (let m0 = -1; m0 <= 1; m0++)
          for (let m1 = -1; m1 <= 1; m1++)
            for (let m2 = -1; m2 <= 1; m2++)
              for (let m3 = -1; m3 <= 1; m3++) {
                const sh = [m0, m1, m2, m3];
                let t = tenth / 10;
                for (let i = 0; i < 4; i++) {
                  // 表盘数字 0-9 环形：9+1 回绕为 0，0-1 回绕为 9
                  const dg = (baseDigits[i] + sh[i] + 10) % 10;
                  t += dg * mults[i];
                }
                if (t < prev - 0.05 || t - prev > cap) continue;
                const dist = Math.abs(t - prev);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestT = t;
                }
              }
        const altStr = String(Math.floor(bestT)).padStart(intStr.length, '0');
        if (altStr !== intStr && Number.isFinite(bestDist)) {
          flags.push('LLM_PREV_ADJUSTED');
          intStr = altStr;
        } else {
          flags.push('LLM_IMPLAUSIBLE');
        }
      }
    }
    const T = Number(intStr) + tenth / 10;
    let mism = 0;
    for (const [v, m] of [[d1000, 1000], [d100, 100], [d10, 10]] as const) {
      const frac = v % 1;
      const exp = (T % m) / m;
      let dev = Math.abs(frac - exp);
      if (dev > 0.5) dev = 1 - dev; // 跨 9→0 边界的环面距离
      if (dev > 0.22) mism++;
    }
    if (mism > 0) flags.push('LLM_CHAIN_MISMATCH');
    // total 字段与逐盘推导不一致时以逐盘为准并降权
    const totalNum = Number(total);
    if (total && Number.isFinite(totalNum) && Math.abs(totalNum - T) > 0.15) {
      flags.push('LLM_TOTAL_MISMATCH');
      mism++;
    }
    const confidence = Math.max(35, 72 - mism * 15);
    return {
      value: `${intStr}.${tenth}`,
      confidence,
      method: 'llm',
      details: { candidates: [], flags },
      message: `AI 辅助识别 ${intStr}.${tenth}${flags.length ? '（机械校验有偏差）' : ''}，请人工核对`,
    };
  }

  /* ---------- path 2: pointer dials ---------- */

  private tryPointer(gray: GrayImage, rgb: RgbImage): MeterOcrResult {
    const circles = detectCircles(gray, { limit: 10 });
    if (circles.length < 4) {
      return this.empty('NO_DIALS', '未能识别字轮或表盘，请人工读数');
    }
    const maxScore = circles[0]?.score ?? 1;
    const dials = circles
      .filter((c) => c.score >= maxScore * 0.3)
      .map((c) => {
        const { pos, peak } = pointerPosition(gray, rgb, c);
        return { x: c.x, y: c.y, r: c.r, pos, peak };
      });
    const composed = composePointerInteger(dials);
    if (!composed) {
      return {
        value: null,
        confidence: 0,
        method: 'none',
        details: { candidates: [], dials: dials.map(({ x, y, r, pos }) => ({ x, y, r, pos })), flags: ['POINTER_LAYOUT_UNKNOWN'] },
        message: '检测到指针表盘但布局无法推断，请人工读数',
      };
    }
    return {
      value: String(composed.value),
      confidence: Math.min(55, Math.round(35 + dials.length * 2)),
      method: 'pointer',
      details: {
        candidates: [],
        dials: dials.map(({ x, y, r, pos }) => ({ x, y, r, pos: Math.round(pos * 100) / 100 })),
        flags: ['POINTER_INFERRED_LAYOUT'],
      },
      message: '指针表识别为推断结果，务必人工核对',
    };
  }
}
