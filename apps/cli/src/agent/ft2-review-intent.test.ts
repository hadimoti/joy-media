// FT2 review MUST2 + HIGH + SHOULD ('all clips').
import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { verifyRequestIntent } from './joy-agent.js';
import { fixtureProject } from './scripted-agent.test-helper.js';

const clipsAt = (aDur: number, cStart = 10_000_000) =>
  fixtureProject({
    assets: { a: 30_000_000, b: 30_000_000, c: 30_000_000 },
    clips: [
      { id: 'clip-a', assetId: 'a', startUs: 0, durationUs: aDur },
      { id: 'clip-b', assetId: 'b', startUs: 5_000_000, durationUs: 5_000_000 },
      { id: 'clip-c', assetId: 'c', startUs: cStart, durationUs: 5_000_000 },
    ],
  }) as unknown as JoyProjectV1;
const gapUnmet = (request: string) =>
  verifyRequestIntent(clipsAt(3_000_000), request, clipsAt(5_000_000)).unmet.filter((item) =>
    item.includes('black gap'),
  );

describe('MUST2: the #7 gap check is skipped only for an explicit gap request', () => {
  it.each([
    "Trim A to 3s and don't leave any gaps",
    'Trim A to 3s; the title can stay blank',
    'Trim A to 3s and give it a black and white look',
  ])('%s still reports the new gap', (request) => {
    expect(gapUnmet(request)).toHaveLength(1);
  });

  it.each(['Trim A to 3s and leave a 2s black gap', 'trim A and add 2 seconds of black after it'])(
    '%s is an explicit gap',
    (request) => {
      expect(gapUnmet(request)).toEqual([]);
    },
  );
});

describe('HIGH: start-at-0 needs a clip this run moved', () => {
  it('"move clip C to start at 0" with nothing moved is unmet even though A is at 0', () => {
    const project = clipsAt(5_000_000);
    const result = verifyRequestIntent(project, 'move clip C to start at 0', project);
    expect(result.verified).not.toContain('Request: clip starts at 0');
    expect(result.unmet).toContain(
      'request asked for a clip starting at 0, but this run moved no clip',
    );
  });

  it('a clip moved to 0 is verified', () => {
    const before = clipsAt(5_000_000);
    const after = clipsAt(5_000_000, 0);
    expect(verifyRequestIntent(after, 'move clip C to start at 0', before).verified).toContain(
      'Request: clip starts at 0',
    );
  });
});

describe('named clip: start-at-0 needs THAT clip changed and at 0', () => {
  it('trim-only-A plus "move clip C to start at 0" is unmet', () => {
    const before = clipsAt(5_000_000);
    const after = clipsAt(3_000_000); // only A changed; A sits at 0
    const result = verifyRequestIntent(after, 'move clip C to start at 0', before);
    expect(result.verified).not.toContain('Request: clip starts at 0');
    expect(
      result.unmet.some((item) => item.startsWith('request asked for a clip starting at 0')),
    ).toBe(true);
  });

  it('C moved to 0 is verified', () => {
    const result = verifyRequestIntent(
      clipsAt(5_000_000, 0),
      'move clip C to start at 0',
      clipsAt(5_000_000),
    );
    expect(result.verified).toContain('Request: clip starts at 0');
  });

  it('B moved to 0 does not satisfy a request naming C', () => {
    const before = clipsAt(5_000_000);
    const after = fixtureProject({
      assets: { a: 30_000_000, b: 30_000_000, c: 30_000_000 },
      clips: [
        { id: 'clip-b', assetId: 'b', startUs: 0, durationUs: 5_000_000 },
        { id: 'clip-a', assetId: 'a', startUs: 5_000_000, durationUs: 5_000_000 },
        { id: 'clip-c', assetId: 'c', startUs: 10_000_000, durationUs: 5_000_000 },
      ],
    }) as unknown as JoyProjectV1;
    expect(verifyRequestIntent(after, 'move clip C to start at 0', before).verified).not.toContain(
      'Request: clip starts at 0',
    );
  });
});

describe("SHOULD: 'all clips' look rule", () => {
  const withLook = () => {
    const project = clipsAt(5_000_000) as unknown as {
      compositions: Record<string, { tracks: { clips: { look?: unknown }[] }[] }>;
      rootCompositionId: string;
    };
    project.compositions[project.rootCompositionId]!.tracks[0]!.clips[0]!.look = { preset: 'bw' };
    return project as unknown as JoyProjectV1;
  };
  it("'keep all audio' does not demand the look on every clip", () => {
    const result = verifyRequestIntent(
      withLook(),
      'make clip A black and white and keep all audio',
    );
    expect(result.verified).toContain('Request: bw look');
  });
  it("'all clips' still does", () => {
    const result = verifyRequestIntent(withLook(), 'make all clips black and white');
    expect(result.unmet).toContain('request asked for bw look');
  });
});
