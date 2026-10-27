// Tests for the offline replay of a v3 run (plan section 3.4, D18). The replay itself reads retained evidence that is not in the
// repository, so these tests cover the parts that can break silently: the needs context rebuilt from a gate log, and the two values
// the readiness comparison must ignore, and no other.
import { describe, expect, it } from 'vitest';

const MANIFEST = 'test-output/readiness/single-pass-evidence/manifest.json';
import {
  canonicalJson,
  comparableReadiness,
  differingKeys,
  extractNeedsFromLog,
} from './ci-v3-offline-replay.mjs';

const LOG = [
  '2026-10-27T20:08:23.9590360Z   NEEDS_JSON: {',
  ' "hosted-verify": {',
  '   "result": "success",',
  '   "outputs": {',
  '     "report_sha256": "abc"',
  '   }',
  ' },',
  ' "windows-candidate": {',
  '   "result": "success",',
  '   "outputs": { "evidence1": "ZXhhbXBsZQ==" }',
  ' }',
  '}',
  '2026-10-27T20:08:24.0000000Z after the block',
].join('\n');

describe('the needs context rebuilt from a gate log', () => {
  it('parses the NEEDS_JSON block that the gate step printed, including its timestamped first line', () => {
    expect(extractNeedsFromLog(LOG)).toEqual({
      'hosted-verify': { result: 'success', outputs: { report_sha256: 'abc' } },
      'windows-candidate': { result: 'success', outputs: { evidence1: 'ZXhhbXBsZQ==' } },
    });
  });

  it('refuses a log with no NEEDS_JSON block, rather than rebuilding an empty context', () => {
    expect(() => extractNeedsFromLog('2026-10-27T20:08:24.0000000Z no block here')).toThrow(
      /no NEEDS_JSON block/u,
    );
  });
});

describe('the readiness comparison ignores only the values that change on every replay', () => {
  const retained = {
    endUtc: '2026-10-27T20:19:15.895Z',
    redactedHashes: {
      'test-output/readiness/single-pass-evidence/manifest.json': 'hash-at-restore-time',
      'test-output/browser/journeys.json': 'same',
    },
    scenarios: [{ id: 'cli.render.playable', status: 'passed' }],
  };

  it('treats a replay that differs only in the build time and the restore-time manifest hash as the same record', () => {
    const replayed = {
      ...retained,
      endUtc: '2026-10-27T20:56:33.411Z',
      redactedHashes: { ...retained.redactedHashes, [MANIFEST]: 'hash-at-replay-time' },
    };
    expect(differingKeys(comparableReadiness(replayed), comparableReadiness(retained))).toEqual([]);
  });

  it('still reports a change to any other value, so a wrong scenario or a wrong evidence hash is never hidden', () => {
    const changedScenario = {
      ...retained,
      scenarios: [{ id: 'cli.render.playable', status: 'failed' }],
    };
    expect(
      differingKeys(comparableReadiness(changedScenario), comparableReadiness(retained)),
    ).toEqual(['scenarios']);
    const changedEvidence = {
      ...retained,
      redactedHashes: { ...retained.redactedHashes, 'test-output/browser/journeys.json': 'other' },
    };
    expect(
      differingKeys(comparableReadiness(changedEvidence), comparableReadiness(retained)),
    ).toEqual(['redactedHashes']);
  });

  it('compares canonical JSON by content, so key order alone never makes two records differ', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
