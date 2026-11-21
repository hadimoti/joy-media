import { describe, expect, it } from 'vitest';
import {
  collectTimelineAssetClips,
  mapAssetQcReportsToTimelineFindings,
} from './timeline-asset-qc.js';

const S = 1_000_000;

describe('timeline-asset-qc', () => {
  it('maps asset QC findings to timeline time, detects held-tail freeze, and updates loudness/clipping with master gain', () => {
    const clips = collectTimelineAssetClips({
      tracks: [
        {
          enabled: true,
          clips: [
            { id: 'c0', kind: 'video', assetId: 'a-black', startUs: 0, durationUs: 6 * S },
            { id: 'c1', kind: 'video', assetId: 'a-freeze', startUs: 6 * S, durationUs: 6 * S },
            { id: 'c2', kind: 'video', assetId: 'a-silence', startUs: 12 * S, durationUs: 6 * S },
            { id: 'c3', kind: 'video', assetId: 'a-clip', startUs: 18 * S, durationUs: 6 * S },
            { id: 'c4', kind: 'video', assetId: 'a-dark', startUs: 24 * S, durationUs: 6 * S },
          ],
        },
        {
          enabled: false,
          clips: [
            { id: 'c-disabled', kind: 'video', assetId: 'a-black', startUs: 0, durationUs: 6 * S },
          ],
        },
      ],
    });
    expect(clips).toHaveLength(5);

    const reports = new Map<string, Readonly<Record<string, unknown>>>([
      [
        'a-black',
        {
          findings: [
            {
              type: 'black',
              severity: 'major',
              startUs: 2 * S,
              endUs: 2.28 * S,
              label: 'Black',
              measured: { blackDurationUs: 280_000 },
              fixable: false,
            },
          ],
        },
      ],
      [
        'a-freeze',
        {
          findings: [
            {
              type: 'av-length-mismatch',
              severity: 'minor',
              startUs: 0,
              endUs: 6 * S,
              label: 'Short video',
              measured: { videoDurationUs: 2 * S, audioDurationUs: 6 * S },
              fixable: false,
            },
          ],
        },
      ],
      [
        'a-silence',
        {
          findings: [
            {
              type: 'loudness',
              severity: 'minor',
              startUs: 0,
              endUs: 6 * S,
              label: 'Quiet -70 LUFS',
              measured: { integratedLufs: -70 },
              fixable: true,
            },
            {
              type: 'silence',
              severity: 'minor',
              startUs: 0,
              endUs: 6 * S,
              label: 'Silent',
              measured: { silenceDurationUs: 6 * S },
              fixable: true,
            },
          ],
        },
      ],
      [
        'a-clip',
        {
          findings: [
            {
              type: 'clipping',
              severity: 'major',
              startUs: 0,
              endUs: 6 * S,
              label: 'Clipped',
              measured: { peakDb: 3.2 },
              fixable: true,
            },
            {
              type: 'loudness',
              severity: 'major',
              startUs: 0,
              endUs: 6 * S,
              label: 'Loud',
              measured: { integratedLufs: -1.3, truePeakDbfs: 3.2 },
              fixable: true,
            },
          ],
        },
      ],
      [
        'a-dark',
        {
          findings: [
            {
              type: 'exposure',
              severity: 'minor',
              startUs: 0,
              endUs: 6 * S,
              label: 'Dark',
              measured: { meanLuma: 34.7, kind: 'dark' },
              fixable: false,
            },
          ],
        },
      ],
    ]);

    const initial = mapAssetQcReportsToTimelineFindings({
      clips,
      reports,
      timesUs: [0, 8 * S, 20 * S],
      frameIdAt: (t) => `frame-${t}`,
      masterGain: 1,
    });
    expect(initial.map((f) => f.type)).toEqual([
      'black',
      'frozen',
      'av-length-mismatch',
      'silence',
      'clipping',
      'loudness',
      'exposure',
    ]);
    expect(initial.find((f) => f.type === 'frozen')).toMatchObject({
      startUs: 8 * S,
      endUs: 12 * S,
      fixable: true,
    });

    // After trimming c1 to 2s and lowering master gain by -12.7 dB: frozen, clipping, loudness disappear.
    const gainAfter = 10 ** (-12.7 / 20);
    const trimmedClips = clips.map((c) =>
      c.assetId === 'a-freeze' ? { ...c, durationUs: 2 * S } : c,
    );
    const rechecked = mapAssetQcReportsToTimelineFindings({
      clips: trimmedClips,
      reports,
      timesUs: [0, 8 * S],
      frameIdAt: (t) => `frame-${t}`,
      masterGain: gainAfter,
    });
    expect(rechecked.map((f) => f.type)).toEqual(['black', 'silence', 'exposure']);
  });
});
