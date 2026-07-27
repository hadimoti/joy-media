/**
 * Creative artifact commands (ADR-0025, plan §9.3).
 *
 * ADR-0023 gave scripts, prompts, analyses, and change sets a durable shape but
 * left them unauthorable. This is the family that authors them, in the same
 * form as timeline and graph commands: pure over an immutable store, inverse
 * computed from pre-state, result validated before return.
 *
 * Versioning is the reason this is not just a record of objects. AI outputs and
 * derived artifacts must change non-destructively (§5.3), so an edit that
 * replaces content pushes the prior state onto the artifact's version list
 * rather than overwriting it — and `promoteVersion` moves an old state back to
 * current by the same mechanism, which is what makes "compare, pin, promote,
 * fork" possible without a second history.
 */

import type {
  ArtifactContentRef,
  ArtifactVersionV2,
  CreativeArtifactV2,
  TemporalBinding,
} from '@joy-media/project-schema';
import { validateCreativeArtifact } from '@joy-media/project-schema';

export class ArtifactCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArtifactCommandError';
    this.code = code;
  }
}

export interface ArtifactStore {
  readonly artifacts: Readonly<Record<string, CreativeArtifactV2>>;
  /** Prior states, oldest first. Keyed by artifact id. */
  readonly versions: Readonly<Record<string, readonly ArtifactVersionV2[]>>;
}

export const EMPTY_ARTIFACT_STORE: ArtifactStore = { artifacts: {}, versions: {} };

export type ArtifactCommand =
  | { readonly type: 'artifact.create'; readonly payload: { readonly artifact: CreativeArtifactV2 } }
  | { readonly type: 'artifact.delete'; readonly payload: { readonly artifactId: string } }
  | {
      readonly type: 'artifact.update';
      readonly payload: {
        readonly artifactId: string;
        readonly label?: string;
        /** Replacing content retains the prior state as a version. */
        readonly contentRef?: ArtifactContentRef;
        readonly updatedAt: string;
        /** Caller-supplied so replay is deterministic (ADR-0003). */
        readonly versionId: string;
      };
    }
  | {
      readonly type: 'artifact.bindTime';
      readonly payload: { readonly artifactId: string; readonly binding: TemporalBinding };
    }
  | {
      readonly type: 'artifact.pinVersion';
      readonly payload: {
        readonly artifactId: string;
        readonly versionId: string;
        readonly pinned: boolean;
      };
    }
  | {
      readonly type: 'artifact.promoteVersion';
      readonly payload: {
        readonly artifactId: string;
        readonly versionId: string;
        readonly updatedAt: string;
        readonly versionIdForCurrent: string;
      };
    }
  /** Exact inverse for anything compound. Upserts artifact and version list. */
  | {
      readonly type: 'artifact.restore';
      readonly payload: {
        readonly artifact: CreativeArtifactV2;
        readonly versions: readonly ArtifactVersionV2[];
      };
    };

export type ArtifactCommandType = ArtifactCommand['type'];

export const ARTIFACT_COMMAND_REGISTRY: Readonly<
  Record<ArtifactCommandType, { readonly description: string }>
> = {
  'artifact.create': { description: 'Add a creative artifact to the project.' },
  'artifact.delete': { description: 'Remove an artifact and its retained versions.' },
  'artifact.update': { description: 'Change label or content, retaining the prior state.' },
  'artifact.bindTime': { description: 'Bind an artifact to a time, range, track, or item.' },
  'artifact.pinVersion': { description: 'Pin a version so a re-run cannot discard it.' },
  'artifact.promoteVersion': { description: 'Make a retained version current again.' },
  'artifact.restore': { description: 'Restore an artifact with its versions (undo).' },
};

export interface ArtifactApplyResult {
  readonly store: ArtifactStore;
  readonly inverse: ArtifactCommand;
}

