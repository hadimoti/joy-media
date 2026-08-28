import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { VisualObjectProjectHistory } from './index.js';

const project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'p',
  title: 'P',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {
    root: {
      id: 'root',
      name: 'Root',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 10_000_000,
      background: '#000000',
      tracks: [
        {
          id: 'captions',
          kind: 'caption',
          name: 'Captions',
          order: 0,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'caption-clip',
              kind: 'caption',
              startUs: 0,
              durationUs: 1_000_000,
              captionDocumentId: 'doc',
            },
          ],
        },
      ],
    },
  },
  assets: {},
  variables: {},
  markers: [],
  visualObjects: {},
  captionDocuments: {
    doc: {
      id: 'doc',
      language: 'en-US',
      direction: 'ltr',
      speakers: [],
      words: { w1: { id: 'w1', text: 'hello', startUs: 0, endUs: 500_000 } },
      segments: [{ id: 'seg-1', startUs: 0, endUs: 500_000, wordIds: ['w1'] }],
    },
  },
  pluginData: {},
};

describe('caption commands ride the shared durable v1 history', () => {
  it('applies, undoes, and redoes caption edits alongside object edits', () => {
    const history = new VisualObjectProjectHistory(project);
    history.apply({
      label: 'Edit caption text',
      commands: [
        {
          type: 'caption.setSegmentText',
          payload: { documentId: 'doc', segmentId: 'seg-1', textOverride: 'Hello JOY' },
        },
      ],
    });
    expect(history.present.captionDocuments.doc!.segments[0]!.textOverride).toBe('Hello JOY');

    const undone = history.undo();
    expect(undone.project.captionDocuments.doc!.segments[0]!.textOverride).toBeUndefined();
    expect(undone.project.captionDocuments.doc).toEqual(project.captionDocuments.doc);

    const redone = history.redo();
    expect(redone.project.captionDocuments.doc!.segments[0]!.textOverride).toBe('Hello JOY');
  });

  it('undoes and redoes transcription document replacement with clip placement as one step', () => {
    const history = new VisualObjectProjectHistory(project);
    const replacement = {
      ...project.captionDocuments.doc!,
      words: { w2: { id: 'w2', text: 'later', startUs: 0, endUs: 600_000 } },
      segments: [{ id: 'segment-later', startUs: 0, endUs: 600_000, wordIds: ['w2'] }],
    };
    history.apply({
      label: 'Transcribe English',
      commands: [
        {
          type: 'caption.replaceDocument',
          payload: { documentId: 'doc', document: replacement },
        },
        {
          type: 'caption.setClipTiming',
          payload: {
            documentId: 'doc',
            clipId: 'caption-clip',
            startUs: 4_000_000,
            durationUs: 3_000_000,
          },
        },
      ],
    });
    expect(history.present.captionDocuments.doc).toEqual(replacement);
    expect(history.present.compositions.root!.tracks[0]!.clips[0]).toMatchObject({
      startUs: 4_000_000,
      durationUs: 3_000_000,
    });

    expect(history.undo().project).toEqual(project);
    const redone = history.redo().project;
    expect(redone.captionDocuments.doc).toEqual(replacement);
    expect(redone.compositions.root!.tracks[0]!.clips[0]).toMatchObject({
      startUs: 4_000_000,
      durationUs: 3_000_000,
    });
  });
});
