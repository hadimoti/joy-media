// R1 (retest 02af4933): dola-seed reports a crossfade at cut - duration (4 s) while the app anchors
// it at the cut (5 s); apply was refused with "expected to start at 4s but starts at 5s".
import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { verifyPlanChecklist } from './joy-agent.js';
import { fixtureProject } from './scripted-agent.test-helper.js';

const project = (durationUs = 1_000_000) =>
  ({
    ...fixtureProject({
      assets: { a: 30_000_000, b: 30_000_000 },
      clips: [
        { id: 'clip-a', assetId: 'a', startUs: 0, durationUs: 5_000_000 },
        { id: 'clip-b', assetId: 'b', startUs: 5_000_000, durationUs: 5_000_000 },
      ],
    }),
    transitions: [
      { id: 't', leftClipId: 'clip-a', rightClipId: 'clip-b', type: 'dissolve', durationUs },
    ],
  }) as unknown as JoyProjectV1;
const item = (timelineStartUs: number) =>
  ({ kind: 'transition', leftClipId: 'clip-a', rightClipId: 'clip-b', timelineStartUs }) as never;

describe('R1: transition checklist start convention', () => {
  it('accepts the cut (5 s) and cut - duration (4 s), and anything in between', () => {
    for (const start of [5_000_000, 4_000_000, 4_500_000])
      expect(verifyPlanChecklist(project(), [item(start)]).unmet).toEqual([]);
  });

  it('still refuses a start outside [cut - duration, cut]', () => {
    expect(verifyPlanChecklist(project(), [item(3_000_000)]).unmet).toEqual([
      expect.stringContaining('expected to start at 3s but starts at 5s'),
    ]);
    expect(verifyPlanChecklist(project(), [item(5_500_000)]).unmet).toHaveLength(1);
    expect(verifyPlanChecklist(project(500_000), [item(4_000_000)]).unmet).toHaveLength(1);
  });

  it('refuses cut - duration when no transition exists between the clips', () => {
    const bare = { ...project(), transitions: [] } as unknown as JoyProjectV1;
    expect(verifyPlanChecklist(bare, [item(4_000_000)]).unmet).toContainEqual(
      expect.stringContaining('expected to start at 4s but starts at 5s'),
    );
  });
});
