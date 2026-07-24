import { useMemo } from 'react';
import type { JoyProjectV1, TransitionV1, ClipV1, TrackV1 } from '@joy-media/project-schema';
import { DissolveIcon, WipeIcon, SlideIcon } from './icons.js';

export type TransitionType = 'dissolve' | 'wipe' | 'slide';

const TRANSITION_TYPES: readonly { readonly type: TransitionType; readonly label: string; readonly icon: () => React.ReactElement }[] = [
  { type: 'dissolve', label: 'Dissolve', icon: DissolveIcon },
  { type: 'wipe', label: 'Wipe', icon: WipeIcon },
  { type: 'slide', label: 'Slide', icon: SlideIcon },
];

interface TransitionsPanelProps {
  readonly project: JoyProjectV1;
  readonly selectedClipIds: readonly string[];
  readonly onAddTransition: (transition: Omit<TransitionV1, 'id'>) => void;
  readonly onRemoveTransition: (transitionId: string) => void;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
}

export function TransitionsPanel({
  project,
  selectedClipIds,
  onAddTransition,
  onRemoveTransition,
  onUpdateTransition,
}: TransitionsPanelProps) {
  const rootComp = project.compositions[project.rootCompositionId];
  const transitions = project.transitions ?? [];

  // Find transitions relevant to the selected clip(s)
  const relevantTransitions = useMemo(() => {
    if (selectedClipIds.length === 0) return transitions;
    return transitions.filter(
      (t) => selectedClipIds.includes(t.leftClipId) || selectedClipIds.includes(t.rightClipId),
    );
  }, [transitions, selectedClipIds]);

  // Find adjacent clips on the same track for potential transitions
  const availableJunctions = useMemo(() => {
    if (!rootComp || selectedClipIds.length === 0) return [];

    const junctions: { trackId: string; trackName: string; leftClipId: string; rightClipId: string }[] = [];

    for (const track of rootComp.tracks) {
      if (track.kind !== 'video') continue;

      const sortedClips = [...track.clips].sort((a, b) => a.startUs - b.startUs);

      for (let i = 0; i < sortedClips.length - 1; i++) {
        const left = sortedClips[i];
        const right = sortedClips[i + 1];

        if (!left || !right) continue;

        // Check if they're adjacent (touching or overlapping slightly)
        const gapUs = right.startUs - (left.startUs + left.durationUs);
        if (gapUs <= 0) {
          // They touch or overlap — valid junction for a transition
          junctions.push({
            trackId: track.id,
            trackName: track.name,
            leftClipId: left.id,
            rightClipId: right.id,
          });
        }
      }
    }
    return junctions;
  }, [rootComp]);

  const selectedJunction = availableJunctions.length > 0 ? availableJunctions[0] : null; // default to first available

  const handleAddTransition = () => {
    if (!selectedJunction) return;

    const newTransition: Omit<TransitionV1, 'id'> = {
      trackId: selectedJunction.trackId,
      leftClipId: selectedJunction.leftClipId,
      rightClipId: selectedJunction.rightClipId,
      type: 'dissolve',
      durationUs: 500_000, // 0.5s default
    };
    onAddTransition(newTransition);
  };

  const handleDurationChange = (transitionId: string, durationUs: number) => {
    onUpdateTransition(transitionId, { durationUs: Math.max(50_000, Math.min(5_000_000, durationUs)) });
  };

  const handleTypeChange = (transitionId: string, type: TransitionType) => {
    onUpdateTransition(transitionId, { type });
  };

  if (!rootComp) return <div className="transitions-panel empty">No root composition</div>;

  return (
    <div className="transitions-panel">
      <section className="transitions-section" aria-label="Add transition">
        <h3>Add Transition</h3>
        {availableJunctions.length === 0 ? (
          <p className="empty-hint">
            Select two adjacent clips on a video track to add a transition between them.
          </p>
        ) : (
          <div className="junction-info">
            {selectedJunction && (
              <>
                <span className="junction-label">
                  {selectedJunction.trackName}: {selectedJunction.leftClipId} →{' '}
                  {selectedJunction.rightClipId}
                </span>
                <div className="transition-type-picker" role="group" aria-label="Transition type">
                  {TRANSITION_TYPES.map(({ type, label, icon: Icon }) => (
                    <button
                      key={type}
                      className="icon-button transition-type-btn"
                      onClick={() => handleAddTransition()}
                      aria-label={label}
                      data-guide={label}
                    >
                      <Icon />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {relevantTransitions.length > 0 && (
        <section className="transitions-section" aria-label="Existing transitions">
          <h3>Transitions ({relevantTransitions.length})</h3>
          <ul className="transition-list" role="list">
            {relevantTransitions.map((t) => (
              <li key={t.id} className="transition-item">
                <div className="transition-header">
                  <span className="transition-type-badge">{t.type}</span>
                  <span className="transition-clips">
                    {t.leftClipId} → {t.rightClipId}
                  </span>
                  <button
                    className="icon-button danger"
                    onClick={() => onRemoveTransition(t.id)}
                    aria-label={`Remove ${t.type} transition`}
                    title="Remove transition"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
                <div className="transition-controls">
                  <label className="control-row">
                    <span>Type</span>
                    <select
                      value={t.type}
                      onChange={(e) => handleTypeChange(t.id, e.target.value as TransitionType)}
                      aria-label="Transition type"
                    >
                      {TRANSITION_TYPES.map(({ type, label }) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="control-row">
                    <span>Duration</span>
                    <input
                      type="range"
                      min={50000}
                      max={5000000}
                      step={50000}
                      value={t.durationUs}
                      onChange={(e) => handleDurationChange(t.id, Number(e.target.value))}
                      aria-label="Transition duration in seconds"
                    />
                    <span className="duration-value">
                      {(t.durationUs / 1_000_000).toFixed(1)}s
                    </span>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}