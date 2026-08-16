import { describe, expect, it, vi } from 'vitest';
import type { SpikeProject } from '@joy-media/project-schema';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import { emptySpikeProject } from '@joy-media/test-fixtures';
import { buildContentTemplateTransaction } from './content-template-transaction.js';
import type { SeededContentTemplate } from './content-template-types.js';
import type { EditorSession } from './editor-session.js';

function emptyTimelineProject(): SpikeProject {
  return emptySpikeProject();
}

function emptyVisualProject(): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'p',
    title: 't',
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
        durationUs: 1_000_000,
        background: '#000',
        tracks: [],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
}

function makeMockSession(timelineProject: SpikeProject, visualProject: JoyProjectV1) {
  const dispatchCompound =
    vi.fn<
      (
        label: string,
        parts: { readonly document?: JoyProjectV1; readonly timeline?: CommandTransaction },
      ) => void
    >();

  return {
    dispatchCompound,
    session: {
      get timelineProject() {
        return timelineProject;
      },
      get visualProject() {
        return visualProject;
      },
      dispatchCompound,
    } as unknown as EditorSession,
  };
}

const PLAYHEAD_US = 0;

describe('buildContentTemplateTransaction', () => {
  it('dispatches one visual-object command and one timeline command for a single html-scene action', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'abc',
    };

    buildContentTemplateTransaction(seeded, {
      session,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });

    expect(dispatchCompound).toHaveBeenCalledTimes(1);
    const parts = dispatchCompound.mock.calls[0]![1];
    expect(parts.document?.visualObjects).toHaveProperty('joy.title-0-abc');
    const tlCall = parts.timeline!;
    expect(tlCall.commands).toHaveLength(1);
    expect(tlCall.commands[0]!.type).toBe('timeline.insertClip');
  });

  it('binds the created clip to the visual object via replaceVisualProject', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'abc',
    };

    buildContentTemplateTransaction(seeded, {
      session,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });

    const boundProject = dispatchCompound.mock.calls[0]![1].document!;
    expect(boundProject.pluginData).toHaveProperty('joy.clipObjects');
  });

  it('same seed produces same IDs across two calls', () => {
    const { session: s1, dispatchCompound: dv1 } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const { session: s2, dispatchCompound: dv2 } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'abc',
    };

    buildContentTemplateTransaction(seeded, {
      session: s1,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });
    buildContentTemplateTransaction(seeded, {
      session: s2,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });

    const ids1 = Object.keys(dv1.mock.calls[0]![1].document!.visualObjects);
    const ids2 = Object.keys(dv2.mock.calls[0]![1].document!.visualObjects);
    expect(ids1).toEqual(ids2);
  });

  it('different seed produces different IDs from same template', () => {
    const { session: s1, dispatchCompound: dv1 } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const { session: s2, dispatchCompound: dv2 } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const makeSeeded = (seed: string): SeededContentTemplate => ({
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed,
    });

    buildContentTemplateTransaction(makeSeeded('abc'), {
      session: s1,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });
    buildContentTemplateTransaction(makeSeeded('xyz'), {
      session: s2,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });

    const ids1 = Object.keys(dv1.mock.calls[0]![1].document!.visualObjects);
    const ids2 = Object.keys(dv2.mock.calls[0]![1].document!.visualObjects);
    expect(ids1).not.toEqual(ids2);
  });

  it('adds a new track when no suitable existing track is available', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptySpikeProject({ trackCount: 0 }),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'abc',
    };

    buildContentTemplateTransaction(seeded, {
      session,
      selectedClipIds: [],
      playheadUs: PLAYHEAD_US,
    });

    const tlCall = dispatchCompound.mock.calls[0]![1].timeline!;
    expect(tlCall.commands).toHaveLength(2);
    expect(tlCall.commands[0]!.type).toBe('timeline.addTrack');
    expect(tlCall.commands[1]!.type).toBe('timeline.insertClip');
  });

  it('does not reject duplicate application of the same template', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'abc',
    };

    expect(() => {
      buildContentTemplateTransaction(seeded, {
        session,
        selectedClipIds: [],
        playheadUs: PLAYHEAD_US,
      });
      buildContentTemplateTransaction(seeded, {
        session,
        selectedClipIds: [],
        playheadUs: PLAYHEAD_US,
      });
    }).not.toThrow();

    expect(dispatchCompound).toHaveBeenCalledTimes(2);
  });

  it('places two clips with correct duration (5 seconds each)', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [
          { kind: 'html-scene', sceneId: 'joy.firstparty.title' },
          { kind: 'html-scene', sceneId: 'joy.firstparty.title' },
        ],
      },
      seed: 'abc',
    };

    buildContentTemplateTransaction(seeded, {
      session,
      selectedClipIds: [],
      playheadUs: 0,
    });

    const tlCall = dispatchCompound.mock.calls[0]![1].timeline!;
    const insertCommands = tlCall.commands.filter(
      (c: { type: string }) => c.type === 'timeline.insertClip',
    ) as Array<{ payload: { clip: { startUs: number; durationUs: number } } }>;
    expect(insertCommands).toHaveLength(2);
    const [clip1, clip2] = insertCommands;
    expect(clip1!.payload.clip.startUs).toBe(0);
    expect(clip2!.payload.clip.startUs).toBe(0);
    expect(clip1!.payload.clip.durationUs).toBe(5_000_000);
    expect(clip2!.payload.clip.durationUs).toBe(5_000_000);
  });

  it('has one atomic failure boundary for document, binding, track, and clip placement', () => {
    const { session, dispatchCompound } = makeMockSession(
      emptyTimelineProject(),
      emptyVisualProject(),
    );
    dispatchCompound.mockImplementation(() => {
      throw new Error('injected persistence failure');
    });
    const seeded: SeededContentTemplate = {
      template: {
        id: 'joy.title',
        label: 'JOY Title',
        description: 'Main title',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      seed: 'rollback',
    };
    expect(() =>
      buildContentTemplateTransaction(seeded, {
        session,
        selectedClipIds: [],
        playheadUs: PLAYHEAD_US,
      }),
    ).toThrow('injected persistence failure');
    expect(dispatchCompound).toHaveBeenCalledTimes(1);
    expect(session.visualProject.visualObjects).toEqual({});
    expect(
      session.timelineProject.compositions.root?.tracks.every((track) => track.clips.length === 0),
    ).toBe(true);
  });
});
