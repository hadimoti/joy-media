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
  type EffectDescriptor,
  type EffectDragPayload,
} from '@joy-media/visual-effects';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { PlusIcon, StarFilledIcon, StarIcon } from './icons.js';
import { EditorPanelContext } from './App.js';
import {
  createEffectRecipe,
  listEffectRecipes,
  type EffectRecipeCatalogEntry,
} from './effect-recipe-catalog.js';

const CATEGORIES: readonly PanelTabSpec[] = [
  { id: 'recipes', label: 'Recipes' },
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

export function EffectsPanel({ project, objectId, onDispatch, showToast }: EffectsPanelProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recipes, setRecipes] = useState<readonly EffectRecipeCatalogEntry[]>(() =>
    listEffectRecipes(window.localStorage),
  );
  const editorContext = useContext(EditorPanelContext);
  const effectStudioOpen = editorContext?.effectStudioOpen ?? false;
  const wasStudioOpen = useRef(effectStudioOpen);

  useEffect(() => {
    if (wasStudioOpen.current && !effectStudioOpen) {
      setRecipes(listEffectRecipes(window.localStorage));
    }
    wasStudioOpen.current = effectStudioOpen;
  }, [effectStudioOpen]);

  const descriptors = useMemo(() => {
    const all = listEffects();
    if (category === 'recipes') return [];
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

  const handleAdd = useCallback(
    (effectId: string) => {
      if (!objectId) {
        showToast(
          'برای اعمال افکت، یک کلیپ را انتخاب کنید یا افکت را روی تایم‌لاین بکشید.',
          'info',
        );
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
      ? 'هنوز افکتی به علاقه‌مندی‌ها اضافه نشده است.'
      : 'افکتی با جست‌وجوی شما مطابقت ندارد.';

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
      search={{ value: search, onChange: setSearch, placeholder: 'جست‌وجوی افکت‌ها…' }}
      tabs={CATEGORIES}
      activeTab={category}
      onTabChange={setCategory}
    >
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
            <p className="empty-hint" lang="fa">
              {emptyHint}
            </p>
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
      )}
    </PanelShell>
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
            {isFavorite ? <StarFilledIcon /> : <StarIcon />}
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
