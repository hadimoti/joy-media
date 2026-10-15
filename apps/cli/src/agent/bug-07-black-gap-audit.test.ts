// #7 (e2e 103c4142): a trim left a black gap at 4-8 s but the run still said "Verified".
// Plus audit items 2 (start-at-0 satisfied by an unrelated clip) and 4 (look on "both" clips).
import { describe, expect, it } from 'vitest';
import { verifyRequestIntent } from './joy-agent.js';
import { fixtureProject } from './scripted-agent.test-helper.js';

const twoClips = (aDuration: number, bStart: number, extra: { look?: 'crt' } = {}) =>
  fixtureProject({
    assets: { 'asset-a': 30_000_000, 'asset-b': 30_000_000 },
    clips: [
      { id: 'clip-a', assetId: 'asset-a', startUs: 0, durationUs: aDuration, ...extra },
      { id: 'clip-b', assetId: 'asset-b', startUs: bStart, durationUs: 8_000_000 },
    ],
  });

describe('#7 and false-success audit', () => {
  it('#7: a trim that leaves a black gap between clips is not verified', () => {
    const before = twoClips(8_000_000, 8_000_000);
    const after = twoClips(4_000_000, 8_000_000);
    const result = verifyRequestIntent(after, 'Trim clip 1 to 2-6 seconds', before);
    expect(result.unmet).toContain(
      'this run left a black gap at 4s–8s (no clip covers it); close the gap or ask for it explicitly',
    );
  });

  it('#7: a rippled trim (no gap) and a requested gap are fine', () => {
    const before = twoClips(8_000_000, 8_000_000);
    expect(
      verifyRequestIntent(twoClips(4_000_000, 4_000_000), 'Trim clip 1', before).unmet,
    ).toEqual([]);
    expect(
      verifyRequestIntent(
        twoClips(4_000_000, 8_000_000),
        'Trim clip 1 and leave a black gap before clip 2',
        before,
      ).unmet,
    ).toEqual([]);
  });

  it('#7: a gap that was already there is not blamed on this run', () => {
    const before = twoClips(4_000_000, 8_000_000);
    expect(verifyRequestIntent(twoClips(4_000_000, 8_000_000), 'Rename', before).unmet).toEqual([]);
  });

  it('audit 2: "move clip B to the start" is not satisfied by clip A already at 0', () => {
    const before = twoClips(8_000_000, 8_000_000);
    // B moved, but to 2 s, not 0; A was at 0 all along.
    const after = twoClips(8_000_000, 2_000_000);
    const result = verifyRequestIntent(after, 'Move clip B to start at 0', before);
    expect(result.unmet).toContain('request asked for a clip starting at 0');
  });

  it('audit 4: "apply CRT to both clips" needs the look on both', () => {
    const before = twoClips(8_000_000, 8_000_000);
    const one = twoClips(8_000_000, 8_000_000, { look: 'crt' });
    const result = verifyRequestIntent(one, 'Apply the crt look to both clips', before);
    expect(result.verified.some((line) => /look/.test(line))).toBe(false);
  });
});
