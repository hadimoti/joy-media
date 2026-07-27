import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { DUAL_LENS_FLAG_KEY } from '@joy-media/project-schema';
import type { ChangeSetProposal } from '@joy-media/agent-tools';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { EditorSession } from './editor-session.js';
import { applyChangeSet } from './apply-change-set.js';

/** Clip ids present in the reference timeline fixture. */
const CLIPS = new Set(['intro', 'product', 'outro', 'b-roll-a', 'b-roll-b']);

function proposal(edits: ChangeSetProposal['edits'], roleId = 'audio-cleanup-agent'): ChangeSetProposal {
  return {
    roleId,
    capability: 'test.apply',
    title: roleId,
    findings: [],
    edits,
    estimatedCost: { localOnly: true },
    warnings: [],
  };
}

function storage(seed: Readonly<Record<string, string>> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function session() {
  return new EditorSession(
    storage({ [DUAL_LENS_FLAG_KEY]: 'on' }),
    buildReferenceSpikeProject(),
    INITIAL_EDITOR_PROJECT,
  );
}

describe('applying specialist change sets', () => {
  describe('parameter edits reach the document', () => {
    it('sets the master grade', () => {
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          {
            targetId: 'colorGrade',
            summary: 'base grade',
            domain: 'parameters',
            parameters: { lift: 0, gamma: 1, gain: 1, saturation: 1.05, lutId: 'rec709' },
          },
        ]),
      ], CLIPS);

      expect(result.document.colorGrade).toEqual({
        lift: 0,
        gamma: 1,
        gain: 1,
        saturation: 1.05,
        lutId: 'rec709',
      });
      expect(result.applied).toEqual(['colorGrade']);
    });

    it('keeps unspecified grade fields rather than resetting them', () => {
      const graded = {
        ...INITIAL_EDITOR_PROJECT,
        colorGrade: { lift: 0.2, gamma: 1.1, gain: 1, saturation: 2, lutId: 'contrast' as const },
      };

      const result = applyChangeSet(graded, [
        proposal([
          {
            targetId: 'colorGrade',
            summary: 'tame saturation',
            domain: 'parameters',
            parameters: { saturation: 1.2 },
          },
        ]),
      ], CLIPS);

      expect(result.document.colorGrade).toEqual({
        lift: 0.2,
        gamma: 1.1,
        gain: 1,
        saturation: 1.2,
        lutId: 'contrast',
      });
    });

    it('writes audio config for a clip that had none', () => {
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          {
            targetId: 'intro',
            summary: 'normalize',
            domain: 'parameters',
            parameters: { gain: 1, pan: 0 },
          },
        ]),
      ], CLIPS);

      expect(result.document.audio?.clips['intro']).toEqual({
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
      });
    });

    it('retimes a caption clip', () => {
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          {
            targetId: 'caption-clip-1',
            summary: 'trim to sequence end',
            domain: 'parameters',
            parameters: { durationUs: 2_000_000 },
          },
        ]),
      ], CLIPS);

      const clip = result.document.compositions[result.document.rootCompositionId]?.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === 'caption-clip-1');
      expect(clip?.durationUs).toBe(2_000_000);
    });

    it('never mutates the document it was given', () => {
      const before = JSON.parse(JSON.stringify(INITIAL_EDITOR_PROJECT));

      applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          { targetId: 'colorGrade', summary: 'x', domain: 'parameters', parameters: { gain: 2 } },
        ]),
      ], CLIPS);

      expect(INITIAL_EDITOR_PROJECT).toEqual(before);
    });
  });

  describe('what it refuses to pretend', () => {
    it('reports an edit naming something it cannot resolve', () => {
      // Claiming a change set was applied when it was not is worse than
      // admitting it could not be.
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          {
            targetId: 'ghost-clip',
            summary: 'normalize',
            domain: 'parameters',
            parameters: { gain: 1 },
          },
        ]),
      ], CLIPS);

      expect(result.applied).toEqual([]);
      expect(result.unapplied[0]?.targetId).toBe('ghost-clip');
    });

    it('does not apply timeline-domain edits through this path', () => {
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([{ targetId: 'intro', summary: 'trim', domain: 'timeline' }]),
      ], CLIPS);

      expect(result.unapplied[0]?.reason).toMatch(/timeline edits are not applied/);
    });

    it('discards the whole result rather than producing an invalid document', () => {
      const result = applyChangeSet(INITIAL_EDITOR_PROJECT, [
        proposal([
          {
            targetId: 'caption-clip-1',
            summary: 'break it',
            domain: 'parameters',
            // Zero duration is rejected by the v1 validator.
            parameters: { durationUs: 0 },
          },
        ]),
      ], CLIPS);

      expect(result.document).toEqual(INITIAL_EDITOR_PROJECT);
      expect(result.applied).toEqual([]);
      expect(result.unapplied.some((entry) => entry.targetId === '(document)')).toBe(true);
    });
  });

  describe('one undo reverts the change and its record together', () => {
    it('applies the document change and the artifact in one history step', () => {
      const editor = session();
      const applied = applyChangeSet(editor.visualProject, [
        proposal([
          {
            targetId: 'colorGrade',
            summary: 'base grade',
            domain: 'parameters',
            parameters: { saturation: 1.05 },
          },
        ]),
      ], CLIPS);

      editor.dispatchCompound('Apply colour review', {
        document: applied.document,
        artifacts: {
          label: 'Apply colour review',
          commands: [
            {
              type: 'artifact.create',
              payload: {
                artifact: {
                  id: 'changeset-1',
                  kind: 'changeSet',
                  schemaVersion: 1,
                  revision: 0,
                  label: 'Color review',
                  contentRef: { type: 'inline', value: '{}' },
                  binding: { type: 'none' },
                  provenance: {
                    sourceArtifactIds: [],
                    inputHashes: [],
                    createdBy: { type: 'agent', id: 'color-review-agent' },
                  },
                  createdAt: '2026-07-27T00:00:00.000Z',
                  updatedAt: '2026-07-27T00:00:00.000Z',
                },
              },
            },
          ],
        },
      });

      expect(editor.visualProject.colorGrade?.saturation).toBe(1.05);
      expect(Object.keys(editor.artifacts.artifacts)).toEqual(['changeset-1']);

      const entry = editor.historyEntries.find((e) => e.label === 'Apply colour review');
      expect(entry?.source).toBe('compound');

      editor.undo();

      // Both halves move together, or the project keeps a record of a change
      // that is no longer applied.
      expect(editor.visualProject.colorGrade?.saturation).not.toBe(1.05);
      expect(Object.keys(editor.artifacts.artifacts)).toEqual([]);
    });

    it('redoes both halves together', () => {
      const editor = session();
      const applied = applyChangeSet(editor.visualProject, [
        proposal([
          {
            targetId: 'intro',
            summary: 'normalize',
            domain: 'parameters',
            parameters: { gain: 1 },
          },
        ]),
      ], CLIPS);
      editor.dispatchCompound('Apply audio cleanup', {
        document: applied.document,
        artifacts: {
          label: 'Apply audio cleanup',
          commands: [
            {
              type: 'artifact.create',
              payload: {
                artifact: {
                  id: 'changeset-2',
                  kind: 'changeSet',
                  schemaVersion: 1,
                  revision: 0,
                  label: 'Audio cleanup',
                  contentRef: { type: 'inline', value: '{}' },
                  binding: { type: 'none' },
                  provenance: {
                    sourceArtifactIds: [],
                    inputHashes: [],
                    createdBy: { type: 'agent', id: 'audio-cleanup-agent' },
                  },
                  createdAt: '2026-07-27T00:00:00.000Z',
                  updatedAt: '2026-07-27T00:00:00.000Z',
                },
              },
            },
          ],
        },
      });

      editor.undo();
      expect(editor.artifacts.artifacts['changeset-2']).toBeUndefined();

      editor.redo();

      expect(editor.visualProject.audio?.clips['intro']?.gain).toBe(1);
      expect(editor.artifacts.artifacts['changeset-2']).toBeDefined();
    });

    it('leaves a timeline edit made afterwards untouched', () => {
      const editor = session();
      editor.dispatchCompound('Apply colour review', {
        document: applyChangeSet(editor.visualProject, [
          proposal([
            {
              targetId: 'colorGrade',
              summary: 'grade',
              domain: 'parameters',
              parameters: { saturation: 1.4 },
            },
          ]),
        ], CLIPS).document,
      });
      editor.dispatchTimeline({
        label: 'Trim intro',
        commands: [
          {
            type: 'timeline.trimClipEnd',
            payload: {
              compositionId: 'root',
              trackId: 'track-0',
              clipId: 'intro',
              newEndUs: 8_000_000,
            },
          },
        ],
      });

      editor.undo(); // the timeline edit only

      expect(editor.visualProject.colorGrade?.saturation).toBe(1.4);
    });

    it('advances the revision so a plan built before it is stale', () => {
      const editor = session();
      const before = editor.projectRevisionId;

      editor.dispatchCompound('Apply colour review', {
        document: { ...editor.visualProject, colorGrade: { lift: 0, gamma: 1, gain: 1, saturation: 1.1 } },
      });

      expect(editor.projectRevisionId).not.toBe(before);
    });

    it('records nothing when there is nothing to apply', () => {
      const editor = session();
      const before = editor.historyEntries.length;

      editor.dispatchCompound('Nothing', {});

      expect(editor.historyEntries).toHaveLength(before);
    });
  });
});
