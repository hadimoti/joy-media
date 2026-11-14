import { useContext, useEffect, useId, useMemo, useState } from 'react';
import {
  effectRegistry,
  registerBuiltins,
  type EffectDescriptor,
  type EffectParamValue,
} from '@joy-media/visual-effects';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import { LibraryCard } from './LibraryCard.js';
import { LibraryRail, libraryTabPanelProps } from './LibraryRail.js';
import { FilterIcon, LayersIcon, StarIcon } from './icons.js';
import { PanelShell } from './PanelShell.js';
import { EditorPanelContext } from './editor-panel-context.js';
import { readEffectFavorites, toggleEffectFavorite } from './effect-favorites.js';
import {
  allLibraryEffectIds,
  effectEffectIds,
  FILTER_CATEGORIES,
  FILTER_LIBRARY,
  FILTER_PANEL_RULE,
  filterEffectIds,
  matchesLibraryQuery,
  type FilterCategoryId,
} from './library-homes.js';
import {
  librarySearch,
  pointLibraryAt,
  setLibraryQuery,
  useLibrarySearch,
} from './library-search.js';
import './library-panels.css';

// The registry is the one catalogue both panels read; the app registers it at
// start-up, and a panel rendered on its own registers it too.
registerBuiltins();

export type FilterLibraryGroupId = FilterCategoryId | 'favorites';

export { FILTER_LIBRARY };

/** The panel opens on Blur & Focus, the group the panel used to open on. */
const DEFAULT_FILTER_GROUP: FilterLibraryGroupId = 'blur-focus';

function defaultsForEffect(
  descriptor: EffectDescriptor,
): Readonly<Record<string, EffectParamValue>> {
  return Object.fromEntries(
    descriptor.params.map((parameter) => [parameter.key, parameter.defaultValue]),
  );
}

function descriptorsFor(ids: readonly string[]): readonly EffectDescriptor[] {
  return ids.flatMap((id) => {
    const descriptor = effectRegistry.getEffect(id);
    return descriptor === undefined ? [] : [descriptor];
  });
}

