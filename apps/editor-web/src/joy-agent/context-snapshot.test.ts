import { describe, expect, it } from 'vitest';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import { createJoyAgentContextSnapshot } from './context-snapshot.js';

describe('JOY Agent context snapshot', () => {
  it('projects bounded facts and omits private payloads', () => {
    const source = {
      projectId: 'p1',
      revision: 'r1',
      clips: Array.from({ length: 300 }, (_, i) => ({
        id: `c${i}`,
        trackId: 't1',
        startUs: i,
        durationUs: 1,
      })),
      assets: [{ id: 'a1', kind: 'image', displayName: 'Poster', secret: 'never' } as never],
    };
    const snapshot = createJoyAgentContextSnapshot(source);
    expect(snapshot.clips).toHaveLength(128);
    expect(snapshot.omitted).toContain('clips');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('keeps an attached Creative Brief as bounded, read-only Composer context', () => {
    const brief = {
      schemaVersion: 1,
      projectId: 'p1',
      snapshotRevisionId: 'r1',
      request: 'Make the opening more cinematic',
    } as CreativeBriefV1;
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p1',
      revision: 'r1',
      creativeBrief: brief,
    });
    expect(snapshot.creativeBrief).toBe(brief);
    expect(JSON.stringify(snapshot)).toContain('Make the opening more cinematic');
    expect(() =>
      createJoyAgentContextSnapshot({
        projectId: 'p1',
        revision: 'r1',
        creativeBrief: { request: 'x'.repeat(33_000) } as CreativeBriefV1,
      }),
    ).toThrow('creative brief context is invalid or too large');
  });

  it('drops unsafe identifiers and bounds the full snapshot', () => {
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p1',
      revision: 'r1',
      selectedClipIds: ['clip-safe', 'https://example.invalid/secret'],
      clips: [
        { id: 'clip-safe', trackId: 'track-safe', startUs: 0, durationUs: 1 },
        { id: 'C:\\Users\\owner\\private', trackId: 'track-safe', startUs: 1, durationUs: 1 },
      ],
      assets: [
        { id: 'asset-safe', kind: 'image', displayName: 'Poster' },
        { id: 'asset-key', kind: 'image', displayName: 'apiKey=should-not-cross-boundary' },
      ],
    });
    expect(snapshot.selectedClipIds).toEqual(['clip-safe']);
    expect(snapshot.clips).toHaveLength(1);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.omitted).toContain('selectedClipIds');
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  });
});
