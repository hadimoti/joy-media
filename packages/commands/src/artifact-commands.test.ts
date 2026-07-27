import { describe, expect, it } from 'vitest';
import type { CreativeArtifactV2 } from '@joy-media/project-schema';
import {
  applyArtifactCommand,
  applyArtifactTransaction,
  revertArtifactTransaction,
  ArtifactCommandError,
  EMPTY_ARTIFACT_STORE,
} from './artifact-commands.js';
import type { ArtifactCommand, ArtifactStore } from './artifact-commands.js';

function artifact(id: string, overrides: Partial<CreativeArtifactV2> = {}): CreativeArtifactV2 {
  return {
    id,
    kind: 'script',
    schemaVersion: 1,
    revision: 0,
    label: id,
    contentRef: { type: 'inline', value: 'Open on the product.' },
    binding: { type: 'none' },
    provenance: {
      sourceArtifactIds: [],
      inputHashes: [],
      createdBy: { type: 'human', id: 'hadi' },
    },
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function storeWith(...artifacts: CreativeArtifactV2[]): ArtifactStore {
  return {
    artifacts: Object.fromEntries(artifacts.map((a) => [a.id, a])),
    versions: {},
  };
}

const roundTrip = (store: ArtifactStore, command: ArtifactCommand) => {
  const applied = applyArtifactCommand(store, command);
  const reverted = applyArtifactCommand(applied.store, applied.inverse);
  return { applied, reverted };
};

describe('artifact commands', () => {
  describe('create, delete, and their inverses', () => {
    it('creates an artifact and inverts to removing it', () => {
      const { applied, reverted } = roundTrip(EMPTY_ARTIFACT_STORE, {
        type: 'artifact.create',
        payload: { artifact: artifact('script-1') },
      });

      expect(Object.keys(applied.store.artifacts)).toEqual(['script-1']);
      expect(reverted.store).toEqual(EMPTY_ARTIFACT_STORE);
    });

    it('refuses a duplicate id', () => {
      expect(() =>
        applyArtifactCommand(storeWith(artifact('a')), {
          type: 'artifact.create',
          payload: { artifact: artifact('a') },
        }),
      ).toThrow(/already exists/);
    });

    it('refuses to touch an artifact that does not exist', () => {
      expect(() =>
        applyArtifactCommand(EMPTY_ARTIFACT_STORE, {
          type: 'artifact.delete',
          payload: { artifactId: 'ghost' },
        }),
      ).toThrow(ArtifactCommandError);
    });

    it('restores a deleted artifact together with its versions', () => {
      const withVersion = applyArtifactCommand(storeWith(artifact('a')), {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Second draft.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      }).store;
      expect(withVersion.versions['a']).toHaveLength(1);

      const { applied, reverted } = roundTrip(withVersion, {
        type: 'artifact.delete',
        payload: { artifactId: 'a' },
      });

      expect(applied.store).toEqual(EMPTY_ARTIFACT_STORE);
      expect(reverted.store.versions['a']).toHaveLength(1);
      expect(reverted.store).toEqual(withVersion);
    });
  });

  describe('versioning is non-destructive', () => {
    it('retains the prior state when content changes', () => {
      const before = storeWith(artifact('a'));

      const applied = applyArtifactCommand(before, {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Second draft.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      }).store;

      expect(applied.artifacts['a']?.contentRef).toEqual({
        type: 'inline',
        value: 'Second draft.',
      });
      expect(applied.artifacts['a']?.revision).toBe(1);
      expect(applied.versions['a']?.[0]?.contentRef).toEqual({
        type: 'inline',
        value: 'Open on the product.',
      });
    });

    it('does not version a rename, so history is not filled with identical content', () => {
      const applied = applyArtifactCommand(storeWith(artifact('a')), {
        type: 'artifact.update',
        payload: { artifactId: 'a', label: 'Renamed', updatedAt: '2026-07-27T01:00:00.000Z', versionId: 'v1' },
      }).store;

      expect(applied.artifacts['a']?.label).toBe('Renamed');
      expect(applied.artifacts['a']?.revision).toBe(0);
      expect(applied.versions['a']).toBeUndefined();
    });

    it('does not version a content write that changes nothing', () => {
      const applied = applyArtifactCommand(storeWith(artifact('a')), {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Open on the product.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      }).store;

      expect(applied.versions['a']).toBeUndefined();
    });

    it('inverts an update back to the exact prior artifact and version list', () => {
      const before = storeWith(artifact('a'));
      const { reverted } = roundTrip(before, {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Second draft.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      });

      expect(reverted.store).toEqual(before);
    });

    it('promotes a version without discarding the one it replaces', () => {
      // Going back must not depend on undo: both states stay reachable.
      const drafted = applyArtifactCommand(storeWith(artifact('a')), {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Second draft.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      }).store;

      const promoted = applyArtifactCommand(drafted, {
        type: 'artifact.promoteVersion',
        payload: {
          artifactId: 'a',
          versionId: 'v1',
          updatedAt: '2026-07-27T02:00:00.000Z',
          versionIdForCurrent: 'v2',
        },
      }).store;

      expect(promoted.artifacts['a']?.contentRef).toEqual({
        type: 'inline',
        value: 'Open on the product.',
      });
      expect(promoted.versions['a']?.map((v) => v.id)).toEqual(['v2']);
      expect(promoted.versions['a']?.[0]?.contentRef).toEqual({
        type: 'inline',
        value: 'Second draft.',
      });
    });

    it('refuses to promote or pin a version that does not exist', () => {
      const store = storeWith(artifact('a'));
      expect(() =>
        applyArtifactCommand(store, {
          type: 'artifact.pinVersion',
          payload: { artifactId: 'a', versionId: 'nope', pinned: true },
        }),
      ).toThrow(/no version/);
    });

    it('pins and unpins, inverting to the previous pin state', () => {
      const drafted = applyArtifactCommand(storeWith(artifact('a')), {
        type: 'artifact.update',
        payload: {
          artifactId: 'a',
          contentRef: { type: 'inline', value: 'Second draft.' },
          updatedAt: '2026-07-27T01:00:00.000Z',
          versionId: 'v1',
        },
      }).store;

      const { applied, reverted } = roundTrip(drafted, {
        type: 'artifact.pinVersion',
        payload: { artifactId: 'a', versionId: 'v1', pinned: true },
      });

      expect(applied.store.versions['a']?.[0]?.pinned).toBe(true);
      expect(reverted.store.versions['a']?.[0]?.pinned).toBe(false);
    });
  });

  describe('time binding', () => {
    it('binds a range and inverts to the previous binding', () => {
      const before = storeWith(artifact('a'));
      const { applied, reverted } = roundTrip(before, {
        type: 'artifact.bindTime',
        payload: {
          artifactId: 'a',
          binding: { type: 'range', startUs: 0, durationUs: 5_000_000 },
        },
      });

      expect(applied.store.artifacts['a']?.binding).toEqual({
        type: 'range',
        startUs: 0,
        durationUs: 5_000_000,
      });
      expect(reverted.store.artifacts['a']?.binding).toEqual({ type: 'none' });
    });

    it('rejects a binding the schema refuses, leaving the store untouched', () => {
      const before = storeWith(artifact('a'));

      expect(() =>
        applyArtifactCommand(before, {
          type: 'artifact.bindTime',
          payload: {
            artifactId: 'a',
            // Zero-length range: a point wearing the wrong type.
            binding: { type: 'range', startUs: 0, durationUs: 0 },
          },
        }),
      ).toThrow(/invalid artifact/);
      expect(before.artifacts['a']?.binding).toEqual({ type: 'none' });
    });
  });

  describe('transactions', () => {
    it('reverts a multi-command transaction in one step', () => {
      const before = EMPTY_ARTIFACT_STORE;
      const { store, record } = applyArtifactTransaction(before, {
        label: 'Add script and prompt',
        commands: [
          { type: 'artifact.create', payload: { artifact: artifact('script-1') } },
          { type: 'artifact.create', payload: { artifact: artifact('prompt-1', { kind: 'prompt' }) } },
          {
            type: 'artifact.bindTime',
            payload: {
              artifactId: 'script-1',
              binding: { type: 'range', startUs: 0, durationUs: 1_000_000 },
            },
          },
        ],
      });

      expect(Object.keys(store.artifacts).sort()).toEqual(['prompt-1', 'script-1']);
      expect(revertArtifactTransaction(store, record)).toEqual(before);
    });

    it('discards everything when a later command fails', () => {
      const before = storeWith(artifact('a'));

      expect(() =>
        applyArtifactTransaction(before, {
          label: 'Half-valid',
          commands: [
            { type: 'artifact.create', payload: { artifact: artifact('b') } },
            { type: 'artifact.create', payload: { artifact: artifact('a') } },
          ],
        }),
      ).toThrow(/already exists/);
      expect(Object.keys(before.artifacts)).toEqual(['a']);
    });

    it('rejects an empty transaction', () => {
      expect(() =>
        applyArtifactTransaction(EMPTY_ARTIFACT_STORE, { label: 'Nothing', commands: [] }),
      ).toThrow(/needs commands/);
    });
  });
});
