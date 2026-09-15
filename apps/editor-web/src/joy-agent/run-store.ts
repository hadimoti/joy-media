import {
  cloneJoyAgentRunControllerSnapshot,
  isJoyAgentRunControllerSnapshot,
  type JoyAgentRunControllerSnapshot,
} from './run-controller.js';
import { isSafeJoyAgentRunOpaqueId } from './run-events.js';

/** A deliberately narrow, safe-to-persist run checkpoint envelope. */
export const JOY_AGENT_RUN_CHECKPOINT_VERSION = 1 as const;
export const JOY_AGENT_RUN_CHECKPOINT_STORAGE_PREFIX = 'joy-media.joy-agent-run-checkpoint.v1';
const MAX_SERIALIZED_CHECKPOINT_BYTES = 65_536;

export interface JoyAgentRunCheckpoint {
  readonly version: typeof JOY_AGENT_RUN_CHECKPOINT_VERSION;
  readonly snapshot: JoyAgentRunControllerSnapshot;
}

/** Stable project-scoped browser key for the safe lifecycle checkpoint only. */
export function joyAgentRunCheckpointStorageKey(projectId: string): string {
  if (!isSafeJoyAgentRunOpaqueId(projectId)) throw new TypeError('JOY_AGENT_RUN_PROJECT_INVALID');
  return `${JOY_AGENT_RUN_CHECKPOINT_STORAGE_PREFIX}:${encodeURIComponent(projectId)}`;
}

/**
 * Storage abstraction for project-scoped lifecycle evidence. It holds no
 * provider configuration, approval handle, prompt/context, or writer object.
 * A caller may persist `serializeJoyAgentRunCheckpoint` in its chosen safe
 * browser storage implementation; this module intentionally performs no I/O.
 */
export interface JoyAgentRunStore {
  save(snapshot: JoyAgentRunControllerSnapshot): JoyAgentRunCheckpoint;
  get(projectId: string): JoyAgentRunCheckpoint | undefined;
  remove(projectId: string): void;
  clear(): void;
  serialize(projectId: string): string | undefined;
  import(serialized: string): JoyAgentRunCheckpoint | undefined;
}

export function createJoyAgentRunCheckpoint(
  snapshot: JoyAgentRunControllerSnapshot,
): JoyAgentRunCheckpoint {
  if (!isJoyAgentRunControllerSnapshot(snapshot))
    throw new TypeError('JOY_AGENT_RUN_SNAPSHOT_INVALID');
  return Object.freeze({
    version: JOY_AGENT_RUN_CHECKPOINT_VERSION,
    snapshot: cloneJoyAgentRunControllerSnapshot(snapshot),
  });
}

export function isJoyAgentRunCheckpoint(value: unknown): value is JoyAgentRunCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'snapshot'])) return false;
  return (
    value.version === JOY_AGENT_RUN_CHECKPOINT_VERSION &&
    isJoyAgentRunControllerSnapshot(value.snapshot)
  );
}

export function serializeJoyAgentRunCheckpoint(checkpoint: JoyAgentRunCheckpoint): string {
  if (!isJoyAgentRunCheckpoint(checkpoint)) throw new TypeError('JOY_AGENT_RUN_CHECKPOINT_INVALID');
  const serialized = JSON.stringify({
    version: JOY_AGENT_RUN_CHECKPOINT_VERSION,
    snapshot: checkpoint.snapshot,
  });
  if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_CHECKPOINT_BYTES)
    throw new RangeError('JOY_AGENT_RUN_CHECKPOINT_TOO_LARGE');
  return serialized;
}

/** Tolerant reader for browser storage: malformed or overbroad values are ignored. */
export function parseJoyAgentRunCheckpoint(serialized: string): JoyAgentRunCheckpoint | undefined {
  if (typeof serialized !== 'string' || serialized.length === 0) return undefined;
  if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_CHECKPOINT_BYTES)
    return undefined;
  try {
    const candidate = JSON.parse(serialized) as unknown;
    if (!isJoyAgentRunCheckpoint(candidate)) return undefined;
    return createJoyAgentRunCheckpoint(candidate.snapshot);
  } catch {
    return undefined;
  }
}

export function createJoyAgentRunStore(): JoyAgentRunStore {
  const checkpoints = new Map<string, JoyAgentRunCheckpoint>();
  return {
    save: (snapshot) => {
      const checkpoint = createJoyAgentRunCheckpoint(snapshot);
      checkpoints.set(checkpoint.snapshot.projectId, checkpoint);
      return cloneCheckpoint(checkpoint);
    },
    get: (projectId) => {
      if (!isSafeJoyAgentRunOpaqueId(projectId)) return undefined;
      const checkpoint = checkpoints.get(projectId);
      return checkpoint === undefined ? undefined : cloneCheckpoint(checkpoint);
    },
    remove: (projectId) => {
      if (!isSafeJoyAgentRunOpaqueId(projectId)) return;
      checkpoints.delete(projectId);
    },
    clear: () => checkpoints.clear(),
    serialize: (projectId) => {
      const checkpoint = checkpoints.get(projectId);
      return checkpoint === undefined ? undefined : serializeJoyAgentRunCheckpoint(checkpoint);
    },
    import: (serialized) => {
      const checkpoint = parseJoyAgentRunCheckpoint(serialized);
      if (checkpoint === undefined) return undefined;
      checkpoints.set(checkpoint.snapshot.projectId, checkpoint);
      return cloneCheckpoint(checkpoint);
    },
  };
}

function cloneCheckpoint(checkpoint: JoyAgentRunCheckpoint): JoyAgentRunCheckpoint {
  return createJoyAgentRunCheckpoint(checkpoint.snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
