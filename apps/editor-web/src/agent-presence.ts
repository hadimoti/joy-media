import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { PanelId } from './workspace.js';

/** The only phases that may be shown by a JOY Agent surface. */
export const JOY_AGENT_PHASES = [
  'connecting',
  'thinking',
  'inspecting',
  'planning',
  'previewing',
  'awaiting-approval',
  'applying',
  'completed',
  'failed',
  'cancelled',
] as const;
export type JoyAgentPhase = (typeof JOY_AGENT_PHASES)[number];

export type JoyAgentPresenceStatus = 'idle' | 'active' | 'completed' | 'failed' | 'cancelled';
export type JoyAgentEntityKind = 'clip' | 'track' | 'asset' | 'property' | 'brief' | 'scene';

/** A trusted UI target. These values are produced by the code-owned target map. */
export interface JoyAgentTarget {
  readonly panelId: PanelId;
  readonly sectionId?: string;
  readonly entity?: { readonly kind: JoyAgentEntityKind; readonly id: string };
}

export interface JoyAgentMeasuredProgress {
  readonly current: number;
  readonly total: number;
}

export interface JoyAgentPreviewPresence {
  readonly revision: number;
  readonly summaryCode: string;
  readonly targetCount: number;
}

/**
 * Safe, UI-facing event contract. It deliberately contains codes and IDs only;
 * provider prompts, model output, tool payloads, URLs, and error objects never
 * cross this boundary.
 */
export interface JoyAgentPresenceEvent {
  readonly protocolVersion: 1;
  readonly runId: string;
  readonly seq: number;
  readonly at: string;
  readonly revision: number;
  readonly kind:
    | 'activity'
    | 'progress'
    | 'preview'
    | 'approval-required'
    | 'completed'
    | 'failed'
    | 'cancelled';
  readonly phase: JoyAgentPhase;
  readonly targets?: readonly JoyAgentTarget[];
  readonly progress?: JoyAgentMeasuredProgress;
  readonly preview?: JoyAgentPreviewPresence;
  readonly errorCode?:
    | 'JOY_AGENT_ABORTED'
    | 'JOY_AGENT_TIMEOUT'
    | 'JOY_AGENT_CORS_OR_NETWORK'
    | 'JOY_AGENT_AUTH_FAILED'
    | 'JOY_AGENT_RESPONSE_TOO_LARGE'
    | 'JOY_AGENT_INVALID_TOOL'
    | 'JOY_AGENT_INVALID_PROPOSAL'
    | 'JOY_AGENT_STALE_REVISION'
    | 'JOY_AGENT_PROVIDER_INCOMPATIBLE';
}

export interface AgentPresenceState {
  readonly status: JoyAgentPresenceStatus;
  readonly runId: string | undefined;
  readonly seq: number;
  readonly revision: number;
  readonly phase: JoyAgentPhase | 'idle';
  readonly targets: readonly JoyAgentTarget[];
  readonly progress: JoyAgentMeasuredProgress | undefined;
  readonly preview: JoyAgentPreviewPresence | undefined;
  /** The terminal target stays long enough for the green confirmation marker. */
  readonly terminalTarget: JoyAgentTarget | undefined;
  readonly terminalAt: string | undefined;
}

export const EMPTY_AGENT_PRESENCE: AgentPresenceState = Object.freeze({
  status: 'idle',
  runId: undefined,
  seq: -1,
  revision: 0,
  phase: 'idle',
  targets: [],
  progress: undefined,
  preview: undefined,
  terminalTarget: undefined,
  terminalAt: undefined,
});

function validProgress(progress: JoyAgentMeasuredProgress | undefined): boolean {
  return (
    progress !== undefined &&
    Number.isSafeInteger(progress.current) &&
    Number.isSafeInteger(progress.total) &&
    progress.total > 0 &&
    progress.current >= 0 &&
    progress.current <= progress.total
  );
}

function targetKey(target: JoyAgentTarget): string {
  return `${target.panelId}:${target.sectionId ?? ''}:${target.entity?.kind ?? ''}:${target.entity?.id ?? ''}`;
}

