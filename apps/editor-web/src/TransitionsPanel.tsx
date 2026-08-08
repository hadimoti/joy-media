import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { listTransitionShaders } from '@joy-media/transition-shaders';
import type { TransitionDragPayload } from '@joy-media/visual-effects';
import { TransitionPreviewCard } from './TransitionPreviewCard.js';
import { StarFilledIcon } from './icons.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

const SHADER_CATALOG = listTransitionShaders();

interface TransitionsPanelProps {
  readonly project: JoyProjectV1;
  readonly selectedClipIds: readonly string[];
  readonly onAddTransition: (transition: Omit<TransitionV1, 'id'>) => void;
  readonly onRemoveTransition: (transitionId: string) => void;
  readonly onUpdateTransition: (transitionId: string, updates: Partial<TransitionV1>) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
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
      draggable
      onDragStart={onDragStart}
      onClick={onAdd}
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
  selectedClipIds,
  onAddTransition,
  onRemoveTransition: _onRemoveTransition,
  onUpdateTransition: _onUpdateTransition,
  showToast,
}: TransitionsPanelProps) {
  const rootComp = project.compositions[project.rootCompositionId];
  const [pendingType, setPendingType] = useState('dissolve');
  const [selectedTransition] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
      onAddTransition({
        trackId: selectedJunction.trackId,
        leftClipId: selectedJunction.leftClipId,
        rightClipId: selectedJunction.rightClipId,
        type,
        durationUs: 500_000,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      });
      setPendingType(type);
    },
    [selectedJunction, selectedClipIds, onAddTransition, showToast],
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
      {...(selectedJunction
        ? {
            note: `${selectedJunction.trackName}: ${selectedJunction.leftClipId} → ${selectedJunction.rightClipId}`,
          }
        : {})}
      actions={
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
                  isActive={selectedTransition === entry.id || pendingType === entry.id}
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
                isActive={selectedTransition === entry.id || pendingType === entry.id}
                isFavorite={favorites.has(entry.id)}
                onAdd={() => handleAddTransition(entry.id)}
                onToggleFavorite={() => toggleFavorite(entry.id)}
                onDragStart={(e) => handleDragStart(entry.id, e)}
              />
            ))}
          </div>
        </div>
      </>
    </PanelShell>
  );
}
