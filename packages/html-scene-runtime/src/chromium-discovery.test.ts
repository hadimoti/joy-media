import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findChromiumExecutable } from './chromium-driver.js';

const KEYS = ['JOY_CHROMIUM_PATH', 'PLAYWRIGHT_BROWSERS_PATH'] as const;

describe.runIf(process.platform !== 'win32')('Playwright Chromium discovery on Linux', () => {
  let previous: Record<string, string | undefined>;
  let root: string;

  beforeEach(() => {
    previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    root = mkdtempSync(join(tmpdir(), 'joy-chromium-discovery-'));
    delete process.env['JOY_CHROMIUM_PATH'];
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = root;
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the chrome-linux64 layout that current Playwright installs', () => {
    const layout = join(root, 'chromium-1234', 'chrome-linux64');
    mkdirSync(layout, { recursive: true });
    const executable = join(layout, 'chrome');
    writeFileSync(executable, '#!/bin/sh\n');

    // No system browser is injected, so the result depends only on the Playwright cache.
    expect(findChromiumExecutable({ systemCandidates: [] })).toBe(executable);
  });
});
