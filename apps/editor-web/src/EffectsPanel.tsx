/**
 * Effects browser panel — registry-driven catalog with search, categories,
 * favorites, and typed drag-and-drop. Dispatches effect commands through
 * EditorSession for undo/redo support.
 */

import {
  type ReactElement,
  useState,
  useMemo,
  useCallback,
} from 'react';
import type { JoyProjectV1, EffectInstanceV1 } from '@joy-media/project-schema';
import { effectRegistry, listEffects, type EffectDescriptor, type EffectDragPayload } from '@joy-media/visual-effects';

const CATEGORIES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Blur' },
  { id: 'stylize', label: 'Stylize' },
  { id: 'artistic', label: 'Artistic' },
  { id: 'depth', label: 'Depth' },
];

interface EffectsPanelProps {
  readonly project: JoyProjectV1;
  readonly objectId: string | undefined;
  readonly onDispatch: (transaction: { readonly type: 'effect.add'; readonly payload: { readonly objectId: string; readonly effectId: string; readonly params?: Readonly<Record<string, unknown>>; readonly index?: number } }) => void;
}

export function EffectsPanel({ project, objectId, onDispatch }: EffectsPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  const descriptors = useMemo(() => {
    const all = listEffects();
    if (category !== 'all') return all.filter((d) => d.category === category);
    return all;
  }, [category]);

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

  const handleAdd = useCallback(
    (effectId: string) => {
      if (!objectId) return;
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
    [objectId, onDispatch],
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

  const selectedEffects = objectId
    ? project.visualObjects[objectId]?.effects ?? []
    : [];

  return (
    <article className="effects-panel">
      <div className="effects-toolbar">
        <input
          type="search"
          placeholder="Search effects..."
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="effects-search"
          aria-label="Search effects"
        />
      </div>

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

      {!objectId ? (
        <p className="empty-hint">Select a visual object to apply effects.</p>
      ) : (
        <>
          <div className="effects-subsection">
            <h4 className="effects-subsection-title">Favorites</h4>
            <div className="effects-grid">
              {(favorites.size === 0
                ? []
                : filtered.filter((d) => favorites.has(d.id))
              ).map((desc) => (
                <EffectCard
                  key={desc.id}
                  descriptor={desc}
                  isFavorite={true}
                  onAdd={() => handleAdd(desc.id)}
                  onToggleFavorite={() => toggleFavorite(desc.id)}
                  onDragStart={(e) => handleDragStart(desc.id, e)}
                />
              ))}
              {favorites.size === 0 && (
                <span className="empty-hint">Click ★ to add favorites.</span>
              )}
            </div>
          </div>

          <div className="effects-subsection">
            <h4 className="effects-subsection-title">
              {category === 'all' ? 'All Effects' : CATEGORIES.find((c) => c.id === category)?.label ?? category}
            </h4>
            <div className="effects-grid">
              {filtered.length === 0 ? (
                <p className="empty-hint">No effects match.</p>
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
        </>
      )}
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
  return (
    <div
      className="effect-card"
      draggable
      onDragStart={onDragStart}
      onDoubleClick={onAdd}
      title={`${descriptor.label}${descriptor.description ? ` — ${descriptor.description}` : ''} (Cost: ${descriptor.cost})`}
    >
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
            className="icon-button effect-favorite-btn"
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            title={isFavorite ? '★ Remove favorite' : '☆ Add favorite'}
          >
            {isFavorite ? '★' : '☆'}
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
