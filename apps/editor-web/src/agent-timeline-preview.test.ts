import { describe, expect, it } from 'vitest';
import {
  diffAgentTimeline,
  previewTimelineFromProject,
  type AgentPreviewTimeline,
} from './agent-timeline-preview.js';

const clip = (overrides: Partial<AgentPreviewTimeline['clips'][number]> = {}) => ({
  id: 'clip-a',
  trackId: 'track-v1',
  startUs: 0,
  durationUs: 2_000_000,
  ...overrides,
});

describe('agent timeline preview projection', () => {
  it('projects add, remove, move, trim, effect, and property changes', () => {
    const canonical: AgentPreviewTimeline = {
      clips: [clip(), clip({ id: 'clip-remove', startUs: 4_000_000 })],
    };
    const preview: AgentPreviewTimeline = {
      clips: [
        clip({
          startUs: 1_000_000,
          durationUs: 3_000_000,
          effectIds: ['blur'],
          properties: { opacity: 0.7 },
        }),
        clip({ id: 'clip-add', startUs: 7_000_000 }),
      ],
    };
    const diffs = diffAgentTimeline(canonical, preview);
    expect(diffs.map((diff) => diff.kind)).toEqual([
      'move',
      'trim',
      'effect',
      'property',
      'add',
      'remove',
    ]);
  });

  it('does not create diffs for identical snapshots', () => {
    const snapshot = { clips: [clip({ properties: { opacity: 1 } })] };
    expect(diffAgentTimeline(snapshot, snapshot)).toEqual([]);
  });

  it('projects only the active root composition clips', () => {
    const result = previewTimelineFromProject({
      rootCompositionId: 'root',
      compositions: {
        root: {
          tracks: [{ id: 'video-1', clips: [{ id: 'clip-1', startUs: 0, durationUs: 2_000 }] }],
        },
        nested: {
          tracks: [
            { id: 'nested-track', clips: [{ id: 'nested-clip', startUs: 1, durationUs: 1 }] },
          ],
        },
      },
    });
    expect(result).toEqual({
      clips: [{ id: 'clip-1', trackId: 'video-1', startUs: 0, durationUs: 2_000 }],
    });
  });
});
