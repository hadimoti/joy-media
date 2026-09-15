/* global process */
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { composeRetainedDestination } from './retain-evidence-paths.mjs';

describe('retain-evidence path composition', () => {
  it('caller roots ending in /p3 vs no-p3 yield distinct destinations sharing the named tail', async () => {
    const candidate = '0c70c61cdfc692e04a7c46d3b37a6e94a1d7adfe';
    const run = '34611945642';
    const attempt = '1';
    const pass = '1';
    const tail = `${candidate}/${run}-${attempt}-p${pass}`;

    const base = await mkdtemp(`${tmpdir()}/jm-retain-paths-`);
    const rootNoP3 = `${base}/evidence`;
    const rootWithP3 = `${rootNoP3}/p3`;

    const destNoP3 = composeRetainedDestination(rootNoP3, candidate, run, attempt, pass);
    const destWithP3 = composeRetainedDestination(rootWithP3, candidate, run, attempt, pass);

    expect(destWithP3).not.toBe(destNoP3);
    if (process.platform !== 'win32') {
      expect(destWithP3.endsWith(`/p3/${tail}`)).toBe(true);
      expect(destNoP3.endsWith(`/${tail}`)).toBe(true);
    }
  });
});