export function applyArtifactCommand(
  store: ArtifactStore,
  command: ArtifactCommand,
): ArtifactApplyResult {
  const result = applyUnchecked(store, command);
  for (const [id, artifact] of Object.entries(result.store.artifacts)) {
    const diagnostics = validateCreativeArtifact(artifact, `artifacts.${id}`);
    if (diagnostics.length > 0) {
      const first = diagnostics[0]!;
      throw new ArtifactCommandError(
        'ARTIFACT_COMMAND_RESULT_INVALID',
        `${command.type} would produce an invalid artifact: [${first.code}] ${first.message}`,
      );
    }
  }
  // Versions of an artifact that no longer exists are unreachable history that
  // would keep its media alive with nothing able to show it.
  for (const id of Object.keys(result.store.versions)) {
    if (result.store.artifacts[id] === undefined) {
      throw new ArtifactCommandError(
        'ARTIFACT_VERSIONS_ORPHANED',
        `${command.type} would leave versions for missing artifact "${id}"`,
      );
    }
  }
  return result;
}

function applyUnchecked(store: ArtifactStore, command: ArtifactCommand): ArtifactApplyResult {
  switch (command.type) {
    case 'artifact.create': {
      const { artifact } = command.payload;
      if (store.artifacts[artifact.id] !== undefined) {
        throw new ArtifactCommandError(
          'ARTIFACT_EXISTS',
          `artifact "${artifact.id}" already exists`,
        );
      }
      return {
        store: { ...store, artifacts: { ...store.artifacts, [artifact.id]: artifact } },
        inverse: { type: 'artifact.delete', payload: { artifactId: artifact.id } },
      };
    }

    case 'artifact.delete': {
      const artifact = require_(store, command.payload.artifactId);
      const versions = store.versions[artifact.id] ?? [];
      return {
        store: {
          artifacts: omit(store.artifacts, artifact.id),
          versions: omit(store.versions, artifact.id),
        },
        inverse: { type: 'artifact.restore', payload: { artifact, versions } },
      };
    }

    case 'artifact.restore': {
      const { artifact, versions } = command.payload;
      return {
        store: {
          artifacts: { ...store.artifacts, [artifact.id]: artifact },
          versions:
            versions.length === 0
              ? omit(store.versions, artifact.id)
              : { ...store.versions, [artifact.id]: versions },
        },
        inverse: restoreInverse(store, artifact.id),
      };
    }

    case 'artifact.update': {
      const previous = require_(store, command.payload.artifactId);
      const { label, contentRef, updatedAt, versionId } = command.payload;
      // Only a content change creates a version. Renaming something should not
      // fill its history with entries whose content is identical.
      const retains = contentRef !== undefined && !sameContent(contentRef, previous.contentRef);
      const next: CreativeArtifactV2 = {
        ...previous,
        ...(label === undefined ? {} : { label }),
        ...(contentRef === undefined ? {} : { contentRef }),
        revision: retains ? previous.revision + 1 : previous.revision,
        updatedAt,
      };
      const priorVersions = store.versions[previous.id] ?? [];
      return {
        store: {
          artifacts: { ...store.artifacts, [previous.id]: next },
          versions: retains
            ? {
                ...store.versions,
                [previous.id]: [...priorVersions, snapshot(previous, versionId)],
              }
            : store.versions,
        },
        inverse: restoreInverse(store, previous.id),
      };
    }

    case 'artifact.bindTime': {
      const previous = require_(store, command.payload.artifactId);
      return {
        store: {
          ...store,
          artifacts: {
            ...store.artifacts,
            [previous.id]: { ...previous, binding: command.payload.binding },
          },
        },
        inverse: {
          type: 'artifact.bindTime',
          payload: { artifactId: previous.id, binding: previous.binding },
        },
      };
    }

    case 'artifact.pinVersion': {
      const artifact = require_(store, command.payload.artifactId);
      const versions = store.versions[artifact.id] ?? [];
      const target = versions.find((v) => v.id === command.payload.versionId);
      if (target === undefined) {
        throw new ArtifactCommandError(
          'ARTIFACT_VERSION_MISSING',
          `artifact "${artifact.id}" has no version "${command.payload.versionId}"`,
        );
      }
      return {
        store: {
          ...store,
          versions: {
            ...store.versions,
            [artifact.id]: versions.map((v) =>
              v.id === target.id ? { ...v, pinned: command.payload.pinned } : v,
            ),
          },
        },
        inverse: {
          type: 'artifact.pinVersion',
          payload: {
            artifactId: artifact.id,
            versionId: target.id,
            pinned: target.pinned === true,
          },
        },
      };
    }

    case 'artifact.promoteVersion': {
      const current = require_(store, command.payload.artifactId);
      const versions = store.versions[current.id] ?? [];
      const target = versions.find((v) => v.id === command.payload.versionId);
      if (target === undefined) {
        throw new ArtifactCommandError(
          'ARTIFACT_VERSION_MISSING',
          `artifact "${current.id}" has no version "${command.payload.versionId}"`,
        );
      }
      // Promotion is non-destructive in both directions: the version being
      // replaced is retained, so the user can go back without relying on undo.
      const promoted: CreativeArtifactV2 = {
        ...current,
        contentRef: target.contentRef,
        provenance: target.provenance,
        revision: current.revision + 1,
        updatedAt: command.payload.updatedAt,
      };
      return {
        store: {
          artifacts: { ...store.artifacts, [current.id]: promoted },
          versions: {
            ...store.versions,
            [current.id]: [
              ...versions.filter((v) => v.id !== target.id),
              snapshot(current, command.payload.versionIdForCurrent),
            ],
          },
        },
        inverse: restoreInverse(store, current.id),
      };
    }
  }
}

