import { describe, expect, it } from 'vitest';
import { createAgentPreviewStore } from './agent-preview-store.js';

describe('agent preview store', () => {
  it('keeps staged timelines in memory and clears by run id', () => {
    const store = createAgentPreviewStore();
    const canonical = { clips: [] } as const;
    const preview = { clips: [{ id: 'c1', trackId: 't1', startUs: 0, durationUs: 1 }] } as const;
    store.setTimeline({ runId: 'run-1', baseRevision: 'rev-1', canonical, preview });
    expect(store.getState().timeline?.preview.clips).toHaveLength(1);
    store.clear('other-run');
    expect(store.getState().timeline?.runId).toBe('run-1');
    store.clear('run-1');
    expect(store.getState().timeline).toBeUndefined();
  });
});
