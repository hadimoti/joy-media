import { describe, expect, it } from 'vitest';
import { EditorSession } from './editor-session.js';
import { buildTreatmentLayerInsertion } from './adjustment-layer.js';
import { buildTimelineElementsShowcase } from './timeline-elements-showcase.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('treatment layer session history', () => {
  it('adds and removes timeline + controller state as one Undo step', () => {
    const seed = buildTimelineElementsShowcase();
    const session = new EditorSession(memoryStorage(), seed.timeline, seed.visual);
    const beforeTrackCount = session.timelineProject.compositions.root!.tracks.length;
    const insertion = buildTreatmentLayerInsertion({
      timeline: session.timelineProject,
      project: session.visualProject,
      targetClipId: 'showcase-intro',
      token: 'history',
      kind: 'adjust',
    });
    session.dispatchCompound(insertion.label, {
      timeline: insertion.timeline,
      document: insertion.project,
    });
    expect(session.timelineProject.compositions.root!.tracks).toHaveLength(beforeTrackCount + 1);
    expect(session.visualProject.visualObjects['adjust-controller-history']).toBeDefined();

    session.undo();
    expect(session.timelineProject.compositions.root!.tracks).toHaveLength(beforeTrackCount);
    expect(session.visualProject.visualObjects['adjust-controller-history']).toBeUndefined();

    session.redo();
    expect(session.timelineProject.compositions.root!.tracks).toHaveLength(beforeTrackCount + 1);
    expect(session.visualProject.visualObjects['adjust-controller-history']).toBeDefined();
  });
});
