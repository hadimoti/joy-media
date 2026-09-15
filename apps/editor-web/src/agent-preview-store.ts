import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AgentPreviewTimeline } from './agent-timeline-preview.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';

/** A stable preview surface which a renderer may acknowledge after drawing. */
export type AgentPreviewSurface = 'timeline' | 'document';

export type AgentPreviewReadinessState = 'unmapped' | 'pending' | 'acknowledged';

/**
 * Render acknowledgement is observational only: no surface is ever blocked by
 * an unacknowledged or unmapped sibling surface.
 */
export interface AgentPreviewReadiness {
  readonly timeline: AgentPreviewReadinessState;
  readonly document: AgentPreviewReadinessState;
}

export interface AgentTimelinePreviewState {
  readonly runId: string;
  readonly baseRevision: string;
  /** The immutable bundle revision shared by every preview surface in this stage. */
  readonly bundleVersion: number;
  readonly canonical: AgentPreviewTimeline;
  readonly preview: AgentPreviewTimeline;
}

export interface AgentDocumentPreviewState {
  readonly runId: string;
  readonly baseRevision: string;
  /** The immutable bundle revision shared by every preview surface in this stage. */
  readonly bundleVersion: number;
  readonly canonical: JoyProjectV1;
  readonly preview: JoyProjectV1;
}

/** The data a caller prepares before atomically publishing a preview bundle. */
export interface AgentTimelinePreviewPayload {
  readonly canonical: AgentPreviewTimeline;
  readonly preview: AgentPreviewTimeline;
}

/** The data a caller prepares before atomically publishing a preview bundle. */
export interface AgentDocumentPreviewPayload {
  readonly canonical: JoyProjectV1;
  readonly preview: JoyProjectV1;
}

export interface AgentPreviewBundleInput {
  readonly runId: string;
  readonly baseRevision: string;
  readonly timeline?: AgentTimelinePreviewPayload;
  readonly document?: AgentDocumentPreviewPayload;
}

/**
 * One immutable, revision-bound publication. `timeline` and `document` are
 * built before this object is published, so consumers never observe a
 * sequential half-preview.
 */
export interface AgentPreviewBundle {
  readonly version: number;
  readonly runId: string;
  readonly baseRevision: string;
  readonly timeline?: AgentTimelinePreviewState;
  readonly document?: AgentDocumentPreviewState;
  readonly readiness: AgentPreviewReadiness;
}

/**
 * A bundle is ready when all surfaces it actually maps have rendered once.
 * Unmapped surfaces deliberately impose no readiness requirement.
 */
export function isAgentPreviewBundleReady(bundle: AgentPreviewBundle | undefined): boolean {
  if (bundle === undefined) return false;
  return (
    (bundle.timeline === undefined || bundle.readiness.timeline === 'acknowledged') &&
    (bundle.document === undefined || bundle.readiness.document === 'acknowledged')
  );
}

/**
 * Compatibility snapshot for existing render consumers. Both surface values
 * are references from the store's current immutable bundle; use `getBundle`
 * when the shared bundle metadata or readiness is needed.
 */
export interface AgentPreviewState {
  readonly timeline: AgentTimelinePreviewState | undefined;
  readonly document: AgentDocumentPreviewState | undefined;
}

export interface AgentPreviewStore {
  getState(): AgentPreviewState;
  getBundle(): AgentPreviewBundle | undefined;
  subscribe(listener: () => void): () => void;
  /** Replace the current preview with one fully prepared immutable bundle. */
  publish(input: AgentPreviewBundleInput): AgentPreviewBundle;
  /**
   * Record one renderer acknowledgement for one immutable bundle version
   * without gating any other surface. Unknown/stale runs or versions and
   * unmapped/already-acknowledged surfaces are intentional no-ops, so an
   * old React effect can never certify a subsequently published preview.
   */
  acknowledgeRender(runId: string, bundleVersion: number, surface: AgentPreviewSurface): void;
  clear(runId?: string): void;
}

const EMPTY_PREVIEW_STATE: AgentPreviewState = Object.freeze({
  timeline: undefined,
  document: undefined,
});

/**
 * Preview payloads are project-shaped plain data. Reject exotic mutable values
 * rather than accidentally exposing an object whose mutation cannot be made
 * safe by `Object.freeze` (for example, Date, Map, or typed arrays).
 */
