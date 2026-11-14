import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, normalizeHex } from './color-convert.js';

describe('normalizeHex', () => {
  it('accepts the common spellings', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('#aabbcc')).toBe('#aabbcc');
    expect(normalizeHex('AABBCC')).toBe('#aabbcc');
    expect(normalizeHex('  #F60 ')).toBe('#ff6600');
  });

  it('rejects anything else', () => {
    for (const bad of ['', '#', '#ab', '#abcd', '#abcde', '#abcdefg', 'xyz', '#12345678']) {
      expect(normalizeHex(bad)).toBeUndefined();
    }
  });
});

describe('hexToHsv', () => {
  it('reads the primary colours', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv('#0000ff')).toEqual({ h: 240, s: 1, v: 1 });
  });

  it('reads greys with no saturation', () => {
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 });
    const grey = hexToHsv('#808080');
    expect(grey.s).toBe(0);
    expect(grey.v).toBeCloseTo(128 / 255, 5);
  });

  it('reads invalid input as black', () => {
    expect(hexToHsv('nope')).toEqual({ h: 0, s: 0, v: 0 });
  });
});

describe('hsvToHex', () => {
  it('writes the primary colours', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(60, 1, 1)).toBe('#ffff00');
    expect(hsvToHex(120, 1, 1)).toBe('#00ff00');
    expect(hsvToHex(180, 1, 1)).toBe('#00ffff');
    expect(hsvToHex(240, 1, 1)).toBe('#0000ff');
    expect(hsvToHex(300, 1, 1)).toBe('#ff00ff');
  });

  it('treats hue 360 as hue 0', () => {
    expect(hsvToHex(360, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(-120, 1, 1)).toBe('#0000ff');
  });

  it('writes greys whatever the hue', () => {
    expect(hsvToHex(200, 0, 0)).toBe('#000000');
    expect(hsvToHex(200, 0, 1)).toBe('#ffffff');
    expect(hsvToHex(77, 0, 0.5)).toBe('#808080');
  });

  it('clamps out-of-range saturation and value', () => {
    expect(hsvToHex(0, 2, 2)).toBe('#ff0000');
    expect(hsvToHex(0, -1, -1)).toBe('#000000');
  });
});

describe('round trips', () => {
  it('returns the same hex for primaries, greys and mixed colours', () => {
    for (const hex of [
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#ffff00',
      '#000000',
      '#ffffff',
      '#808080',
      '#f6c453',
      '#53d9ff',
      '#123456',
    ]) {
      const { h, s, v } = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
  });
});
