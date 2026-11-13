/**
 * Effects browser panel — registry-driven catalog with search, categories,
 * favorites, and typed drag-and-drop. Dispatches effect commands through
 * EditorSession for undo/redo support.
 *
 * Every item lives in exactly one panel (T-V06): the twenty doubles that used
 * to sit in both the Filters and the Effects panel have one home each, and the
 * five that draw over the picture moved to Effects. See `library-homes.ts`.
 */

import { useState, useMemo, useCallback, useContext, useEffect, useRef } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  effectRegistry,
  registerBuiltins,
  type EffectDescriptor,
  type EffectDragPayload,
} from '@joy-media/visual-effects';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { LayersIcon, PlusIcon, StarFilledIcon, StarIcon } from './icons.js';
import { effectCategoryIconUrl } from './effect-category-icons.js';
import { EditorPanelContext } from './editor-panel-context.js';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import {
  createEffectRecipe,
  listEffectRecipes,
  type EffectRecipeCatalogEntry,
} from './effect-recipe-catalog.js';
import { readEffectFavorites, toggleEffectFavorite } from './effect-favorites.js';
import {
  allLibraryEffectIds,
  EFFECT_CATEGORIES,
  EFFECT_LIBRARY,
  EFFECT_PANEL_RULE,
  effectEffectIds,
  filterEffectIds,
  matchesLibraryQuery,
} from './library-homes.js';
import {
  librarySearch,
  pointLibraryAt,
  setLibraryQuery,
  useLibrarySearch,
} from './library-search.js';
import './library-panels.css';

const CATEGORIES: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'recipes', label: 'Recipes' },
  { id: 'favorites', label: 'Favorites' },
  ...EFFECT_CATEGORIES.map((category) => ({ id: category.id, label: category.label })),
];

function descriptorsFor(ids: readonly string[]): readonly EffectDescriptor[] {
  return ids.flatMap((id) => {
    const descriptor = effectRegistry.getEffect(id);
    return descriptor === undefined ? [] : [descriptor];
  });
}

function effectsInCategory(
  categoryId: string,
  favorites: ReadonlySet<string>,
): readonly EffectDescriptor[] {
  if (categoryId === 'recipes') return [];
  if (categoryId === 'favorites')
    return descriptorsFor(effectEffectIds().filter((id) => favorites.has(id)));
  return descriptorsFor(EFFECT_LIBRARY[categoryId] ?? []);
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
  readonly onCreateEffectLayer?: () => void;
}

