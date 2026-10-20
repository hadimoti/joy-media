import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cliBuildInputs, isCliBuildStale } from './harness.js';

describe('CLI build staleness', () => {
  it('watches every CLI workspace dependency source and the bundler script', () => {
    const inputs = cliBuildInputs('cli-root', 'repo-root');

    expect(inputs).toContain(join('repo-root', 'packages', 'html-scene-runtime', 'src'));
    expect(inputs).toContain(join('cli-root', 'scripts', 'bundle.mjs'));
    expect(inputs).toEqual(
      expect.arrayContaining([
        join('repo-root', 'packages', 'agent-tools', 'src'),
        join('repo-root', 'packages', 'commands', 'src'),
        join('repo-root', 'packages', 'joy-agent-engine', 'src'),
        join('repo-root', 'packages', 'motion-core', 'src'),
        join('repo-root', 'packages', 'project-persistence', 'src'),
        join('repo-root', 'packages', 'project-schema', 'src'),
      ]),
    );
  });

  it('is stale when the completion marker is missing', () => {
    expect(
      isCliBuildStale({
        markerMtimeMs: undefined,
        binMtimeMs: 30,
        bundleMtimeMs: 30,
        newestSourceMtimeMs: 20,
      }),
    ).toBe(true);
  });

  it('is fresh when the marker is newer than sources even if bin.js is older', () => {
    expect(
      isCliBuildStale({
        markerMtimeMs: 40,
        binMtimeMs: 10,
        bundleMtimeMs: 30,
        newestSourceMtimeMs: 39,
      }),
    ).toBe(false);
  });

  it('is stale when a source is newer than the marker by more than one millisecond', () => {
    expect(
      isCliBuildStale({
        markerMtimeMs: 40,
        binMtimeMs: 35,
        bundleMtimeMs: 36,
        newestSourceMtimeMs: 42,
      }),
    ).toBe(true);
  });

  it.each([
    { binMtimeMs: undefined, bundleMtimeMs: 30 },
    { binMtimeMs: 30, bundleMtimeMs: undefined },
  ])('is stale when a built entry is missing', ({ binMtimeMs, bundleMtimeMs }) => {
    expect(
      isCliBuildStale({
        markerMtimeMs: 40,
        binMtimeMs,
        bundleMtimeMs,
        newestSourceMtimeMs: 20,
      }),
    ).toBe(true);
  });

  it('is fresh when the marker is present and all sources are older', () => {
    expect(
      isCliBuildStale({
        markerMtimeMs: 40,
        binMtimeMs: 39,
        bundleMtimeMs: 38,
        newestSourceMtimeMs: 30,
      }),
    ).toBe(false);
  });
});
