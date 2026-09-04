import { useAgentPresenceSnapshot } from './agent-presence.js';

/** Explicitly labels a staged, revision-bound preview; it never mutates data. */
export function AgentPreviewBadge({
  surface,
  before = false,
  onBeforeChange,
}: {
  readonly surface: string;
  readonly before?: boolean;
  readonly onBeforeChange?: (before: boolean) => void;
}) {
  const state = useAgentPresenceSnapshot();
  const visible =
    state.preview !== undefined &&
    (state.phase === 'previewing' || state.phase === 'awaiting-approval');
  if (!visible) return null;
  return (
    <div
      className={`agent-preview-badge${before ? ' is-before' : ''}`}
      data-agent-preview="true"
      role="region"
      aria-label={`${surface} agent preview`}
    >
      <span className="agent-preview-badge-mark" aria-hidden="true">
        ◇
      </span>
      <span className="agent-preview-badge-copy">
        <strong>AGENT PREVIEW</strong>
        <span>{before ? 'Before · canonical' : 'Staged · not applied'}</span>
      </span>
      {onBeforeChange !== undefined && (
        <label className="agent-preview-toggle">
          <input
            type="checkbox"
            checked={before}
            onChange={(event) => onBeforeChange(event.currentTarget.checked)}
          />
          Before
        </label>
      )}
    </div>
  );
}
