import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyBindingV2,
  type SpikeProject,
  type TransitionV1,
} from '@joy-media/project-schema';
import { sampleCurve } from '@joy-media/motion-core';
import {
  listTransitionShaders,
  listTransitionUniformDescriptors,
  mergeTransitionParams,
} from '@joy-media/transition-shaders';
import type { TransitionDragPayload } from '@joy-media/visual-effects';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { TransitionPreviewCard } from './TransitionPreviewCard.js';
import { StarFilledIcon } from './icons.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
  readTransitionFavorites,
  toggleTransitionFavorite,
  transitionAtJunction,
} from './transition-panel-state.js';
import {
  NumericPropertyControl,
  useTransientPropertyControl,
} from './components/PropertyControlAdapters.js';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';

const SHADER_CATALOG = listTransitionShaders();

interface TransitionsPanelProps {
  readonly project: JoyProjectV1;
  readonly timelineProject: SpikeProject;
  readonly selectedClipIds: readonly string[];
  readonly onAddTransition: (transition: Omit<TransitionV1, 'id'>) => void;
  readonly onRemoveTransition: (transitionId: string) => void;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
  readonly playheadUs?: number;
  readonly onDispatch?: (transaction: VisualObjectTransaction) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

function transitionBinding(transitionId: string, propertyId: string): PropertyBindingV2 {
  return {
    ownerKind: 'transition',
    ownerId: transitionId,
    propertyId,
    timeDomain: 'transition-local',
  };
}

function TransitionUniformRow({
  transition,
  propertyId,
  defaultValue,
  project,
  playheadUs,
  onUpdateTransition,
  onDispatch,
}: {
  readonly transition: TransitionV1;
  readonly propertyId: string;
  readonly defaultValue: number;
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
  readonly onDispatch: ((transaction: VisualObjectTransaction) => void) | undefined;
}) {
  const binding = transitionBinding(transition.id, propertyId);
  const animation = project.propertyAnimations?.[canonicalBindingKey(binding)];
  const curve = animation?.value.kind === 'scalar' ? animation.value.curve : undefined;
  const staticValue = transition.params?.[propertyId] ?? defaultValue;
  const resolvedValue = curve === undefined ? staticValue : sampleCurve(curve, playheadUs);
  const [previewValue, setPreviewValue] = useState(resolvedValue);
  useEffect(() => setPreviewValue(resolvedValue), [resolvedValue]);
  const keyed = curve?.keyframes.some((key) => key.timeUs === playheadUs) === true;
  const animationState: PropertyAnimationState = keyed
    ? 'keyed'
    : curve === undefined
      ? 'none'
      : 'between';

  const commitValue = (next: number) => {
    if (!Number.isFinite(next)) return;
    if (curve !== undefined && onDispatch !== undefined) {
      onDispatch({
        label: `Set transition ${propertyId} keyframe`,
        commands: [
          {
            type: 'propertyAnimation.setKey',
            payload: {
              binding,
              key: {
                kind: 'scalar',
                keyframe: { timeUs: playheadUs, value: next, interpolation: 'linear' },
              },
            },
          },
        ],
      });
      return;
    }
    const params = { ...(transition.params ?? {}), [propertyId]: next };
    onUpdateTransition(transition.id, { params });
  };
  const adapter = useTransientPropertyControl(
    {
      read: () => previewValue,
      preview: setPreviewValue,
      restore: setPreviewValue,
      commit: ({ next }) => commitValue(next),
    },
    `Set transition ${propertyId}`,
  );

  const toggleAnimation = () => {
    if (onDispatch === undefined) return;
    onDispatch({
      label: `${keyed ? 'Remove' : 'Add'} transition ${propertyId} keyframe`,
      commands: [
        keyed
          ? {
              type: 'propertyAnimation.removeKey',
              payload: { binding, timeUs: playheadUs },
            }
          : curve === undefined
            ? {
                type: 'propertyAnimation.replace',
                payload: {
                  binding,
                  value: {
                    kind: 'scalar',
                    curve: {
                      keyframes: [
                        { timeUs: playheadUs, value: previewValue, interpolation: 'linear' },
                      ],
                    },
                  },
                },
              }
            : {
                type: 'propertyAnimation.setKey',
                payload: {
                  binding,
                  key: {
                    kind: 'scalar',
                    keyframe: { timeUs: playheadUs, value: previewValue, interpolation: 'linear' },
                  },
                },
              },
      ],
    });
  };

  return (
    <PropertyRow
      label={propertyId}
      controlId={`transition-${transition.id}-${propertyId}`}
      value={previewValue.toFixed(3)}
      onReset={() => {
        setPreviewValue(defaultValue);
        commitValue(defaultValue);
      }}
      {...(onDispatch === undefined ? {} : { onToggleAnimation: toggleAnimation })}
      animationState={animationState}
    >
      <NumericPropertyControl
        id={`transition-${transition.id}-${propertyId}`}
        value={previewValue}
        adapter={adapter}
        ariaLabel={propertyId}
        step={0.01}
      />
    </PropertyRow>
  );
}

function SelectedTransitionInspector({
  transition,
  project,
  playheadUs,
  onUpdateTransition,
  onDispatch,
}: {
  readonly transition: TransitionV1;
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
  readonly onDispatch: ((transaction: VisualObjectTransaction) => void) | undefined;
}) {
  const params = mergeTransitionParams(transition.type, transition.params);
  const descriptors = listTransitionUniformDescriptors(transition.type).filter(
    (descriptor) => descriptor.animatable && descriptor.type === 'float',
  );
  return (
    <section className="transitions-subsection" aria-label="Selected transition inspector">
      <h4 className="panel-section-title" style={{ marginBottom: 'var(--space-1)' }}>
        Selected transition
      </h4>
      <p className="monitor-meta" dir="ltr">
        {transition.type} · {(transition.durationUs / 1_000_000).toFixed(2)}s · {descriptors.length}{' '}
        animated uniform{descriptors.length === 1 ? '' : 's'}
      </p>
      {descriptors.length === 0 ? (
        <p className="empty-hint">This transition has no animatable float uniforms.</p>
      ) : (
        descriptors.map((descriptor) => {
          const defaultValue = params[descriptor.propertyId];
          if (typeof defaultValue !== 'number') return null;
          return (
            <TransitionUniformRow
              key={descriptor.propertyId}
              transition={transition}
              propertyId={descriptor.propertyId}
              defaultValue={defaultValue}
              project={project}
              playheadUs={playheadUs}
              onUpdateTransition={onUpdateTransition}
              onDispatch={onDispatch}
            />
          );
        })
      )}
    </section>
  );
}

function TransitionCard({
  entry,
  isActive,
  isFavorite,
  onAdd,
  onToggleFavorite,
  onDragStart,
}: {
  readonly entry: { readonly id: string; readonly label: string };
  readonly isActive: boolean;
  readonly isFavorite: boolean;
  readonly onAdd: () => void;
  readonly onToggleFavorite: () => void;
  readonly onDragStart: (event: React.DragEvent) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = cardRef.current;
    if (el === null) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry!.isIntersecting), {
      threshold: 0,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shaderEntry = useMemo(() => SHADER_CATALOG.find((e) => e.id === entry.id), [entry.id]);

  return (
    <div
      ref={cardRef}
      className={`transition-card${isActive ? ' is-active' : ''}`}
      data-transition-type={entry.id}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      aria-label={`${isActive ? 'Selected' : 'Apply'} ${entry.label} transition`}
      draggable
      onDragStart={onDragStart}
      onClick={onAdd}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onAdd();
      }}
      title={entry.label}
    >
      <div className="transition-card-thumb">
        {(visible || isActive) && shaderEntry !== undefined ? (
          <TransitionPreviewCard entry={shaderEntry} isActive={isActive || visible} />
        ) : (
          <div className="transition-card-fallback" />
        )}
      </div>
      <div className="transition-card-footer">
        <span className="transition-card-label">{entry.label}</span>
        <button
          type="button"
          className="icon-button card-fav-btn"
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          title={isFavorite ? 'Remove favorite' : 'Add favorite'}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill={isFavorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M8 2.5l1.5 4.5h4.5l-3.5 2.5 1.3 4.2-3.8-2.8-3.8 2.8 1.3-4.2-3.5-2.5h4.5z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function TransitionsPanel({
  project,
  timelineProject,
  selectedClipIds,
  onAddTransition,
  onRemoveTransition,
  onUpdateTransition,
  playheadUs = 0,
  onDispatch,
  showToast,
}: TransitionsPanelProps) {
  const rootComp = timelineProject.compositions[timelineProject.rootCompositionId];
  const [pendingType, setPendingType] = useState('dissolve');
  const [favorites, setFavorites] = useState<Set<string>>(() =>
    typeof window === 'undefined' ? new Set() : readTransitionFavorites(window.localStorage),
  );
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const toggleFavorite = useCallback(
    (id: string) => {
      if (typeof window === 'undefined') return;
      try {
        setFavorites(toggleTransitionFavorite(window.localStorage, favorites, id));
      } catch {
        showToast('Could not save transition favorites in this browser.', 'error');
      }
    },
    [favorites, showToast],
  );

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
        // "Junction" = two clips that overlap or touch, with a small tolerance
        // so clips left a few ms apart by rounding/splits still count. Matches
        // the drag-to-timeline tolerance so click-add and drag agree.
        const gapUs = right.startUs - (left.startUs + left.durationUs);
        if (gapUs <= 1_000) {
          const selected = new Set(selectedClipIds);
          const isRelevant =
            selected.size === 1
              ? selected.has(left.id) || selected.has(right.id)
              : selected.has(left.id) && selected.has(right.id);
          if (!isRelevant) continue;
          junctions.push({
            trackId: track.id,
            trackName: track.id,
            leftClipId: left.id,
            rightClipId: right.id,
          });
        }
      }
    }
    return junctions;
  }, [rootComp, selectedClipIds]);

  const selectedJunction = availableJunctions[0] ?? null;
  const selectedTransition = transitionAtJunction(project.transitions ?? [], selectedJunction);

  const handleAddTransition = useCallback(
    (type: string) => {
      if (!selectedJunction) {
        // Diagnostic: tell the user exactly why no junction is available.
        if (selectedClipIds.length < 2) {
          showToast('Select two adjacent clips on one video track to add a transition.', 'info');
        } else {
          showToast(
            'The selected clips are not adjacent on one video track. Drag a transition card to the gap or boundary between two clips on the timeline.',
            'info',
          );
        }
        return;
      }
      const entry = SHADER_CATALOG.find((item) => item.id === type);
      const params: Record<string, number> = {};
      if (entry !== undefined) {
        for (const [key, value] of Object.entries(entry.defaultParams)) {
          if (typeof value === 'number') params[key] = value;
        }
      }
      if (selectedTransition === undefined) {
        onAddTransition({
          trackId: selectedJunction.trackId,
          leftClipId: selectedJunction.leftClipId,
          rightClipId: selectedJunction.rightClipId,
          type,
          durationUs: 500_000,
          ...(Object.keys(params).length > 0 ? { params } : {}),
        });
        showToast(`Added ${entry?.label ?? type}`, 'success');
      } else {
        onUpdateTransition(selectedTransition.id, {
          type,
          ...(Object.keys(params).length > 0 ? { params } : { params: {} }),
        });
        showToast(`Replaced with ${entry?.label ?? type}`, 'success');
      }
      setPendingType(type);
    },
    [
      selectedJunction,
      selectedTransition,
      selectedClipIds,
      onAddTransition,
      onUpdateTransition,
      showToast,
    ],
  );

  const handleDragStart = useCallback((type: string, event: React.DragEvent) => {
    const payload: TransitionDragPayload = {
      kind: 'joy/transition',
      transitionId: type,
      source: 'transitions-panel',
    };
    event.dataTransfer.setData('application/x-joy-transition', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const hasFavorites = favorites.size > 0;
  const favItems = hasFavorites ? SHADER_CATALOG.filter((e) => favorites.has(e.id)) : [];

  const q = query.trim().toLowerCase();
  const catalog = SHADER_CATALOG.filter(
    (entry) =>
      (!favoritesOnly || favorites.has(entry.id)) &&
      (q === '' || entry.label.toLowerCase().includes(q) || entry.id.toLowerCase().includes(q)),
  );

  return (
    <PanelShell
      title="Transitions"
      iconUrl={panelTabIconUrl('transitions')}
      className="transitions-panel"
      search={{ value: query, onChange: setQuery, placeholder: 'Search transitions…' }}
      actions={
        <>
          {selectedTransition !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label="Remove selected transition"
              title="Remove transition"
              data-transition-id={selectedTransition.id}
              onClick={() => {
                onRemoveTransition(selectedTransition.id);
                showToast('Transition removed', 'info');
              }}
            >
              ×
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={favoritesOnly ? 'Show all transitions' : 'Show favorites only'}
            title={favoritesOnly ? 'Show all transitions' : 'Show favorites only'}
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            <StarFilledIcon />
          </button>
        </>
      }
    >
      <>
        {hasFavorites && !favoritesOnly && (
          <div className="transitions-subsection">
            <h4 className="panel-section-title" style={{ marginBottom: 'var(--space-1)' }}>
              Favorites
            </h4>
            <div className="transition-type-picker" role="group" aria-label="Favorite transitions">
              {favItems.map((entry) => (
                <TransitionCard
                  key={entry.id}
                  entry={entry}
                  isActive={
                    selectedTransition?.type === entry.id ||
                    (selectedTransition === undefined && pendingType === entry.id)
                  }
                  isFavorite={true}
                  onAdd={() => handleAddTransition(entry.id)}
                  onToggleFavorite={() => toggleFavorite(entry.id)}
                  onDragStart={(e) => handleDragStart(entry.id, e)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="transitions-subsection">
          <h4 className="panel-section-title" style={{ marginBottom: 'var(--space-1)' }}>
            {favoritesOnly ? 'Favorites' : hasFavorites ? 'All' : 'All Transitions'}
          </h4>
          <div className="transition-type-picker" role="group" aria-label="Transition type">
            {catalog.map((entry) => (
              <TransitionCard
                key={entry.id}
                entry={entry}
                isActive={
                  selectedTransition?.type === entry.id ||
                  (selectedTransition === undefined && pendingType === entry.id)
                }
                isFavorite={favorites.has(entry.id)}
                onAdd={() => handleAddTransition(entry.id)}
                onToggleFavorite={() => toggleFavorite(entry.id)}
                onDragStart={(e) => handleDragStart(entry.id, e)}
              />
            ))}
          </div>
        </div>
        {selectedTransition !== undefined && (
          <SelectedTransitionInspector
            transition={selectedTransition}
            project={project}
            playheadUs={playheadUs}
            onUpdateTransition={onUpdateTransition}
            onDispatch={onDispatch}
          />
        )}
      </>
    </PanelShell>
  );
}
