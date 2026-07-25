import { useMemo, useState, useCallback } from 'react';
import type { JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { listTransitionShaders } from '@joy-media/transition-shaders';
import type { TransitionDragPayload } from '@joy-media/visual-effects';
import { TrashIcon } from './icons.js';

const SHADER_CATALOG = listTransitionShaders();

interface TransitionsPanelProps {
  readonly project: JoyProjectV1;
  readonly selectedClipIds: readonly string[];
  readonly onAddTransition: (transition: Omit<TransitionV1, 'id'>) => void;
  readonly onRemoveTransition: (transitionId: string) => void;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

export function TransitionsPanel({
  project,
  selectedClipIds,
  onAddTransition,
  onRemoveTransition,
  onUpdateTransition,
  showToast,
}: TransitionsPanelProps) {
  const rootComp = project.compositions[project.rootCompositionId];
  const transitions = project.transitions ?? [];
  const [pendingType, setPendingType] = useState('dissolve');

  const relevantTransitions = useMemo(() => {
    if (selectedClipIds.length === 0) return transitions;
    return transitions.filter(
      (t) => selectedClipIds.includes(t.leftClipId) || selectedClipIds.includes(t.rightClipId),
    );
  }, [transitions, selectedClipIds]);

  const availableJunctions = useMemo(() => {
    if (!rootComp || selectedClipIds.length === 0) return [];

    const junctions: {
      trackId: string;
      trackName: string;
      leftClipId: string;
      rightClipId: string;
    }[] = [];

    for (const track of rootComp.tracks) {
      if (track.kind !== 'video') continue;
      const sortedClips = [...track.clips].sort((a, b) => a.startUs - b.startUs);
      for (let i = 0; i < sortedClips.length - 1; i++) {
        const left = sortedClips[i];
        const right = sortedClips[i + 1];
        if (!left || !right) continue;
        const gapUs = right.startUs - (left.startUs + left.durationUs);
        if (gapUs <= 0) {
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
  }, [rootComp, selectedClipIds]);

  const selectedJunction = availableJunctions[0] ?? null;

  const handleAddTransition = useCallback((type: string) => {
    if (!selectedJunction) {
      showToast('Add two overlapping clips on a video track to create a transition.', 'info');
      return;
    }
    const entry = SHADER_CATALOG.find((item) => item.id === type);
    const params: Record<string, number> = {};
    if (entry !== undefined) {
      for (const [key, value] of Object.entries(entry.defaultParams)) {
        if (typeof value === 'number') params[key] = value;
      }
    }
    onAddTransition({
      trackId: selectedJunction.trackId,
      leftClipId: selectedJunction.leftClipId,
      rightClipId: selectedJunction.rightClipId,
      type,
      durationUs: 500_000,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
    setPendingType(type);
  }, [selectedJunction, onAddTransition, showToast]);

  const handleDragStart = useCallback((type: string, event: React.DragEvent) => {
    const payload: TransitionDragPayload = {
      kind: 'joy/transition',
      transitionId: type,
      source: 'transitions-panel',
    };
    event.dataTransfer.setData('application/x-joy-transition', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleDurationChange = (transitionId: string, durationUs: number) => {
    onUpdateTransition(transitionId, {
      durationUs: Math.max(50_000, Math.min(5_000_000, durationUs)),
    });
  };

  const handleTypeChange = (transitionId: string, type: string) => {
    const entry = SHADER_CATALOG.find((item) => item.id === type);
    const params: Record<string, number> = {};
    if (entry !== undefined) {
      for (const [key, value] of Object.entries(entry.defaultParams)) {
        if (typeof value === 'number') params[key] = value;
      }
    }
    onUpdateTransition(transitionId, {
      type,
      ...(Object.keys(params).length > 0 ? { params } : { params: {} }),
    });
  };

  const handleParamChange = (transitionId: string, key: string, value: number) => {
    const current = transitions.find((t) => t.id === transitionId);
    if (current === undefined) return;
    onUpdateTransition(transitionId, {
      params: { ...(current.params ?? {}), [key]: value },
    });
  };

  return (
    <article className="transitions-panel">
      <section className="transitions-section" aria-label="Add transition">
        <h3>Add Transition</h3>
        {selectedJunction && (
          <div className="junction-info">
            <span className="junction-label">
              {selectedJunction.trackName}: {selectedJunction.leftClipId} →{' '}
              {selectedJunction.rightClipId}
            </span>
          </div>
        )}
        <div className="transition-type-picker" role="group" aria-label="Transition type">
          {SHADER_CATALOG.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="transition-type-btn"
              aria-pressed={pendingType === entry.id}
              onClick={() => handleAddTransition(entry.id)}
              aria-label={entry.label}
              data-guide={entry.label}
              draggable
              onDragStart={(e) => handleDragStart(entry.id, e)}
            >
              <img
                className="transition-type-thumb"
                src={`/transitions/preview/${entry.id}.png`}
                alt=""
                width={60}
                height={60}
                loading="lazy"
              />
              <span className="transition-type-name">{entry.label}</span>
            </button>
          ))}
        </div>
        <label className="control-row">
          <span>Selected</span>
          <select
            value={pendingType}
            onChange={(event) => setPendingType(event.target.value)}
            aria-label="Transition catalog"
          >
            {SHADER_CATALOG.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-button icon-button-labeled"
            onClick={() => handleAddTransition(pendingType)}
            aria-label={`Add ${pendingType}`}
            data-guide="Add transition"
          >
            Add
          </button>
        </label>
      </section>

      {relevantTransitions.length > 0 && (
        <section className="transitions-section" aria-label="Existing transitions">
          <h3>Transitions ({relevantTransitions.length})</h3>
          <ul className="transition-list" role="list">
            {relevantTransitions.map((t) => {
              const entry = SHADER_CATALOG.find((item) => item.id === t.type);
              const numericParams = Object.entries(entry?.defaultParams ?? {}).filter(
                ([, value]) => typeof value === 'number',
              ) as readonly [string, number][];
              return (
                <li key={t.id} className="transition-item">
                  <div className="transition-header">
                    <span className="transition-type-badge">{entry?.label ?? t.type}</span>
                    <span className="transition-clips">
                      {t.leftClipId} → {t.rightClipId}
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => onRemoveTransition(t.id)}
                      aria-label={`Remove ${t.type} transition`}
                      title="Remove transition"
                      data-guide="Remove"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  <div className="transition-controls">
                    <label className="control-row">
                      <span>Type</span>
                      <select
                        value={t.type}
                        onChange={(e) => handleTypeChange(t.id, e.target.value)}
                        aria-label="Transition type"
                      >
                        {SHADER_CATALOG.map(({ id, label }) => (
                          <option key={id} value={id}>
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
                    {numericParams.map(([key, fallback]) => (
                      <label key={key} className="control-row">
                        <span>{key}</span>
                        <input
                          type="range"
                          min={0}
                          max={key === 'waves' ? 60 : 2}
                          step={0.05}
                          value={t.params?.[key] ?? fallback}
                          onChange={(e) => handleParamChange(t.id, key, Number(e.target.value))}
                          aria-label={`${key} parameter`}
                        />
                        <span className="duration-value">
                          {(t.params?.[key] ?? fallback).toFixed(2)}
                        </span>
                      </label>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
