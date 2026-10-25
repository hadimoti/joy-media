import { describe, expect, it } from 'vitest';
import { findChromiumExecutable } from '@joy-media/html-scene-runtime';
import { Sandbox } from './harness.js';

describe('sandboxed CLI environment', () => {
  it('gives the child the Chromium the parent resolves, so caption measurement can start', () => {
    const sandbox = new Sandbox('sandbox-env');
    try {
      const parent = process.env['JOY_CHROMIUM_PATH']?.trim() || findChromiumExecutable();
      expect(sandbox.env().JOY_CHROMIUM_PATH).toBe(parent);
    } finally {
      sandbox.cleanup();
    }
  });
});