function assertPlainPreviewData(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || value === undefined) return;
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean' ||
    valueType === 'bigint'
  )
    return;
  if (valueType === 'symbol' || valueType === 'function')
    throw new TypeError('Agent preview bundles must contain plain data only.');
  if (valueType !== 'object') return;

  const objectValue = value as object;
  if (seen.has(objectValue)) return;
  seen.add(objectValue);

  if (!Array.isArray(objectValue)) {
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Agent preview bundles must contain plain data only.');
  }

  for (const key of Reflect.ownKeys(objectValue)) {
    if (typeof key === 'symbol')
      throw new TypeError('Agent preview bundles must contain plain data only.');
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor))
      throw new TypeError('Agent preview bundles must contain plain data only.');
    assertPlainPreviewData(descriptor.value, seen);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor !== undefined && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

/**
 * Isolate caller input first, then freeze the isolated graph. The bundle types
 * are intentionally JSON-like, so structured clone retains their complete
 * shape while preventing an input or output reference from mutating the store.
 */
function cloneAndFreeze<T>(value: T): T {
  assertPlainPreviewData(value);
  return deepFreeze(structuredClone(value));
}

function stateFromBundle(bundle: AgentPreviewBundle | undefined): AgentPreviewState {
  if (bundle === undefined) return EMPTY_PREVIEW_STATE;
  return Object.freeze({ timeline: bundle.timeline, document: bundle.document });
}

export function createAgentPreviewStore(): AgentPreviewStore {
  let state = EMPTY_PREVIEW_STATE;
  let bundle: AgentPreviewBundle | undefined;
  let nextBundleVersion = 1;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    getState: () => state,
    getBundle: () => bundle,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (input) => {
      if (input.timeline === undefined && input.document === undefined)
        throw new TypeError('An agent preview bundle must contain at least one surface.');

      const version = nextBundleVersion;
      nextBundleVersion += 1;
      const nextBundle = cloneAndFreeze({
        version,
        runId: input.runId,
        baseRevision: input.baseRevision,
        ...(input.timeline === undefined
          ? {}
          : {
              timeline: {
                runId: input.runId,
                baseRevision: input.baseRevision,
                bundleVersion: version,
                canonical: input.timeline.canonical,
                preview: input.timeline.preview,
              },
            }),
        ...(input.document === undefined
          ? {}
          : {
              document: {
                runId: input.runId,
                baseRevision: input.baseRevision,
                bundleVersion: version,
                canonical: input.document.canonical,
                preview: input.document.preview,
              },
            }),
        readiness: {
          timeline: input.timeline === undefined ? 'unmapped' : 'pending',
          document: input.document === undefined ? 'unmapped' : 'pending',
        },
      } satisfies AgentPreviewBundle);

      bundle = nextBundle;
      state = stateFromBundle(bundle);
      notify();
      return nextBundle;
    },
    acknowledgeRender: (runId, bundleVersion, surface) => {
      const current = bundle;
      if (
        current === undefined ||
        current.runId !== runId ||
        current.version !== bundleVersion ||
        current[surface] === undefined ||
        current.readiness[surface] !== 'pending'
      )
        return;

      // Every non-readiness object came from an immutable internal bundle, so
      // retaining those references preserves isolation without a costly clone.
      bundle = deepFreeze({
        ...current,
        readiness: { ...current.readiness, [surface]: 'acknowledged' },
      });
      state = stateFromBundle(bundle);
      notify();
    },
    clear: (runId) => {
      if (runId !== undefined && bundle?.runId !== runId) return;
      if (bundle === undefined) return;
      bundle = undefined;
      state = EMPTY_PREVIEW_STATE;
      notify();
    },
  };
}

export const appAgentPreviewStore = createAgentPreviewStore();
export const AgentPreviewContext = createContext<AgentPreviewStore>(appAgentPreviewStore);

export function AgentPreviewProvider({
  store,
  children,
}: {
  readonly store: AgentPreviewStore;
  readonly children: ReactNode;
}) {
  return createElement(AgentPreviewContext.Provider, { value: store }, children);
}

export function useAgentPreviewSnapshot(): AgentPreviewState {
  const store = useContext(AgentPreviewContext);
  return useSyncExternalStore(store.subscribe, store.getState, () => EMPTY_PREVIEW_STATE);
}
