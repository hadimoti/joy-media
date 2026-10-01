import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { observe, isLoopbackUrl } from '../release-performance-observer.mjs';

describe('release performance observer safety contract', () => {
  it('measures elapsed time monotonically when the system wall clock moves backward', async () => {
    const module = await import('../release-performance-observer.mjs');
    const createElapsedTimer = (
      module as unknown as {
        createElapsedTimer?: (now?: () => number) => () => number;
      }
    ).createElapsedTimer;
    expect(createElapsedTimer).toBeTypeOf('function');

    let monotonicNow = 10;
    const timer = (createElapsedTimer as (now?: () => number) => () => number)(() => monotonicNow);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const startWallTime = Date.now();
    try {
      monotonicNow += 1_800_000;
      wallClock.mockReturnValue(1_000_000);
      expect(Date.now() - startWallTime).toBe(-1_000_000);
      expect(timer()).toBe(1_800_000);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('uses a monotonic default clock independent of backward wall-clock changes', async () => {
    const module = await import('../release-performance-observer.mjs');
    const createElapsedTimer = (
      module as unknown as {
        createElapsedTimer?: (now?: () => number) => () => number;
      }
    ).createElapsedTimer;
    expect(createElapsedTimer).toBeTypeOf('function');

    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      const timer = (createElapsedTimer as () => () => number)();
      wallClock.mockReturnValue(1_000_000);
      expect(timer()).toBeGreaterThanOrEqual(0);
    } finally {
      wallClock.mockRestore();
    }
  });

  it('accepts only local loopback URLs', () => {
    expect(isLoopbackUrl('http://127.0.0.1:4173')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8790/ready')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4173')).toBe(true);
    expect(isLoopbackUrl('https://joyst.ir')).toBe(false);
    expect(isLoopbackUrl('not a URL')).toBe(false);
  });

  it('emits all four shared-metadata artifacts when browser evidence is unavailable', async () => {
    const output = mkdtempSync(join(tmpdir(), 'joy-release-observer-'));
    const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const result = await observe({ root, output });
    expect(result.status).toBe('failed');
    expect(result.measured).toBe(false);
    if (result.unmeasured.some((item: string) => item.includes('source worktree is dirty'))) {
      expect(result.unmeasured).toContain(
        'source worktree is dirty; observer refuses to produce release evidence',
      );
    } else {
      expect(result.unmeasured).toContain(
        'no --url supplied; Playwright/browser behavior was not measured',
      );
    }
    const names = ['polling.json', 'effects-soak.json', 'timeline-integrity.json', 'editor.json'];
    const documents = names.map((name) => JSON.parse(readFileSync(join(output, name), 'utf8')));
    expect(documents).toHaveLength(4);
    for (const document of documents) {
      expect(document.runId).toBe(result.runId);
      expect(document.generatedAt).toBe(documents[0].generatedAt);
      expect(document.generator).toBe('joy-media-release-observer');
      expect(document.phase).toBe('staging');
      expect(document.status).toBe('failed');
      expect(document.measured).toBe(false);
      expect(document.sourceProvenance).toEqual(documents[0].sourceProvenance);
      expect(document.unmeasured.length).toBeGreaterThan(0);
    }
    expect(documents[0].metrics.hiddenRequestsPerMinute).toBeNull();
    expect(documents[0].metrics.queryRatePerMinute).toBeNull();
    expect(documents[2].metrics.countSequence).toBeNull();
  });

  it('fails closed before importing or launching Playwright for a public URL', async () => {
    const output = mkdtempSync(join(tmpdir(), 'joy-release-observer-public-'));
    const result = await observe({ root: output, output: 'evidence', url: 'https://joyst.ir' });
    expect(result.status).toBe('failed');
    expect(result.unmeasured.some((item: string) => item.includes('non-loopback'))).toBe(true);
  });
});
