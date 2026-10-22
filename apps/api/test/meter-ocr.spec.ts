/**
 * Meter-OCR pure helpers — synthetic pixel buffers, no DB / no tesseract.
 */
import { describe, expect, it } from 'vitest';
import {
  composePointerInteger,
  detectCircles,
  digitWindowX,
  findDigitBands,
  longestDigitRun,
  pointerPosition,
  redSplitX,
  type GrayImage,
  type RgbImage,
} from '../src/modules/metering/ocr/image-utils.js';

const gray = (w: number, h: number, fill = 220): GrayImage => ({
  data: new Uint8Array(w * h).fill(fill),
  width: w,
  height: h,
});

const rect = (g: GrayImage, x0: number, y0: number, x1: number, y1: number, v: number) => {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) g.data[y * g.width + x] = v;
  }
};

describe('findDigitBands', () => {
  it('finds a horizontal digit strip among flat regions', () => {
    const g = gray(600, 400);
    // digit strip at y=120-160: alternating dark/light columns
    for (let y = 120; y < 160; y++) {
      for (let x = 150; x < 450; x++) {
        g.data[y * g.width + x] = (x % 14) < 7 ? 20 : 230;
      }
    }
    const bands = findDigitBands(g, 3);
    expect(bands.length).toBeGreaterThan(0);
    const b = bands[0];
    expect(b.top).toBeLessThanOrEqual(125);
    expect(b.top + b.height).toBeGreaterThanOrEqual(155);
  });

  it('returns [] on a flat image', () => {
    expect(findDigitBands(gray(400, 300), 3)).toEqual([]);
  });
});

describe('digitWindowX', () => {
  it('locates the central dark cluster inside a band', () => {
    const g = gray(600, 400);
    // digit window x 200-380 inside band y 100-140
    const band = { left: 0, top: 100, width: 600, height: 40 };
    for (let y = 102; y < 138; y++) {
      for (let x = 210; x < 370; x++) {
        if ((x % 16) < 8) g.data[y * g.width + x] = 30;
      }
    }
    // decoy dark blobs at far-left edge (photo background)
    rect(g, 0, 100, 40, 140, 10);
    const win = digitWindowX(g, band);
    expect(win).not.toBeNull();
    expect(win!.x0).toBeLessThanOrEqual(215);
    expect(win!.x1).toBeGreaterThanOrEqual(365);
    expect(win!.x0).toBeGreaterThan(50); // decoy excluded
  });
});

describe('redSplitX', () => {
  it('returns the left edge of the rightmost red column cluster', () => {
    const rgb: RgbImage = {
      data: new Uint8Array(600 * 300 * 3).fill(200),
      width: 600,
      height: 300,
    };
    // red zone x 350-380, y 100-160
    for (let y = 100; y < 160; y++) {
      for (let x = 350; x < 380; x++) {
        const i = (y * 600 + x) * 3;
        rgb.data[i] = 170;
        rgb.data[i + 1] = 60;
        rgb.data[i + 2] = 60;
      }
    }
    const x = redSplitX(rgb, { left: 0, top: 90, width: 600, height: 90 });
    expect(x).not.toBeNull();
    expect(x!).toBeLessThanOrEqual(355);
    expect(x!).toBeGreaterThanOrEqual(340);
  });

  it('respects the within-window bound', () => {
    const rgb: RgbImage = {
      data: new Uint8Array(600 * 300 * 3).fill(200),
      width: 600,
      height: 300,
    };
    for (let y = 100; y < 160; y++) {
      for (let x = 500; x < 540; x++) {
        const i = (y * 600 + x) * 3;
        rgb.data[i] = 170;
        rgb.data[i + 1] = 60;
        rgb.data[i + 2] = 60;
      }
    }
    const band = { left: 0, top: 90, width: 600, height: 90 };
    expect(redSplitX(rgb, band, { x0: 100, x1: 400 })).toBeNull();
    expect(redSplitX(rgb, band, { x0: 100, x1: 560 })).not.toBeNull();
  });
});

describe('detectCircles + pointerPosition', () => {
  it('finds a drawn circle and reads the needle direction', () => {
    const g = gray(300, 300);
    const cx = 150;
    const cy = 150;
    const r = 50;
    // dark circle outline
    for (let a = 0; a < Math.PI * 2; a += 0.002) {
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      rect(g, x - 1, y - 1, x + 2, y + 2, 20);
    }
    // needle pointing down-left ≈ mid-digit 7 (270° clockwise from top)
    const th = (7.5 / 10) * Math.PI * 2 - Math.PI / 2;
    for (let rr = 10; rr < r * 0.7; rr += 1) {
      const x = Math.round(cx + Math.cos(th) * rr);
      const y = Math.round(cy + Math.sin(th) * rr);
      rect(g, x - 2, y - 2, x + 3, y + 3, 20);
    }
    const circles = detectCircles(g, { rMin: 30, rMax: 70, limit: 5 });
    expect(circles.length).toBeGreaterThan(0);
    const c = circles[0];
    expect(Math.hypot(c.x - cx, c.y - cy)).toBeLessThan(12);
    const { pos } = pointerPosition(g, null, c);
    expect(pos).toBeGreaterThanOrEqual(7);
    expect(pos).toBeLessThan(8);
  });
});

describe('composePointerInteger', () => {
  it('composes ×1/×10/×100/×1000 from the left column top→bottom', () => {
    const dials = [
      // left column: ×1=3, ×10=5, ×100=7, ×1000=2 → 2753
      { x: 100, y: 100, pos: 3.2 },
      { x: 95, y: 200, pos: 5.9 },
      { x: 105, y: 300, pos: 7.1 },
      { x: 98, y: 400, pos: 2.4 },
      // right column (decimals, ignored)
      { x: 300, y: 150, pos: 8.0 },
      { x: 310, y: 250, pos: 4.5 },
      { x: 305, y: 350, pos: 1.2 },
      { x: 300, y: 450, pos: 6.7 },
    ];
    const r = composePointerInteger(dials);
    expect(r).not.toBeNull();
    expect(r!.value).toBe(2753);
  });

  it('returns null when no two-column layout exists', () => {
    const dials = [
      { x: 100, y: 100, pos: 1 },
      { x: 110, y: 300, pos: 2 },
      { x: 90, y: 500, pos: 3 },
    ];
    expect(composePointerInteger(dials)).toBeNull();
  });
});

describe('longestDigitRun', () => {
  it('extracts the longest digit run', () => {
    expect(longestDigitRun('abc12345x')).toBe('12345');
    expect(longestDigitRun('12 ab 678')).toBeNull();
    expect(longestDigitRun('0088', 4)).toBe('0088');
  });
});
