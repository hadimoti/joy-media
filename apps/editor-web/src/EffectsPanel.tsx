/**
 * Effects browser panel — registry-driven catalog with search, categories,
 * favorites, and typed drag-and-drop. Dispatches effect commands through
 * EditorSession for undo/redo support.
 */

import { useState, useMemo, useCallback, useContext, useEffect, useRef } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  effectRegistry,
  listEffects,
  registerBuiltins,
  type EffectDescriptor,
  type EffectDragPayload,
} from '@joy-media/visual-effects';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { PlusIcon, StarFilledIcon, StarIcon } from './icons.js';
import { effectCategoryIconUrl } from './effect-category-icons.js';
import { EditorPanelContext } from './App.js';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import {
  createEffectRecipe,
  listEffectRecipes,
  type EffectRecipeCatalogEntry,
} from './effect-recipe-catalog.js';

const CATEGORIES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'recipes', label: 'Recipes' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'pixel-bw', label: 'Pixel / B&W' },
  { id: 'color', label: 'Color' },
  { id: 'stylize', label: 'Stylize' },
  { id: 'artistic', label: 'Artistic' },
  { id: 'blur', label: 'Blur' },
  { id: 'distort', label: 'Distort' },
  { id: 'depth', label: 'Depth' },
];

function effectsInCategory(
  categoryId: string,
  favorites: ReadonlySet<string>,
): readonly EffectDescriptor[] {
  const all = listEffects();
  if (categoryId === 'recipes') return [];
  if (categoryId === 'favorites') return all.filter((d) => favorites.has(d.id));
  if (categoryId === 'pixel-bw') {
    const signals = [
      'pixel',
      'bw',
      'black and white',
      'halftone',
      'dither',
      'glyph',
      'ascii',
      'contour',
      'mosaic',
      'posterize',
    ];
    return all.filter((descriptor) =>
      descriptor.tags.some((tag) => signals.some((signal) => tag.includes(signal))),
    );
  }
  return all.filter((d) => d.category === categoryId);
}

interface EffectsPanelProps {
  readonly project: JoyProjectV1;
  readonly objectId: string | undefined;
  /** Catalog previews stay live even when this is false. */
  readonly canApplyEffects: boolean;
  readonly onDispatch: (transaction: {
    readonly type: 'effect.add';
    readonly payload: {
      readonly objectId: string;
      readonly effectId: string;
      readonly params?: Readonly<Record<string, unknown>>;
      readonly index?: number;
    };
  }) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

export function EffectsPanel({
  project,
  objectId,
  canApplyEffects,
  onDispatch,
  showToast,
}: EffectsPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('pixel-bw');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [builtinsReady, setBuiltinsReady] = useState(false);
  const [recipes, setRecipes] = useState<readonly EffectRecipeCatalogEntry[]>(() =>
    listEffectRecipes(window.localStorage),
  );
  const editorContext = useContext(EditorPanelContext);
  const effectStudioOpen = editorContext?.effectStudioOpen ?? false;
  const wasStudioOpen = useRef(effectStudioOpen);

  useEffect(() => {
    registerBuiltins();
    setBuiltinsReady(true);
  }, []);

  useEffect(() => {
    if (wasStudioOpen.current && !effectStudioOpen) {
      setRecipes(listEffectRecipes(window.localStorage));
    }
    wasStudioOpen.current = effectStudioOpen;
  }, [effectStudioOpen]);

  const descriptors = useMemo(
    () => (builtinsReady ? effectsInCategory(category, favorites) : []),
    [builtinsReady, category, favorites],
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { recipes: recipes.length };
    if (!builtinsReady) return counts;
    for (const entry of CATEGORIES) {
      if (entry.id === 'recipes') continue;
      counts[entry.id] = effectsInCategory(entry.id, favorites).length;
    }
    return counts;
  }, [builtinsReady, favorites, recipes.length]);

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
      if (!canApplyEffects || !objectId) {
        showToast('Select one video clip to apply effects.', 'info');
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
    [canApplyEffects, objectId, onDispatch, showToast],
  );

