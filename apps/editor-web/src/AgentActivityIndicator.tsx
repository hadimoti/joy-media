import { useEffect, useMemo, useRef, useState } from 'react';
import { panelLabel } from './panel-tab-icons.js';
import {
  useAgentPresenceSnapshot,
  type AgentPresenceState,
  type JoyAgentTarget,
} from './agent-presence.js';

const PHASE_LABELS: Readonly<Record<AgentPresenceState['phase'], string>> = {
  idle: 'Idle',
  connecting: 'Connecting',
  thinking: 'Thinking',
  inspecting: 'Inspecting',
  planning: 'Planning',
  previewing: 'Previewing',
  'awaiting-approval': 'Needs approval',
  applying: 'Applying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const SECTION_LABELS: Readonly<Record<string, string>> = {
  composer: 'Composer',
  brief: 'Creative Brief',
  '3d': '3D',
  preview: 'Preview',
  timeline: 'Timeline',
  media: 'Media',
  text: 'Text',
  captions: 'Captions',
  audio: 'Audio',
  templates: 'Templates',
  motion: 'Motion',
  transitions: 'Transitions',
  effects: 'Effects',
  filters: 'Filters',
  color: 'Color',
  adjust: 'Adjust',
  visual: 'Visual',
  enhance: 'Enhance',
  mask: 'Mask',
  inspector: 'Inspector',
  speed: 'Speed',
};

function targetLabel(target: JoyAgentTarget | undefined): string {
  if (target === undefined) return 'JOY workspace';
  const section = target.sectionId === undefined ? undefined : SECTION_LABELS[target.sectionId];
  return section === undefined
    ? panelLabel(target.panelId)
    : `${panelLabel(target.panelId)} · ${section}`;
}

function stateLabel(state: AgentPresenceState): string {
  const phase = PHASE_LABELS[state.phase];
  const target = targetLabel(state.targets[0] ?? state.terminalTarget);
  if (state.progress !== undefined) {
    return `${phase} · ${target} · ${state.progress.current} of ${state.progress.total}`;
  }
  return `${phase} · ${target}`;
}

export interface AgentActivityIndicatorProps {
  readonly onShowTarget?: (target: JoyAgentTarget) => void;
  readonly onStop?: (runId: string) => void;
}

/** A compact, provider-neutral live status rail for the app header. */
export function AgentActivityIndicator({ onShowTarget, onStop }: AgentActivityIndicatorProps) {
  const state = useAgentPresenceSnapshot();
  const [follow, setFollow] = useState(false);
  // Prefer the edited surface over the Composer origin so the live rail tells
  // the user which tab is actually being previewed.
  const primaryTarget =
    state.targets.find((target) => target.panelId !== 'agent') ??
    state.targets[0] ??
    state.terminalTarget;
  const label = useMemo(() => stateLabel(state), [state]);
  const showTargetRef = useRef(onShowTarget);
  showTargetRef.current = onShowTarget;
  const terminal =
    state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
  const primaryTargetKey =
    primaryTarget === undefined
      ? ''
      : `${primaryTarget.panelId}:${primaryTarget.sectionId ?? ''}:${primaryTarget.entity?.kind ?? ''}:${primaryTarget.entity?.id ?? ''}`;
  useEffect(() => {
    if (!follow || terminal || primaryTarget === undefined) return;
    showTargetRef.current?.(primaryTarget);
  }, [follow, primaryTarget, primaryTargetKey, terminal]);
  if (state.status === 'idle') return null;
  const canStop = !terminal && state.runId !== undefined;
  return (
    <div
      className={`agent-activity-rail agent-activity-rail--${state.status} agent-activity-rail--${state.phase}`}
      data-agent-activity="true"
      data-agent-phase={state.phase}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="agent-activity-mark" aria-hidden="true">
        <span className="agent-activity-mark-core" />
      </span>
      <span className="agent-activity-copy">
        <span className="agent-activity-phase">{PHASE_LABELS[state.phase]}</span>
        <span className="agent-activity-target">{targetLabel(primaryTarget)}</span>
      </span>
      {state.progress !== undefined && (
        <span
          className="agent-activity-progress"
          role="progressbar"
          aria-label="Agent progress"
          aria-valuemin={0}
          aria-valuemax={state.progress.total}
          aria-valuenow={state.progress.current}
        >
          {state.progress.current}/{state.progress.total}
        </span>
      )}
      {primaryTarget !== undefined && !terminal && (
        <button
          type="button"
          className="agent-activity-action"
          onClick={() => onShowTarget?.(primaryTarget)}
        >
          Show target
        </button>
      )}
      {state.runId !== undefined && !terminal && (
        <label className="agent-activity-follow">
          <input
            type="checkbox"
            checked={follow}
            onChange={(event) => setFollow(event.currentTarget.checked)}
          />
          Follow
        </label>
      )}
      {canStop && (
        <button
          type="button"
          className="agent-activity-action agent-activity-stop"
          aria-label="Stop agent"
          onClick={() => onStop?.(state.runId!)}
        >
          Stop
        </button>
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
