import { describe, expect, it } from 'vitest';
import { round } from '../src/index.js';

describe('round', () => {
  it('rounds half-up to 2 decimal places by default', () => {
    expect(round('1.005').toString()).toBe('1.01');
    expect(round('1.004').toString()).toBe('1');
  });
});
