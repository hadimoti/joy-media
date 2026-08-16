import { describe, expect, it } from 'vitest';
import type { Composition } from '@joy-media/project-schema';
import { buildTimelineDeletePlan } from './delete-timeline-elements.js';

const composition: Composition = {
  id: 'root',
  name: 'Main',
  width: 1920,
  height: 1080,
  frameRate: { num: 30, den: 1 },
  durationUs: 20_000_000,
  tracks: [
    {
      id: 'top',
      kind: 'video',
      order: 2,
      enabled: true,
      clips: [
        {
          id: 'top-b',
          kind: 'video',
          assetId: 'b',
          startUs: 2_000_000,
          durationUs: 1_000_000,
          sourceInUs: 0,
        },
        {
          id: 'top-a',
          kind: 'video',
          assetId: 'a',
          startUs: 1_000_000,
          durationUs: 1_000_000,
          sourceInUs: 0,
        },
      ],
    },
    {
      id: 'bottom',
      kind: 'video',
      order: 1,
      enabled: true,
      clips: [
        {
          id: 'bottom-a',
          kind: 'video',
          assetId: 'c',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
        },
      ],
    },
  ],
};

describe('buildTimelineDeletePlan', () => {
  it('creates one deterministic non-ripple transaction for every selected clip', () => {
    const result = buildTimelineDeletePlan({
      composition,
      selectedIds: ['bottom-a', 'top-b', 'top-a'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipIds).toEqual(['top-a', 'top-b', 'bottom-a']);
    expect(result.transaction.commands).toHaveLength(3);
    expect(
      result.transaction.commands.every((command) => command.type === 'timeline.removeClip'),
    ).toBe(true);
  });

  it('rejects the complete batch when any selected track is locked', () => {
    const result = buildTimelineDeletePlan({
      composition,
      selectedIds: ['top-a', 'bottom-a'],
      tracks: [{ id: 'bottom', locked: true }],
    });
    expect(result).toEqual({ ok: false, reason: 'Unlock bottom before deleting the selection.' });
  });

  it('never partially deletes a stale selection', () => {
    const result = buildTimelineDeletePlan({ composition, selectedIds: ['top-a', 'missing'] });
    expect(result.ok).toBe(false);
  });
});
