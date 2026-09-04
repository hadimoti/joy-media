import { describe, expect, it } from 'vitest';
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
    expect(snapshot.clips).toHaveLength(256);
    expect(snapshot.omitted).toContain('clips');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
