import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AgentPreviewTimeline } from './agent-timeline-preview.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';

export interface AgentTimelinePreviewState {
  readonly runId: string;
  readonly baseRevision: string;
  readonly canonical: AgentPreviewTimeline;
  readonly preview: AgentPreviewTimeline;
}

export interface AgentDocumentPreviewState {
  readonly runId: string;
  readonly baseRevision: string;
  readonly canonical: JoyProjectV1;
  readonly preview: JoyProjectV1;
}

export interface AgentPreviewState {
  readonly timeline: AgentTimelinePreviewState | undefined;
  readonly document: AgentDocumentPreviewState | undefined;
}

export interface AgentPreviewStore {
  getState(): AgentPreviewState;
  subscribe(listener: () => void): () => void;
  setTimeline(value: AgentTimelinePreviewState): void;
  setDocument(value: AgentDocumentPreviewState): void;
  clear(runId?: string): void;
}

const EMPTY_PREVIEW_STATE: AgentPreviewState = Object.freeze({
  timeline: undefined,
  document: undefined,
});

export function createAgentPreviewStore(): AgentPreviewStore {
  let state = EMPTY_PREVIEW_STATE;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTimeline: (value) => {
      state = Object.freeze({ ...state, timeline: Object.freeze({ ...value }) });
      notify();
    },
    setDocument: (value) => {
      state = Object.freeze({ ...state, document: Object.freeze({ ...value }) });
      notify();
    },
    clear: (runId) => {
      if (runId !== undefined && state.timeline?.runId !== runId && state.document?.runId !== runId)
        return;
      if (state.timeline === undefined && state.document === undefined) return;
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
