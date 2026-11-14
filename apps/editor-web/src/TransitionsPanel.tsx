import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  canonicalBindingKey,
  type JoyProjectV1,
  type PropertyBindingV2,
  type SpikeProject,
  type TransitionV1,
} from '@joy-media/project-schema';
import { sampleCurve } from '@joy-media/motion-core';
import {
  TRANSITION_CATEGORIES,
  listTransitionShaders,
  listTransitionUniformDescriptors,
  mergeTransitionParams,
  resolveTransitionShaderId,
  type TransitionCategoryId,
} from '@joy-media/transition-shaders';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { beginEditorPointerDrag } from './editor-pointer-dnd.js';
import { LibraryCard } from './LibraryCard.js';
import { LibraryRail } from './LibraryRail.js';
import { TransitionPreviewCard } from './TransitionPreviewCard.js';
import { LayersIcon, StarIcon } from './icons.js';
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
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import './library-panels.css';

const SHADER_CATALOG = listTransitionShaders();
const TRANSITION_PREVIEW_REST_FRAME = '/assets/transition-preview-frame-a.svg';

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
  /** Root writer-gated adapter; omitted only for non-persistent isolated renders. */
  readonly storage?: BrowserKeyValueStore;
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
}: {
  readonly entry: { readonly id: string; readonly label: string; readonly description?: string };
  readonly isActive: boolean;
  readonly isFavorite: boolean;
  readonly onAdd: () => void;
  readonly onToggleFavorite: () => void;
}) {
  const shaderEntry = useMemo(() => SHADER_CATALOG.find((e) => e.id === entry.id), [entry.id]);

  return (
    <LibraryCard
      id={entry.id}
      name={entry.label}
      description={entry.description ?? entry.label}
      preview={(previewActive) => (
        <div className="transition-card-thumb">
          <img
            className="transition-card-rest-frame"
            src={TRANSITION_PREVIEW_REST_FRAME}
            alt=""
            width="320"
            height="180"
          />
          {previewActive && shaderEntry !== undefined && (
            <TransitionPreviewCard entry={shaderEntry} isActive={true} />
          )}
        </div>
      )}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      onAdd={onAdd}
      active={isActive}
      className="transition-card"
      title={`${entry.description === undefined ? entry.label : `${entry.label}: ${entry.description}`}. Drag onto a cut between clips.`}
      onPointerDown={(event) => {
        beginEditorPointerDrag(event.nativeEvent, event.currentTarget, {
          kind: 'transition',
          transitionId: entry.id,
        });
      }}
    />
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
  storage,
}: TransitionsPanelProps) {
  const rootComp = timelineProject.compositions[timelineProject.rootCompositionId];
  const [pendingType, setPendingType] = useState('gl:fade');
  const [storedFavorites, setFavorites] = useState<Set<string>>(() =>
    storage === undefined ? new Set() : readTransitionFavorites(storage),
  );
  // Favourites saved before T-V08 may name a removed id (`dissolve`, `wipe`, `slide`).
  const favorites = useMemo(
    () => new Set([...storedFavorites].map(resolveTransitionShaderId)),
    [storedFavorites],
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TransitionCategoryId | 'all' | 'favorites'>('all');

  // Dockview may render a cached panel before its writer-gated provider is
  // attached. Hydrate only when that adapter exists; do not use raw storage
  // during the transition.
  useEffect(() => {
    if (storage !== undefined) setFavorites(readTransitionFavorites(storage));
  }, [storage]);

  const toggleFavorite = useCallback(
    (id: string) => {
      if (storage === undefined) return;
      try {
        setFavorites(toggleTransitionFavorite(storage, favorites, id));
      } catch {
        showToast('Could not save transition favorites in this browser.', 'error');
      }
    },
    [favorites, showToast, storage],
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
  const selectedShaderId =
    selectedTransition === undefined
      ? undefined
      : resolveTransitionShaderId(selectedTransition.type);

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

  const q = query.trim().toLowerCase();
  const catalog = SHADER_CATALOG.filter(
    (entry) =>
      (category === 'all' || category === 'favorites' || q !== '' || entry.category === category) &&
      (category !== 'favorites' || favorites.has(entry.id)) &&
      (q === '' ||
        entry.label.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q)),
  );
  // The labelled category rail (T-V08): the grid below is grouped under the same labels.
  const catalogGroups = TRANSITION_CATEGORIES.map((item) => ({
    ...item,
    entries: catalog.filter((entry) => entry.category === item.id),
  })).filter((group) => group.entries.length > 0);

  return (
    <PanelShell
      title="Transitions"
      iconUrl={panelTabIconUrl('transitions')}
      className="transitions-panel library-panel"
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
        </>
      }
    >
      <div className="library-browser transitions-browser">
        <LibraryRail
          label="Transition categories"
          selectedId={category}
          onSelect={(id) => setCategory(id as TransitionCategoryId | 'all' | 'favorites')}
          items={[
            { id: 'all', label: 'All', icon: <LayersIcon />, count: SHADER_CATALOG.length },
            { id: 'favorites', label: 'Favorites', icon: <StarIcon />, count: favorites.size },
            ...TRANSITION_CATEGORIES.map((item) => ({
              id: item.id,
              label: item.label,
              icon: <LayersIcon />,
              count: SHADER_CATALOG.filter((entry) => entry.category === item.id).length,
            })),
          ]}
        />
        <div className="library-browser-main transition-category-groups">
          {catalogGroups.length === 0 && <p className="empty-hint">No transitions match.</p>}
          {catalogGroups.map((group) => (
            <section
              key={group.id}
              className="transition-category-section"
              data-transition-category={group.id}
              aria-label={group.label}
            >
              <h5 className="transition-category-heading">{group.label}</h5>
              <div className="transition-type-picker library-card-grid">
                {group.entries.map((entry) => (
                  <TransitionCard
                    key={entry.id}
                    entry={entry}
                    isActive={
                      selectedShaderId === entry.id ||
                      (selectedTransition === undefined && pendingType === entry.id)
                    }
                    isFavorite={favorites.has(entry.id)}
                    onAdd={() => handleAddTransition(entry.id)}
                    onToggleFavorite={() => toggleFavorite(entry.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {selectedTransition !== undefined && (
            <SelectedTransitionInspector
              transition={selectedTransition}
              project={project}
              playheadUs={playheadUs}
              onUpdateTransition={onUpdateTransition}
              onDispatch={onDispatch}
            />
          )}
        </div>
      </div>
    </PanelShell>
  );
}
