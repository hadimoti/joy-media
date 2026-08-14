import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { TEXT_TEMPLATES } from './text-template-catalog.js';
import { insertTextTemplate } from './text-template-transaction.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('text template insertion', () => {
  it('creates a native object, clip binding, and timeline item as one compound edit', () => {
    const session = new EditorSession(
      memoryStorage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const inserted = insertTextTemplate(session, TEXT_TEMPLATES[10]!, 2_000_000);

    expect(inserted).toBeDefined();
    expect(session.visualProject.visualObjects[inserted!.objectId]).toMatchObject({
      kind: 'text',
      text: 'Make every FRAME count',
      textDocument: { version: 1 },
      textStyle: { fontSizePx: 88 },
    });
    expect(session.visualProject.pluginData['joy.clipObjects']).toMatchObject({
      [inserted!.clipId]: inserted!.objectId,
    });
    const timelineClips = session.timelineProject.compositions.root!.tracks.flatMap(
      (track) => track.clips,
    );
    expect(timelineClips.find((clip) => clip.id === inserted!.clipId)).toMatchObject({
      startUs: 2_000_000,
      durationUs: 5_000_000,
    });
    expect(session.historyEntries.at(-1)?.label).toBe('Add text Highlight Word');
  });
});
