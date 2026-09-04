import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { AgentPreviewTimeline } from './agent-timeline-preview.js';

export interface AgentTimelinePreviewState {
  readonly runId: string;
  readonly baseRevision: string;
  readonly canonical: AgentPreviewTimeline;
  readonly preview: AgentPreviewTimeline;
}

export interface AgentPreviewState {
  readonly timeline: AgentTimelinePreviewState | undefined;
}

export interface AgentPreviewStore {
  getState(): AgentPreviewState;
  subscribe(listener: () => void): () => void;
  setTimeline(value: AgentTimelinePreviewState): void;
  clear(runId?: string): void;
}

const EMPTY_PREVIEW_STATE: AgentPreviewState = Object.freeze({ timeline: undefined });

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
      state = Object.freeze({ timeline: Object.freeze({ ...value }) });
      notify();
    },
    clear: (runId) => {
      if (runId !== undefined && state.timeline?.runId !== runId) return;
      if (state.timeline === undefined) return;
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