  const handleDragStart = useCallback((effectId: string, event: React.DragEvent) => {
    const payload: EffectDragPayload = {
      kind: 'joy/effect',
      effectId,
      source: 'effects-panel',
    };
    event.dataTransfer.setData('application/x-joy-effect', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleCreateRecipe = useCallback(() => {
    const selectedEffects =
      objectId === undefined ? [] : (project.visualObjects[objectId]?.effects ?? []);
    const recipe = createEffectRecipe(
      window.localStorage,
      selectedEffects.length > 0 ? 'Recipe from Selection' : 'Untitled Effect Recipe',
      selectedEffects,
      objectId,
    );
    setRecipes(listEffectRecipes(window.localStorage));
    editorContext?.openEffectStudio(recipe.id, objectId);
  }, [editorContext, objectId, project.visualObjects]);

  const emptyHint =
    category === 'favorites' && favorites.size === 0
      ? 'No effects in favorites yet.'
      : 'No effects match your search.';

  if (!builtinsReady) {
    return (
      <section className="panel-loading" role="status" aria-label="Loading effects">
        Loading effects…
      </section>
    );
  }

  return (
    <PanelShell
      title="Effects"
      iconUrl={panelTabIconUrl('effects')}
      className="effects-panel"
      actions={
        <button
          type="button"
          className="icon-button effects-studio-launch"
          aria-label="Create effect recipe"
          title="New Effect Studio recipe"
          onClick={handleCreateRecipe}
        >
          <PlusIcon />
        </button>
      }
      search={{ value: search, onChange: setSearch, placeholder: 'Search effects…' }}
      note={
        canApplyEffects
          ? undefined
          : 'Drag an effect to a clip on the timeline to apply it. Animated previews stay live.'
      }
    >
      <div className="effects-panel-content">
        <aside className="effects-panel-sidebar" aria-label="Effect categories">
          <span className="effects-panel-sidebar-title">Categories</span>
          <div className="effects-panel-categories" role="tablist" aria-label="Effect categories">
            {CATEGORIES.map((entry) => {
              const iconUrl = effectCategoryIconUrl(entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  className="effects-panel-category-tab"
                  aria-label={`${entry.label} (${categoryCounts[entry.id] ?? 0})`}
                  title={`${entry.label} (${categoryCounts[entry.id] ?? 0})`}
                  aria-selected={category === entry.id}
                  onClick={() => setCategory(entry.id)}
                >
                  {entry.id === 'favorites' ? (
                    <span
                      className="effects-panel-category-tab-icon effects-panel-category-tab-icon--star"
                      aria-hidden="true"
                    >
                      <StarIcon />
                    </span>
                  ) : (
                    iconUrl !== undefined && (
                      <span
                        className="effects-panel-category-tab-icon"
                        style={{
                          maskImage: `url(${iconUrl})`,
                          WebkitMaskImage: `url(${iconUrl})`,
                        }}
                        aria-hidden="true"
                      />
                    )
                  )}
                </button>
              );
            })}
          </div>
        </aside>
        <div className="effects-panel-main">
          {category === 'recipes' ? (
            <div className={`effect-recipes-list${recipes.length === 0 ? ' is-empty' : ''}`}>
              {recipes.length === 0 ? (
                <div className="effect-recipes-empty">
                  <strong>No recipes yet</strong>
                  <span>Combine effects into a reusable visual pipeline.</span>
                  <button type="button" onClick={handleCreateRecipe}>
                    Open Effect Studio
                  </button>
                </div>
              ) : (
                recipes.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className="effect-recipe-card"
                    onClick={() => editorContext?.openEffectStudio(recipe.id, objectId)}
                  >
                    <span className="effect-recipe-monogram">FX</span>
                    <span className="effect-recipe-copy">
                      <strong>{recipe.title}</strong>
                      <small>
                        {recipe.effectCount} {recipe.effectCount === 1 ? 'effect' : 'effects'}
                      </small>
                    </span>
                    {recipe.publishedAt !== undefined && <i>Published</i>}
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className={`effects-grid${filtered.length === 0 ? ' is-empty' : ''}`}>
              {filtered.length === 0 ? (
                <p className="empty-hint">{emptyHint}</p>
              ) : (
                filtered.map((desc) => (
                  <EffectCard
                    key={desc.id}
                    descriptor={desc}
                    isFavorite={favorites.has(desc.id)}
                    canApply={canApplyEffects}
                    onAdd={() => handleAdd(desc.id)}
                    onToggleFavorite={() => toggleFavorite(desc.id)}
                    onDragStart={(e) => handleDragStart(desc.id, e)}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function EffectCard({
  descriptor,
  isFavorite,
  canApply,
  onAdd,
  onToggleFavorite,
  onDragStart,
}: {
  readonly descriptor: EffectDescriptor;
  readonly isFavorite: boolean;
  readonly canApply: boolean;
  readonly onAdd: () => void;
  readonly onToggleFavorite: () => void;
  readonly onDragStart: (event: React.DragEvent) => void;
}) {
  return (
    <div
      className={`effect-card${canApply ? '' : ' is-unavailable'}`}
      draggable={true}
      onDragStart={onDragStart}
      onDoubleClick={canApply ? onAdd : undefined}
      title={`${descriptor.label}${descriptor.description ? ` — ${descriptor.description}` : ''} (Cost: ${descriptor.cost})${canApply ? '' : ' Drag to a clip on the timeline to apply.'}`}
    >
      <div className="effect-card-thumb">
        <EffectPreviewMedia effectId={descriptor.id} className="effect-card-preview-media" />
        {!canApply && <span className="effect-card-preview-state">Preview only</span>}
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
            {isFavorite ? <StarFilledIcon /> : <StarIcon />}
          </button>
          <button
            type="button"
            className="icon-button effect-add-btn"
            aria-label={`Add ${descriptor.label}`}
            disabled={!canApply}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title="Add effect"
          >
            <PlusIcon />
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
