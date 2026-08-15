import { useMemo, useState } from 'react';
import {
  effectRegistry,
  type EffectDescriptor,
  type EffectParamValue,
} from '@joy-media/visual-effects';
import { EffectPreviewMedia } from './EffectPreviewMedia.js';
import { FilterIcon, LayersIcon, PlusIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';

export type FilterLibraryGroupId = 'blur' | 'texture' | 'creative' | 'looks';

export const FILTER_LIBRARY: Readonly<Record<FilterLibraryGroupId, readonly string[]>> = {
  blur: ['gaussian-blur', 'zoom-blur', 'radial-blur', 'tilt-shift', 'bloom', 'glow'],
  texture: ['noise', 'pixelate', 'halftone', 'bayer-dither', 'scatter-mosaic'],
  creative: ['posterize', 'monochrome', 'contour-map', 'glyph-matrix', 'pixel-sort'],
  looks: ['vignette', 'sepia', 'hue-saturation', 'vibrance'],
};

const FILTER_TABS: readonly PanelTabSpec[] = [
  { id: 'blur', label: 'Blur' },
  { id: 'texture', label: 'Texture' },
  { id: 'creative', label: 'Creative' },
  { id: 'looks', label: 'Looks' },
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
  const [group, setGroup] = useState<FilterLibraryGroupId>('blur');
  const [search, setSearch] = useState('');

  const descriptors = useMemo(() => {
    const query = search.trim().toLowerCase();
    const ids =
      query.length === 0
        ? FILTER_LIBRARY[group]
        : [...new Set(Object.values(FILTER_LIBRARY).flat())];
    return descriptorsFor(ids).filter(
      (descriptor) =>
        query.length === 0 ||
        descriptor.label.toLowerCase().includes(query) ||
        descriptor.description?.toLowerCase().includes(query) === true ||
        descriptor.tags.some((tag) => tag.toLowerCase().includes(query)),
    );
  }, [group, search]);

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
      search={{ value: search, onChange: setSearch, placeholder: 'Search filters…' }}
      tabs={FILTER_TABS}
      activeTab={group}
      onTabChange={(id) => setGroup(id as FilterLibraryGroupId)}
    >
      <div className="filters-target" aria-live="polite">
        <span>Target</span>
        <strong>{targetLabel ?? 'No media selected'}</strong>
      </div>
      <div className={`filters-grid${descriptors.length === 0 ? ' is-empty' : ''}`}>
        {descriptors.length === 0 ? (
          <p className="empty-hint">No filters match your search.</p>
        ) : (
          descriptors.map((descriptor) => (
            <button
              key={descriptor.id}
              type="button"
              className="filter-library-card"
              disabled={!canCreate}
              aria-label={`Add ${descriptor.label} Filters layer`}
              title={`${descriptor.label} — ${descriptor.description ?? 'Creative filter'}`}
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
          ))
        )}
      </div>
    </PanelShell>
  );
}
