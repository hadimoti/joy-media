import { describe, expect, it } from 'vitest';
import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import { createJoyAgentContextSnapshot } from './context-snapshot.js';
import { briefFixture } from './creative-brief.test-fixture.js';

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
    const brief = briefFixture('p1', 'r1', 'Make the opening more cinematic');
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p1',
      revision: 'r1',
      creativeBrief: brief,
    });
    expect(snapshot.creativeBrief).toEqual(brief);
    expect(snapshot.creativeBrief).not.toBe(brief);
    expect(() =>
      createJoyAgentContextSnapshot({
        projectId: 'p1',
        revision: 'new-revision',
        creativeBrief: brief,
      }),
    ).toThrow('invalid or stale');
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

  it('includes bounded Inspector targets without forwarding raw project data', () => {
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p1',
      revision: 'r1',
      visualObjects: [
        {
          id: 'title-1',
          kind: 'text',
          text: 'Safe title',
          transform: { x: 12, opacity: 0.8, secret: Number.NaN },
          animatedProperties: ['opacity', 'apiKey=hidden'],
          privatePayload: 'do-not-forward',
        } as never,
      ],
    });
    expect(snapshot.visualObjects).toEqual([
      {
        id: 'title-1',
        kind: 'text',
        text: 'Safe title',
        transform: { x: 12, opacity: 0.8 },
        animatedProperties: ['opacity'],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('privatePayload');
  });

  it('keeps recent project conversation available without carrying secrets or URLs', () => {
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p1',
      revision: 'r1',
      conversation: [
        { role: 'user', body: 'Make the title smaller' },
        { role: 'assistant', body: 'A title proposal is ready' },
        { role: 'user', body: 'apiKey=do-not-forward' },
      ],
    });
    expect(snapshot.conversation).toEqual([
      { role: 'user', body: 'Make the title smaller' },
      { role: 'assistant', body: 'A title proposal is ready' },
    ]);
    expect(snapshot.omitted).toContain('conversation');
  });

  it('packs large Unicode visual projects under the byte budget and keeps selected identity first', () => {
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'persian-project',
      revision: 'revision-1',
      selectedClipIds: ['clip-199'],
      selectedVisualObjectIds: ['title-199'],
      clips: Array.from({ length: 200 }, (_, index) => ({
        id: `clip-${index}`,
        trackId: 'track-1',
        startUs: index,
        durationUs: 1_000_000,
      })),
      visualObjects: Array.from({ length: 200 }, (_, index) => ({
        id: `title-${index}`,
        kind: 'text',
        text: 'م'.repeat(500),
        transform: { x: index, y: index, opacity: 1 },
        animatedProperties: ['opacity'],
      })),
      assets: [],
    });
    expect(snapshot.projectId).toBe('persian-project');
    expect(snapshot.revision).toBe('revision-1');
    expect(snapshot.clips[0]?.id).toBe('clip-199');
    expect(snapshot.visualObjects?.[0]?.id).toBe('title-199');
    expect(snapshot.omitted).toContain('visualObjects');
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(
      60_000,
    );
  });

  it('rejects missing required identity instead of emitting an unusable snapshot', () => {
    expect(() =>
      createJoyAgentContextSnapshot({ projectId: 'https://invalid', revision: 'revision-1' }),
    ).toThrow('identity');
  });

  it('keeps the final omission envelope within budget at the Unicode boundary', () => {
    const snapshot = createJoyAgentContextSnapshot({
      projectId: 'p',
      revision: 'r',
      trackIds: ['t'],
      selectedVisualObjectIds: ['o127'],
      visualObjects: Array.from({ length: 128 }, (_, index) => ({
        id: `o${index}`,
        kind: 'text',
        text: 'م'.repeat(385),
        animatedProperties: [],
      })),
      assets: [{ id: 'a', kind: 'video', displayName: 'name' }],
      conversation: [{ role: 'user', body: 'change title' }],
    });
    expect(snapshot.visualObjects?.[0]?.id).toBe('o127');
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength).toBeLessThanOrEqual(
      60_000,
    );
  });
});
