import { describe, expect, it } from 'vitest';
import { clipNameWithoutExtension, polishMediaLabel } from './media-label.js';

describe('clipNameWithoutExtension', () => {
  it('drops the file extension from a file name', () => {
    expect(clipNameWithoutExtension('product-shot.mp4')).toBe('product-shot');
    expect(clipNameWithoutExtension('  Intro Take 2.MOV ')).toBe('Intro Take 2');
  });

  it('keeps names that have no file extension', () => {
    expect(clipNameWithoutExtension('intro')).toBe('intro');
    expect(clipNameWithoutExtension('v1.2 intro')).toBe('v1.2 intro');
    expect(clipNameWithoutExtension('Mr.Bean')).toBe('Mr.Bean');
  });
});

describe('polishMediaLabel', () => {
  it('title-cases simple clip ids', () => {
    expect(polishMediaLabel('intro')).toBe('Intro');
    expect(polishMediaLabel('product')).toBe('Product');
    expect(polishMediaLabel('outro')).toBe('Outro');
  });

  it('turns trailing letter suffixes into parentheses', () => {
    expect(polishMediaLabel('b-roll-a')).toBe('B-roll(A)');
    expect(polishMediaLabel('b-roll-b')).toBe('B-roll(B)');
    expect(polishMediaLabel('b_roll_c')).toBe('B-roll(C)');
  });

  it('keeps hyphens for multi-segment ids and preserves acronyms', () => {
    expect(polishMediaLabel('Generated intro')).toBe('Generated Intro');
    expect(polishMediaLabel('JOY')).toBe('JOY');
    expect(polishMediaLabel('flux-dev')).toBe('Flux-dev');
    expect(polishMediaLabel('asset-intro')).toBe('Asset-intro');
  });
});
