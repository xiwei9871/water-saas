import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { estimateAvg3 } from '../src/index.js';

describe('estimateAvg3', () => {
  it('returns mean of last 3 valid usages', () => {
    expect(estimateAvg3([30, 36, 33].map((d) => new Decimal(d)))!.toFixed(4)).toBe(
      '33.0000',
    );
  });

  it('averages whatever valid history exists (1–2 values)', () => {
    expect(estimateAvg3([40, 20].map((d) => new Decimal(d)))!.toFixed(4)).toBe(
      '30.0000',
    );
    expect(estimateAvg3([new Decimal(17)])).toBeDefined();
    expect(estimateAvg3([new Decimal(17)])!.toFixed(4)).toBe('17.0000');
  });

  it('uses only the LAST 3 when more history is passed', () => {
    expect(
      estimateAvg3([100, 30, 36, 33].map((d) => new Decimal(d)))!.toFixed(4),
    ).toBe('33.0000');
  });

  it('keeps decimal precision (no float math)', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004 — the mean must be exact.
    const avg = estimateAvg3([new Decimal('0.1'), new Decimal('0.2')]);
    expect(avg!.toFixed(4)).toBe('0.1500');
  });

  it('returns null with no history', () => {
    expect(estimateAvg3([])).toBeNull();
  });
});
