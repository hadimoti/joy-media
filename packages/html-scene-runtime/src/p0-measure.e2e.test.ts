import { describe, expect, it } from 'vitest';
import { createChromiumSceneDriver, findChromiumExecutable } from './chromium-driver.js';
import { createChromiumTextMeasure } from './text-measure.js';

const requireChromium = process.env.JOY_REQUIRE_CHROMIUM === '1';
describe.runIf(requireChromium || findChromiumExecutable() !== undefined)(
  'P0 Chromium text measurement',
  () => {
    it('measures Arabic and Latin text, caches identical requests, and closes cleanly', () => {
      const driver = createChromiumSceneDriver();
      const measure = createChromiumTextMeasure(driver);
      try {
        expect(() => measure('invalid', 0, 400)).toThrow('fontSizePx');
        expect(driver.browserProcessId).toBeUndefined();
        const arabic = String.fromCodePoint(0x633, 0x644, 0x627, 0x645);
        const small = measure(arabic, 24, 700);
        const repeat = measure(arabic, 24, 700);
        expect(small).toBeGreaterThan(0);
        expect(repeat).toBe(small);
        expect(measure(arabic, 48, 700)).toBeGreaterThan(small);
        expect(measure('JOY Media', 24, 400)).toBeGreaterThan(0);
        expect(driver.browserProcessId).toBeTypeOf('number');
      } finally {
        driver.close?.();
      }
      expect(() => measure('after close', 24, 400)).toThrow();
    }, 60_000);
  },
);