function distinctTargets(targets: readonly JoyAgentTarget[] | undefined): readonly JoyAgentTarget[] {
  if (targets === undefined || targets.length === 0) return [];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Monotonic reducer. A caller starts a new run with beginRun; events cannot
 * silently switch a live run or resurrect a terminal run.
 */
export function reduceAgentPresence(
  state: AgentPresenceState,
  event: JoyAgentPresenceEvent,
): AgentPresenceState {
  if (event.protocolVersion !== 1 || event.seq <= state.seq) return state;
  if (state.runId !== undefined && event.runId !== state.runId) return state;
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled')
    return state;
  if (event.revision < state.revision) return state;

  const targets = event.targets === undefined ? state.targets : distinctTargets(event.targets);
  const primaryTarget = targets[0];
  const phase = event.phase;
  if (event.kind === 'cancelled' || event.kind === 'failed') {
    return Object.freeze({
      ...state,
      status: event.kind,
      runId: event.runId,
      seq: event.seq,
      revision: event.revision,
      phase,
      targets: [],
      progress: undefined,
      preview: undefined,
      terminalTarget: undefined,
      terminalAt: event.at,
    });
  }
  if (event.kind === 'completed') {
    return Object.freeze({
      ...state,
      status: 'completed',
      runId: event.runId,
      seq: event.seq,
      revision: event.revision,
      phase: 'completed',
      targets,
      progress: validProgress(event.progress) ? event.progress : undefined,
      preview: undefined,
      terminalTarget: primaryTarget,
      terminalAt: event.at,
    });
  }
  return Object.freeze({
    ...state,
    status: phase === 'awaiting-approval' ? 'active' : 'active',
    runId: event.runId,
    seq: event.seq,
    revision: event.revision,
    phase,
    targets,
    progress: validProgress(event.progress) ? event.progress : event.kind === 'progress' ? undefined : state.progress,
    preview:
      event.kind === 'preview' && event.preview?.revision === event.revision
        ? event.preview
        : event.kind === 'preview'
          ? undefined
          : state.preview,
    terminalTarget: undefined,
    terminalAt: undefined,
  });
}

export interface AgentPanelPresence {
  readonly panelId: PanelId;
  readonly active: boolean;
  readonly phase: JoyAgentPhase | 'idle';
  readonly status: JoyAgentPresenceStatus;
  readonly awaitingApproval: boolean;
  readonly progress: JoyAgentMeasuredProgress | undefined;
  readonly targetCount: number;
}

export interface AgentSectionPresence extends AgentPanelPresence {
  readonly sectionId: string;
  readonly active: boolean;
}

export interface AgentEntityPresence {
  readonly kind: JoyAgentEntityKind;
  readonly id: string;
  readonly active: boolean;
  readonly phase: JoyAgentPhase | 'idle';
}

export interface AgentPresenceStore {
  getState(): AgentPresenceState;
  subscribe(listener: () => void): () => void;
  subscribeSelector<T>(selector: () => T, listener: () => void): () => void;
  dispatch(event: JoyAgentPresenceEvent): void;
  beginRun(runId: string, revision: number): void;
  invalidatePreview(revision: number): void;
  completeHandoff(): void;
  clear(): void;
  getPanelPresence(panelId: PanelId): AgentPanelPresence;
  getSectionPresence(panelId: PanelId, sectionId: string): AgentSectionPresence;
  getEntityPresence(kind: JoyAgentEntityKind, id: string): AgentEntityPresence;
}

function panelPresence(state: AgentPresenceState, panelId: PanelId): AgentPanelPresence {
  const targets = state.targets.filter((target) => target.panelId === panelId);
  return Object.freeze({
    panelId,
    active: targets.length > 0 || state.terminalTarget?.panelId === panelId,
    phase: state.phase,
    status: state.status,
    awaitingApproval: state.phase === 'awaiting-approval',
    progress: state.progress,
    targetCount: targets.length,
  });
}

export function createAgentPresenceStore(): AgentPresenceStore {
  let state = EMPTY_AGENT_PRESENCE;
  const listeners = new Set<() => void>();
  const panelCache = new Map<PanelId, { key: string; value: AgentPanelPresence }>();
  const sectionCache = new Map<string, { key: string; value: AgentSectionPresence }>();
  const entityCache = new Map<string, { key: string; value: AgentEntityPresence }>();

  const notify = (previous: AgentPresenceState) => {
    if (previous === state) return;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const subscribeSelector = <T,>(selector: () => T, listener: () => void) => {
    let selected = selector();
    return subscribe(() => {
      const next = selector();
      if (Object.is(next, selected)) return;
      selected = next;
      listener();
    });
  };

  return {
    getState: () => state,
    subscribe,
    subscribeSelector,
    dispatch: (event) => {
      const previous = state;
      state = reduceAgentPresence(state, event);
      notify(previous);
    },
    beginRun: (runId, revision) => {
      const previous = state;
      state = Object.freeze({
        ...EMPTY_AGENT_PRESENCE,
        runId,
        revision,
        seq: -1,
      });
      notify(previous);
    },
    invalidatePreview: (revision) => {
      if (revision < state.revision || state.preview === undefined) return;
      const previous = state;
      state = Object.freeze({ ...state, revision, preview: undefined });
      notify(previous);
    },
    completeHandoff: () => {
      if (state.status !== 'completed') return;
      const previous = state;
      state = EMPTY_AGENT_PRESENCE;
      notify(previous);
    },
    clear: () => {
      if (state === EMPTY_AGENT_PRESENCE) return;
      const previous = state;
      state = EMPTY_AGENT_PRESENCE;
      notify(previous);
    },
    getPanelPresence: (panelId) => {
      const key = `${state.runId ?? ''}|${state.seq}|${state.status}|${state.phase}|${state.revision}|${state.targets.map(targetKey).join(',')}|${state.terminalTarget === undefined ? '' : targetKey(state.terminalTarget)}`;
      const cached = panelCache.get(panelId);
      if (cached?.key === key) return cached.value;
      const value = panelPresence(state, panelId);
      panelCache.set(panelId, { key, value });
      return value;
    },
    getSectionPresence: (panelId, sectionId) => {
      const key = `${state.runId ?? ''}|${state.seq}|${state.status}|${state.phase}|${state.revision}|${state.targets.map(targetKey).join(',')}|${state.terminalTarget === undefined ? '' : targetKey(state.terminalTarget)}`;
      const cacheKey = `${panelId}:${sectionId}`;
      const cached = sectionCache.get(cacheKey);
      if (cached?.key === key) return cached.value;
      const panel = panelPresence(state, panelId);
      const active = state.targets.some(
        (target) => target.panelId === panelId && target.sectionId === sectionId,
      );
      const value = Object.freeze({ ...panel, sectionId, active });
      sectionCache.set(cacheKey, { key, value });
      return value;
    },
    getEntityPresence: (kind, id) => {
      const key = `${state.runId ?? ''}|${state.seq}|${state.status}|${state.phase}|${state.revision}|${state.targets.map(targetKey).join(',')}|${state.terminalTarget === undefined ? '' : targetKey(state.terminalTarget)}`;
      const cacheKey = `${kind}:${id}`;
      const cached = entityCache.get(cacheKey);
      if (cached?.key === key) return cached.value;
      const active = state.targets.some(
        (target) => target.entity?.kind === kind && target.entity.id === id,
      );
      const value = Object.freeze({ kind, id, active, phase: state.phase });
      entityCache.set(cacheKey, { key, value });
      return value;
    },
  };
}

export const defaultAgentPresenceStore = createAgentPresenceStore();
export const AgentPresenceContext = createContext<AgentPresenceStore>(defaultAgentPresenceStore);
/** Dockview supplies this per durable panel; nested components need not thread panel IDs. */
export const PanelIdentityContext = createContext<PanelId | undefined>(undefined);

export function AgentPresenceProvider({
  store,
  children,
}: {
  readonly store: AgentPresenceStore;
  readonly children: ReactNode;
}) {
  return createElement(AgentPresenceContext.Provider, { value: store }, children);
}

export function useAgentPresenceStore(): AgentPresenceStore {
  return useContext(AgentPresenceContext);
}

export function useAgentPresenceSnapshot(): AgentPresenceState {
  const store = useAgentPresenceStore();
  return useSyncExternalStore(store.subscribe, store.getState, () => EMPTY_AGENT_PRESENCE);
}

export function useAgentPanelPresence(panelId: PanelId): AgentPanelPresence {
  const store = useAgentPresenceStore();
  return useSyncExternalStore(
    (listener) => store.subscribeSelector(() => store.getPanelPresence(panelId), listener),
    () => store.getPanelPresence(panelId),
    () => panelPresence(EMPTY_AGENT_PRESENCE, panelId),
  );
}

export function useAgentSectionPresence(
  panelId: PanelId,
  sectionId: string,
): AgentSectionPresence {
  const store = useAgentPresenceStore();
  return useSyncExternalStore(
    (listener) =>
      store.subscribeSelector(() => store.getSectionPresence(panelId, sectionId), listener),
    () => store.getSectionPresence(panelId, sectionId),
    () => ({ ...panelPresence(EMPTY_AGENT_PRESENCE, panelId), sectionId, active: false }),
  );
}

export function useAgentEntityPresence(
  kind: JoyAgentEntityKind,
  id: string,
): AgentEntityPresence {
  const store = useAgentPresenceStore();
  return useSyncExternalStore(
    (listener) => store.subscribeSelector(() => store.getEntityPresence(kind, id), listener),
    () => store.getEntityPresence(kind, id),
    () => ({ kind, id, active: false, phase: 'idle' }),
  );
}
