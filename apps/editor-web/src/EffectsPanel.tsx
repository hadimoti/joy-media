/**
 * Effects browser panel — registry-driven catalog with search, categories,
 * favorites, and typed drag-and-drop. Dispatches effect commands through
 * EditorSession for undo/redo support.
 */

import {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
} from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { effectRegistry, listEffects, type EffectDescriptor, type EffectDragPayload } from '@joy-media/visual-effects';
import { SearchIcon } from './icons.js';

const CATEGORIES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Blur' },
  { id: 'stylize', label: 'Stylize' },
  { id: 'artistic', label: 'Artistic' },
  { id: 'depth', label: 'Depth' },
  { id: 'favorites', label: 'Favorites' },
];

interface EffectsPanelProps {
  readonly project: JoyProjectV1;
  readonly objectId: string | undefined;
  readonly onDispatch: (transaction: { readonly type: 'effect.add'; readonly payload: { readonly objectId: string; readonly effectId: string; readonly params?: Readonly<Record<string, unknown>>; readonly index?: number } }) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

export function EffectsPanel({ project, objectId, onDispatch, showToast }: EffectsPanelProps) {
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [category, setCategory] = useState('all');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const descriptors = useMemo(() => {
    const all = listEffects();
    if (category === 'all') return all;
    if (category === 'favorites') return all.filter((d) => favorites.has(d.id));
    return all.filter((d) => d.category === category);
  }, [category, favorites]);

  const filtered = useMemo(() => {
    if (!search.trim()) return descriptors;
    const q = search.toLowerCase();
    return descriptors.filter(
      (d) =>
        d.label.toLowerCase().includes(q) ||
        d.id.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [descriptors, search]);

  const toggleFavorite = useCallback((effectId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(effectId)) next.delete(effectId);
      else next.add(effectId);
      return next;
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearch('');
    setSearchOpen(false);
  }, []);

  const handleAdd = useCallback(
    (effectId: string) => {
      if (!objectId) {
        showToast('Select a clip or drag onto the timeline to apply effects.', 'info');
        return;
      }
      const descriptor = effectRegistry.getEffect(effectId);
      if (!descriptor) return;
      const defaults: Record<string, unknown> = {};
      for (const p of descriptor.params) {
        defaults[p.key] = p.defaultValue;
      }
      onDispatch({
        type: 'effect.add' as const,
        payload: { objectId, effectId, params: defaults },
      });
    },
    [objectId, onDispatch, showToast],
  );

  const handleDragStart = useCallback(
    (effectId: string, event: React.DragEvent) => {
      const payload: EffectDragPayload = {
        kind: 'joy/effect',
        effectId,
        source: 'effects-panel',
      };
      event.dataTransfer.setData('application/x-joy-effect', JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'copy';
    },
    [],
  );

  const emptyHint =
    category === 'favorites' && favorites.size === 0
      ? 'No favorites yet.'
      : 'No effects match.';

  return (
    <article className="joy-panel-root effects-panel">
      <div className="effects-panel-header">
        <h3 className="panel-section-title">
          <img
            className="panel-section-title-icon"
            src="/assets/icons/effects.png"
            alt=""
            width={16}
            height={16}
            aria-hidden="true"
          />
          Effects
        </h3>
        <button
          type="button"
          className="icon-button"
          aria-label={searchOpen ? 'Close search' : 'Search effects'}
          title={searchOpen ? 'Close search' : 'Search effects'}
          aria-expanded={searchOpen}
          aria-controls="effects-search-field"
          onClick={() => {
            if (searchOpen) closeSearch();
            else setSearchOpen(true);
          }}
        >
          <SearchIcon />
        </button>
      </div>
      {searchOpen && (
        <div className="effects-toolbar">
          <input
            id="effects-search-field"
            ref={searchInputRef}
            type="search"
            placeholder="Search effects..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
            }}
            className="effects-search"
            aria-label="Search effects"
          />
        </div>
      )}

      <div className="effects-categories" role="tablist">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            role="tab"
            aria-selected={category === cat.id}
            className={`effects-category-tab${category === cat.id ? ' active' : ''}`}
            onClick={() => setCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <div className="joy-panel-scroll">
        <div className="effects-grid">
          {filtered.length === 0 ? (
            <p className="empty-hint">{emptyHint}</p>
          ) : (
            filtered.map((desc) => (
              <EffectCard
                key={desc.id}
                descriptor={desc}
                isFavorite={favorites.has(desc.id)}
                onAdd={() => handleAdd(desc.id)}
                onToggleFavorite={() => toggleFavorite(desc.id)}
                onDragStart={(e) => handleDragStart(desc.id, e)}
              />
            ))
          )}
        </div>
      </div>
    </article>
  );
}

function EffectCard({
  descriptor,
  isFavorite,
  onAdd,
  onToggleFavorite,
  onDragStart,
}: {
  readonly descriptor: EffectDescriptor;
  readonly isFavorite: boolean;
  readonly onAdd: () => void;
  readonly onToggleFavorite: () => void;
  readonly onDragStart: (event: React.DragEvent) => void;
}) {
  const [imgError, setImgError] = useState(false);
  return (
    <div
      className="effect-card"
      draggable
      onDragStart={onDragStart}
      onDoubleClick={onAdd}
      title={`${descriptor.label}${descriptor.description ? ` — ${descriptor.description}` : ''} (Cost: ${descriptor.cost})`}
    >
      <div className="effect-card-thumb">
        {!imgError ? (
          <img
            className="effect-card-img"
            src={`/effects/preview/${descriptor.id}.png`}
            alt=""
            width={120}
            height={120}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="effect-card-thumb-fallback" aria-hidden="true" />
        )}
      </div>
      <div className="effect-card-header">
        <div className="effect-card-icon">
          {descriptor.cost !== 'low' && (
            <span className="effect-card-cost" data-cost={descriptor.cost}>
              {descriptor.cost === 'high' ? '⚠' : '⚡'}
            </span>
          )}
          <span className="effect-card-label">{descriptor.label}</span>
        </div>
        <div className="effect-card-actions">
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
          <button
            type="button"
            className="icon-button effect-add-btn"
            aria-label={`Add ${descriptor.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title="Add effect"
          >
            +
          </button>
        </div>
      </div>
      {!descriptor.backend.pixiPreview && (
        <div className="effect-card-warning" title="Preview may differ from export">
          Preview-only
        </div>
      )}
    </div>
  );
}
