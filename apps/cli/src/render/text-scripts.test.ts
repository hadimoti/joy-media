import { describe, expect, it } from 'vitest';
import { containsArabicScript, containsRtlOrComplexScript } from './text-scripts.js';

describe('complex-script detection', () => {
  it.each(['سلام دنیا ۱۲۳', 'Joy مدیا 2026', 'שלום', 'देवनागरी', 'ไทย'])('detects %s', (text) => {
    expect(containsRtlOrComplexScript(text)).toBe(true);
  });

  it('leaves ordinary Latin text alone and identifies Arabic script separately', () => {
    expect(containsRtlOrComplexScript('Joy Media 2026')).toBe(false);
    expect(containsArabicScript('سلام')).toBe(true);
    expect(containsArabicScript('שלום')).toBe(false);
  });
});
