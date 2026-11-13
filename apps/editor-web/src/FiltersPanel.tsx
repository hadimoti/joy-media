import { useContext, useEffect, useMemo, useState } from 'react';
import {
  effectRegistry,
  registerBuiltins,
  type EffectDescriptor,
  type EffectParamValue,
} from '@joy-media/visual-effects';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import { FilterIcon, LayersIcon, PlusIcon, StarFilledIcon, StarIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
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

const FILTER_TABS: readonly PanelTabSpec[] = [
  { id: 'favorites', label: 'Favorites' },
  ...FILTER_CATEGORIES.map((category) => ({ id: category.id, label: category.label })),
];

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
  const [group, setGroup] = useState<FilterLibraryGroupId>(DEFAULT_FILTER_GROUP);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const { query, linkedId } = useLibrarySearch();

  // Favourites belong to the item, so they are read from the shared list the
  // Effects panel writes. The list is only read once the writer-gated storage
  // is available.
  useEffect(() => {
    if (storage !== undefined) setFavorites(readEffectFavorites(storage, allLibraryEffectIds()));
  }, [storage]);

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
    pointLibraryAt(effectId, librarySearch);
    editorContext?.onEnhanceToolChange('effects');
  };

  return (
    <PanelShell
      title="Filters"
      icon={<FilterIcon />}
      className="filters-panel"
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
      tabs={FILTER_TABS}
      activeTab={group}
      onTabChange={(id) => setGroup(id as FilterLibraryGroupId)}
    >
      <p className="library-rule">{FILTER_PANEL_RULE}</p>
      {query.trim().length > 0 && (
        <p className="library-search-note">Searching for “{query.trim()}”</p>
      )}
      <div className="filters-target" aria-live="polite">
        <span>Target</span>
        <strong>{targetLabel ?? 'No media selected'}</strong>
      </div>
      <div className={`filters-grid${descriptors.length === 0 ? ' is-empty' : ''}`}>
        {descriptors.length === 0 ? (
          <p className="empty-hint">
            {group === 'favorites' && favorites.size === 0
              ? 'No filters in favorites yet.'
              : 'No filters match your search.'}
          </p>
        ) : (
          descriptors.map((descriptor) => (
            <div className="filter-library-card-wrap" key={descriptor.id}>
              <button
                type="button"
                className="filter-library-card"
                disabled={!canCreate}
                aria-label={`Add ${descriptor.label} Filters layer`}
                title={`${descriptor.label} — ${descriptor.description ?? 'Creative filter'}`}
                data-library-linked={linkedId === descriptor.id ? 'true' : undefined}
                onClick={() => onAddFilter(descriptor.id, defaultsForEffect(descriptor))}
              >
                <span className="filter-library-card-preview">
                  <EffectPreviewMedia
                    effectId={descriptor.id}
                    className="filter-library-card-preview-media"
                  />
                </span>
                <span className="filter-library-card-copy">
                  <strong>{descriptor.label}</strong>
                  <small>{descriptor.description ?? descriptor.category}</small>
                </span>
                <span className="filter-library-card-add" aria-hidden="true">
                  <PlusIcon />
                </span>
              </button>
              <button
                type="button"
                className="icon-button filter-library-card-fav"
                data-release-observer-favorite="true"
                aria-label={
                  favorites.has(descriptor.id)
                    ? `Remove ${descriptor.label} from favorites`
                    : `Add ${descriptor.label} to favorites`
                }
                title={favorites.has(descriptor.id) ? 'Remove favorite' : 'Add favorite'}
                onClick={() => toggleFavorite(descriptor.id)}
              >
                {favorites.has(descriptor.id) ? <StarFilledIcon /> : <StarIcon />}
              </button>
            </div>
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
    </PanelShell>
  );
}
