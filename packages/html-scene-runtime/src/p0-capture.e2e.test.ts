import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { createChromiumSceneDriver, findChromiumExecutable } from './chromium-driver.js';

// The browser test runs wherever Chromium is installed. Where JOY_REQUIRE_CHROMIUM=1 says the browser
// must exist (the real-services lane installs it), a missing browser makes the test fail instead.
const requireChromium = process.env.JOY_REQUIRE_CHROMIUM === '1';
describe.runIf(requireChromium || findChromiumExecutable() !== undefined)(
  'P0 headless scene surface capture',
  () => {
    it('renders RTL and Latin lines with loaded fonts, transparent antialiased RGBA, repeat hashes, and a closed browser', () => {
      const driver = createChromiumSceneDriver();
      const request = {
        markup: '',
        width: 360,
        height: 160,
        transparent: true,
        timeUs: 0,
        frameRate: rational(30, 1),
        locale: 'en-US',
        seed: 'p0-capture',
        lines: [
          {
            text: String.fromCodePoint(
              0x633,
              0x644,
              0x627,
              0x645,
              0x20,
              0x62f,
              0x646,
              0x6cc,
              0x627,
              0x20,
              0x641,
              0x627,
              0x631,
              0x633,
              0x6cc,
            ),
            x: 340,
            y: 24,
            height: 48,
            font: '700 34px "Noto Sans Arabic"',
            color: '#ffffff',
            direction: 'rtl' as const,
            align: 'right' as const,
          },
          {
            text: 'JOY Media 2026',
            x: 20,
            y: 88,
            height: 38,
            font: '400 26px "Noto Sans Arabic"',
            color: '#ffffff',
            direction: 'ltr' as const,
            align: 'left' as const,
          },
        ],
      };
      try {
        const first = driver.capture(request);
        const second = driver.capture(request);
        expect(first.rgba).toHaveLength(request.width * request.height * 4);
        expect(first.loadedFonts).toEqual(['arabic:400', 'arabic:700', 'latin:400', 'latin:700']);
        expect(first.rgba.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
        let transparentPixels = 0;
        let antialiasedPixels = 0;
        for (let index = 3; index < first.rgba.length; index += 4) {
          if (first.rgba[index] === 0) transparentPixels++;
          if (first.rgba[index]! > 0 && first.rgba[index]! < 255) antialiasedPixels++;
        }
        expect(transparentPixels).toBeGreaterThan(0);
        expect(antialiasedPixels).toBeGreaterThan(0);
        const firstHash = createHash('sha256').update(first.rgba).digest('hex');
        const secondHash = createHash('sha256').update(second.rgba).digest('hex');
        expect(secondHash).toBe(firstHash);

        const browserPid = driver.browserProcessId;
        expect(browserPid).toBeTypeOf('number');
        driver.close?.();
        expect(() => process.kill(browserPid!, 0)).toThrow();
        expect(() => driver.capture(request)).toThrow('driver is closed');
      } finally {
        driver.close?.();
      }
    }, 60_000);
  },
);
