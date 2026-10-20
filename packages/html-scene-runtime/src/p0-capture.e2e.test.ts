import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { createChromiumSceneDriver, findChromiumExecutable } from './chromium-driver.js';
import { scenePaintFontDescriptors } from './font-descriptors.js';

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

    it('paints explicit frames deterministically', () => {
      const driver = createChromiumSceneDriver();
      const face = scenePaintFontDescriptors().find(
        (font) => font.weight === 400 && font.subset === 'latin',
      );
      if (face === undefined) throw new Error('Canonical Latin font descriptor is missing');
      const paint = {
        width: 360,
        height: 160,
        rects: [{ x: 10, y: 10, width: 340, height: 140, colour: '#17324d', opacity: 0.35 }],
        lines: [
          {
            text: 'JOY explicit frame',
            font: '400 32px "Noto Sans Arabic"',
            colour: '#ffffff',
            direction: 'ltr' as const,
            align: 'left' as const,
            x: 24,
            y: 52,
            height: 44,
            opacity: 1,
            face: { family: face.family, weight: face.weight, subset: face.subset },
          },
        ],
        fonts: [face],
      };
      const request = {
        markup: '',
        width: 360,
        height: 160,
        transparent: true,
        timeUs: 0,
        frameRate: rational(30, 1),
        locale: 'en-US',
        seed: 'explicit-frame',
        paint,
      };
      try {
        const first = driver.capture(request);
        const second = driver.capture(request);
        expect(first.rgba).toEqual(second.rgba);
        let transparentPixels = 0;
        let antialiasedPixels = 0;
        for (let index = 3; index < first.rgba.length; index += 4) {
          if (first.rgba[index] === 0) transparentPixels++;
          if (first.rgba[index]! > 0 && first.rgba[index]! < 255) antialiasedPixels++;
        }
        expect(transparentPixels).toBeGreaterThan(0);
        expect(antialiasedPixels).toBeGreaterThan(0);
      } finally {
        driver.close?.();
      }
    }, 60_000);

    it('does not paint an element whose opacity is zero', () => {
      const driver = createChromiumSceneDriver();
      try {
        const surface = driver.capture({
          markup: '<div style="width:120px;height:80px;background:red;opacity:0"></div>',
          width: 120,
          height: 80,
          transparent: true,
          timeUs: 0,
          frameRate: rational(30, 1),
          locale: 'en-US',
          seed: 'p0-opacity-zero',
          lines: [],
        });
        let paintedPixel = false;
        for (let index = 3; index < surface.rgba.length; index += 4) {
          if (surface.rgba[index]! > 0) paintedPixel = true;
        }
        expect(paintedPixel).toBe(false);
      } finally {
        driver.close?.();
      }
    });

    it('refuses images', () => {
      const driver = createChromiumSceneDriver();
      try {
        expect(() =>
          driver.capture({
            markup: '<img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=">',
            width: 120,
            height: 80,
            transparent: true,
            timeUs: 0,
            frameRate: rational(30, 1),
            locale: 'en-US',
            seed: 'p0-refuse-image',
            lines: [],
            rejectImages: true,
          }),
        ).toThrow('does not draw images');
      } finally {
        driver.close?.();
      }
    });

    it('closes the browser and profile after a successful capture and close', async () => {
      const existingProfiles = new Set(
        readdirSync(tmpdir()).filter((name) => name.startsWith('joy-scene-cdp-')),
      );
      const driver = createChromiumSceneDriver();
      try {
        driver.capture({
          markup: '',
          width: 120,
          height: 80,
          transparent: true,
          timeUs: 0,
          frameRate: rational(30, 1),
          locale: 'en-US',
          seed: 'p0-close-profile',
          lines: [],
        });
        const profileName = readdirSync(tmpdir()).find(
          (name) => name.startsWith('joy-scene-cdp-') && !existingProfiles.has(name),
        );
        if (profileName === undefined)
          throw new Error('Chromium profile directory was not created');
        const profileDirectory = join(tmpdir(), profileName);
        driver.close?.();
        for (let attempt = 0; attempt < 100 && existsSync(profileDirectory); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(profileDirectory)).toBe(false);
        let matchingProcesses: string[];
        if (process.platform === 'win32') {
          const escapedProfile = profileDirectory.replace(/'/g, "''");
          const output = execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$profile='${escapedProfile}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine.Contains($profile) } | ForEach-Object { $_.ProcessId }`,
            ],
            { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
          );
          matchingProcesses = output.trim() ? output.trim().split(/\s+/) : [];
        } else {
          const output = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
          matchingProcesses = output
            .split(/\r?\n/)
            .filter((line) => line.includes(profileDirectory) && /(?:chrome|chromium)/i.test(line));
        }
        expect(matchingProcesses).toEqual([]);
      } finally {
        driver.close?.();
      }
    });
  },
);