/** The command that puts an artifact back exactly as it is right now. */
function restoreInverse(store: ArtifactStore, artifactId: string): ArtifactCommand {
  const artifact = store.artifacts[artifactId];
  if (artifact === undefined) {
    return { type: 'artifact.delete', payload: { artifactId } };
  }
  return {
    type: 'artifact.restore',
    payload: { artifact, versions: store.versions[artifactId] ?? [] },
  };
}

function snapshot(artifact: CreativeArtifactV2, versionId: string): ArtifactVersionV2 {
  return {
    id: versionId,
    artifactId: artifact.id,
    revision: artifact.revision,
    contentRef: artifact.contentRef,
    provenance: artifact.provenance,
    createdAt: artifact.updatedAt,
    ...(artifact.pinned === true ? { pinned: true } : {}),
  };
}

function sameContent(left: ArtifactContentRef, right: ArtifactContentRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function require_(store: ArtifactStore, artifactId: string): CreativeArtifactV2 {
  const artifact = store.artifacts[artifactId];
  if (artifact === undefined) {
    throw new ArtifactCommandError('ARTIFACT_MISSING', `artifact "${artifactId}" does not exist`);
  }
  return artifact;
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  void _removed;
  return rest;
}

export interface ArtifactTransaction {
  readonly label: string;
  readonly commands: readonly ArtifactCommand[];
  readonly coalesceKey?: string;
}

export interface ArtifactTransactionRecord {
  readonly label: string;
  readonly commands: readonly ArtifactCommand[];
  readonly inverses: readonly ArtifactCommand[];
  readonly coalesceKey?: string;
}

export interface ArtifactTransactionResult {
  readonly store: ArtifactStore;
  readonly record: ArtifactTransactionRecord;
}

/** Atomic, and like the other families it owns no history of its own. */
export function applyArtifactTransaction(
  store: ArtifactStore,
  transaction: ArtifactTransaction,
): ArtifactTransactionResult {
  if (transaction.commands.length === 0) {
    throw new ArtifactCommandError(
      'ARTIFACT_VALIDATION_EMPTY_TRANSACTION',
      'a transaction needs commands',
    );
  }
  let current = store;
  const inverses: ArtifactCommand[] = [];
  for (const command of transaction.commands) {
    const result = applyArtifactCommand(current, command);
    current = result.store;
    inverses.unshift(result.inverse);
  }
  return {
    store: current,
    record: {
      label: transaction.label,
      commands: [...transaction.commands],
      inverses,
      ...(transaction.coalesceKey === undefined ? {} : { coalesceKey: transaction.coalesceKey }),
    },
  };
}

export function revertArtifactTransaction(
  store: ArtifactStore,
  record: ArtifactTransactionRecord,
): ArtifactStore {
  let current = store;
  for (const inverse of record.inverses) {
    current = applyArtifactCommand(current, inverse).store;
  }
  return current;
}