export function EffectsPanel({
  project,
  objectId,
  canApplyEffects,
  onDispatch,
  showToast,
  onCreateEffectLayer,
}: EffectsPanelProps) {
  const editorContext = useContext(EditorPanelContext);
  const storage = editorContext?.storage;
  const { query, linkedId } = useLibrarySearch();
  const [category, setCategory] = useState('colour-light');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [builtinsReady, setBuiltinsReady] = useState(false);
  const [recipes, setRecipes] = useState<readonly EffectRecipeCatalogEntry[]>(() =>
    storage === undefined ? [] : listEffectRecipes(storage),
  );
  const effectStudioOpen = editorContext?.effectStudioOpen ?? false;
  const wasStudioOpen = useRef(effectStudioOpen);

  useEffect(() => {
    registerBuiltins();
    setBuiltinsReady(true);
  }, []);

  useEffect(() => {
    if (storage !== undefined && wasStudioOpen.current && !effectStudioOpen)
      setRecipes(listEffectRecipes(storage));
    wasStudioOpen.current = effectStudioOpen;
  }, [effectStudioOpen, storage]);

  // Dockview may render a cached panel before its provider attaches. Hydrate
  // only from the root writer-gated adapter once it is available; never fall
  // back to a raw browser store during that transient frame.
  useEffect(() => {
    if (storage !== undefined) setRecipes(listEffectRecipes(storage));
  }, [storage]);

  // Favourites belong to the item, so they are read from the shared list the
  // Filters panel writes. A favourite for an item that moved panels is still
  // that item: its registry id did not change.
  useEffect(() => {
    if (storage !== undefined) setFavorites(readEffectFavorites(storage, allLibraryEffectIds()));
  }, [storage]);

  const searching = query.trim().length > 0;

  const filtered = useMemo(() => {
    if (!builtinsReady) return [];
    const scope =
      category === 'favorites'
        ? effectEffectIds().filter((id) => favorites.has(id))
        : searching
          ? effectEffectIds()
          : (EFFECT_LIBRARY[category] ?? []);
    const descriptors = descriptorsFor(scope);
    return searching
      ? descriptors.filter((descriptor) => matchesLibraryQuery(descriptor, query))
      : descriptors;
  }, [builtinsReady, category, favorites, query, searching]);

  // The other panel's matches: the item lives there, not here.
  const alsoInFilters = useMemo(() => {
    if (!searching) return [];
    return descriptorsFor(filterEffectIds()).filter((descriptor) =>
      matchesLibraryQuery(descriptor, query),
    );
  }, [query, searching]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { recipes: recipes.length };
    if (!builtinsReady) return counts;
    for (const entry of CATEGORIES) {
      if (entry.id === 'recipes') continue;
      counts[entry.id] = effectsInCategory(entry.id, favorites).length;
    }
    return counts;
  }, [builtinsReady, favorites, recipes.length]);

  const toggleFavorite = useCallback(
    (effectId: string) => {
      setFavorites(toggleEffectFavorite(storage, favorites, effectId));
    },
    [favorites, storage],
  );

  const openInFilters = useCallback(
    (effectId: string) => {
      pointLibraryAt(effectId, librarySearch);
      editorContext?.onEnhanceToolChange('filters');
    },
    [editorContext],
  );

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
    if (storage === undefined) {
      showToast('Effect recipes require an active editor session.', 'error');
      return;
    }
    const selectedEffects =
      objectId === undefined ? [] : (project.visualObjects[objectId]?.effects ?? []);
    const recipe = createEffectRecipe(
      storage,
      selectedEffects.length > 0 ? 'Recipe from Selection' : 'Untitled Effect Recipe',
      selectedEffects,
      objectId,
    );
    setRecipes(listEffectRecipes(storage));
    editorContext?.openEffectStudio(recipe.id, objectId);
  }, [editorContext, objectId, project.visualObjects, showToast, storage]);

  const emptyHint =
    category === 'favorites' && favorites.size === 0
      ? 'No effects in favorites yet.'
      : 'No effects match your search.';

  return (
    <PanelShell
      title="Effects"
      iconUrl={panelTabIconUrl('effects')}
      className="effects-panel"
      actions={
        <>
          <button
            type="button"
            className="icon-button"
            aria-label="Add Effects layer"
            title="Add a parented Effects layer"
            disabled={onCreateEffectLayer === undefined}
            onClick={onCreateEffectLayer}
          >
            <LayersIcon />
          </button>
          <button
            type="button"
            className="icon-button effects-studio-launch"
            aria-label="Create effect recipe"
            title="New Effect Studio recipe"
            onClick={handleCreateRecipe}
          >
            <PlusIcon />
          </button>
        </>
      }
      search={{
        value: query,
        onChange: (next) => setLibraryQuery(next, librarySearch),
        placeholder: 'Search effects…',
      }}
    >
      <p className="library-rule">{EFFECT_PANEL_RULE}</p>
      {query.trim().length > 0 && (
        <p className="library-search-note">Searching for “{query.trim()}”</p>
      )}
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
                  data-release-observer-category="true"
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
            <>
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
                      linked={linkedId === desc.id}
                      onAdd={() => handleAdd(desc.id)}
                      onToggleFavorite={() => toggleFavorite(desc.id)}
                      onDragStart={(e) => handleDragStart(desc.id, e)}
                    />
                  ))
                )}
              </div>
              {alsoInFilters.length > 0 && (
                <p className="library-also">
                  <span>Also in Filters:</span>
                  {alsoInFilters.map((descriptor) => (
                    <button
                      key={descriptor.id}
                      type="button"
                      className="library-also-link"
                      onClick={() => openInFilters(descriptor.id)}
                    >
                      {descriptor.label}
                    </button>
                  ))}
                </p>
              )}
            </>
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
  linked,
  onAdd,
  onToggleFavorite,
  onDragStart,
}: {
  readonly descriptor: EffectDescriptor;
  readonly isFavorite: boolean;
  readonly canApply: boolean;
  readonly linked: boolean;
  readonly onAdd: () => void;
  readonly onToggleFavorite: () => void;
  readonly onDragStart: (event: React.DragEvent) => void;
}) {
  const unavailableReasonId = `effect-unavailable-${descriptor.id}`;
  const unavailableReason = canApply
    ? undefined
    : 'Select a video clip to apply this effect, or drag it onto a timeline clip.';

  return (
    <div
      className={`effect-card${canApply ? '' : ' is-unavailable'}${linked ? ' is-linked' : ''}`}
      role="group"
      tabIndex={0}
      aria-label={`${descriptor.label} effect`}
      aria-keyshortcuts="Enter Space"
      data-library-linked={linked ? 'true' : undefined}
      {...(unavailableReason === undefined
        ? {}
        : {
            'aria-describedby': unavailableReasonId,
          })}
      draggable={true}
      onDragStart={onDragStart}
      onDoubleClick={canApply ? onAdd : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onAdd();
      }}
      title={`${descriptor.label}${descriptor.description ? ` — ${descriptor.description}` : ''} (Cost: ${descriptor.cost})${unavailableReason === undefined ? '' : ` ${unavailableReason}`}`}
    >
      {unavailableReason !== undefined && (
        <span id={unavailableReasonId} className="sr-only">
          {unavailableReason}
        </span>
      )}
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
            data-release-observer-favorite="true"
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
            {...(unavailableReason === undefined
              ? {}
              : { 'aria-describedby': unavailableReasonId })}
            disabled={!canApply}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            title={unavailableReason ?? 'Add effect'}
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