export function FiltersPanel({
  canCreate,
  targetLabel,
  onCreateFilterLayer,
  onAddFilter,
}: {
  readonly canCreate: boolean;
  readonly targetLabel?: string;
  readonly onCreateFilterLayer?: () => void;
  readonly onAddFilter: (
    effectId: string,
    params: Readonly<Record<string, EffectParamValue>>,
  ) => void;
}) {
  const editorContext = useContext(EditorPanelContext);
  const storage = editorContext?.storage;
  const railPanelId = useId();
  const [group, setGroup] = useState<FilterLibraryGroupId>(DEFAULT_FILTER_GROUP);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const { query, linkedId, linkedPanel, linkToken } = useLibrarySearch();

  // Favourites belong to the item, so they are read from the shared list the
  // Effects panel writes. The list is only read once the writer-gated storage
  // is available.
  useEffect(() => {
    if (storage !== undefined) setFavorites(readEffectFavorites(storage, allLibraryEffectIds()));
  }, [storage]);

  // A link from the Effects panel opens this one: leave the Favorites view, so the
  // item the link points at is in the list (the search then applies to every filter).
  useEffect(() => {
    if (linkedPanel === 'filters' && linkToken !== undefined) setGroup(DEFAULT_FILTER_GROUP);
  }, [linkedPanel, linkToken]);

  const searching = query.trim().length > 0;

  const descriptors = useMemo(() => {
    const favouriteIds = filterEffectIds().filter((id) => favorites.has(id));
    const scope =
      group === 'favorites'
        ? favouriteIds
        : searching
          ? filterEffectIds()
          : (FILTER_LIBRARY[group] ?? []);
    return descriptorsFor(scope).filter((descriptor) =>
      searching ? matchesLibraryQuery(descriptor, query) : true,
    );
  }, [favorites, group, query, searching]);

  // The other panel's matches: the item lives there, not here.
  const alsoInEffects = useMemo(() => {
    if (!searching) return [];
    return descriptorsFor(effectEffectIds()).filter((descriptor) =>
      matchesLibraryQuery(descriptor, query),
    );
  }, [query, searching]);

  const toggleFavorite = (effectId: string) => {
    setFavorites(toggleEffectFavorite(storage, favorites, effectId));
  };

  const openInEffects = (effectId: string) => {
    pointLibraryAt(effectId, 'effects');
    editorContext?.onEnhanceToolChange('effects');
  };

  return (
    <PanelShell
      title="Filters"
      icon={<FilterIcon />}
      className="filters-panel library-panel"
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Add empty Filters layer"
          title="Add an empty parented Filters layer"
          disabled={!canCreate || onCreateFilterLayer === undefined}
          onClick={onCreateFilterLayer}
        >
          <LayersIcon />
        </button>
      }
      search={{
        value: query,
        onChange: (next) => setLibraryQuery(next, librarySearch),
        placeholder: 'Search filters…',
      }}
    >
      <p className="library-rule">{FILTER_PANEL_RULE}</p>
      {query.trim().length > 0 && (
        <p className="library-search-note">Searching for “{query.trim()}”</p>
      )}
      <div className="library-browser">
        <LibraryRail
          label="Filter categories"
          panelId={railPanelId}
          selectedId={group}
          onSelect={(id) => setGroup(id as FilterLibraryGroupId)}
          items={[
            { id: 'favorites', label: 'Favorites', icon: <StarIcon />, count: favorites.size },
            ...FILTER_CATEGORIES.map((category) => ({
              id: category.id,
              label: category.label,
              icon: <FilterIcon />,
              count: category.effectIds.length,
            })),
          ]}
        />
        <div className="library-browser-main" {...libraryTabPanelProps(railPanelId, group)}>
          <div className="filters-target" aria-live="polite">
            <span>Target</span>
            {targetLabel === undefined || targetLabel === 'No media selected' ? (
              <span className="filters-target-hint">Select a clip, then add a filter</span>
            ) : (
              <strong>{targetLabel}</strong>
            )}
          </div>
          <div
            className={`filters-grid library-card-grid${descriptors.length === 0 ? ' is-empty' : ''}`}
          >
            {descriptors.length === 0 ? (
              <p className="empty-hint">
                {group === 'favorites' && favorites.size === 0
                  ? 'No filters in favorites yet.'
                  : 'No filters match your search.'}
              </p>
            ) : (
              descriptors.map((descriptor) => (
                <LibraryCard
                  key={descriptor.id}
                  id={descriptor.id}
                  name={descriptor.label}
                  description={descriptor.description ?? descriptor.category}
                  preview={<EffectPreviewMedia effectId={descriptor.id} label={descriptor.label} />}
                  isFavorite={favorites.has(descriptor.id)}
                  onToggleFavorite={() => toggleFavorite(descriptor.id)}
                  onAdd={() => onAddFilter(descriptor.id, defaultsForEffect(descriptor))}
                  addAriaLabel={`Add ${descriptor.label} Filters layer`}
                  disabled={!canCreate}
                  className="filter-library-card"
                  linked={linkedId === descriptor.id}
                  title={`${descriptor.label} — ${descriptor.description ?? 'Creative filter'}`}
                  badges={
                    descriptor.cost === 'low' ? undefined : (
                      <span
                        className="library-card-badge library-card-weight-badge"
                        data-cost={descriptor.cost}
                        title="May slow the preview on long clips"
                      >
                        {descriptor.cost === 'high' ? 'Very heavy' : 'Heavy'}
                      </span>
                    )
                  }
                />
              ))
            )}
          </div>
          {alsoInEffects.length > 0 && (
            <p className="library-also">
              <span>Also in Effects:</span>
              {alsoInEffects.map((descriptor) => (
                <button
                  key={descriptor.id}
                  type="button"
                  className="library-also-link"
                  onClick={() => openInEffects(descriptor.id)}
                >
                  {descriptor.label}
                </button>
              ))}
            </p>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
