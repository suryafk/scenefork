import { describe, expect, it } from 'vitest';
import { scaleFromGroundings } from './ForkController';

describe('scaleFromGroundings (OV6)', () => {
  it('takes the median of px height per real meter, clamped to 30-600', () => {
    expect(scaleFromGroundings([{ heightPx: 180, heightM: 2 }, { heightPx: 80, heightM: 0.8 }, { heightPx: 300, heightM: 1 }])).toBe(100);
    expect(scaleFromGroundings([{ heightPx: 100, heightM: 0.1 }])).toBe(600); // a 10 cm mug filling 100 px
    expect(scaleFromGroundings([{ heightPx: 20, heightM: 10 }])).toBe(30);
    expect(scaleFromGroundings([{ heightPx: 50, heightM: 0 }])).toBeNull();
  });
});
