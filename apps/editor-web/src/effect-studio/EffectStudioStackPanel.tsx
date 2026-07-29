import { useMemo, useState } from 'react';
import {
  listEffects,
  listPresets,
  type EffectInstanceV1,
  type JoyEffectPresetV1,
} from '@joy-media/visual-effects';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DuplicateIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '../icons.js';

interface EffectStudioStackPanelProps {
  readonly effects: readonly EffectInstanceV1[];
  readonly selectedEffectId: string | undefined;
  readonly onSelect: (effectId: string) => void;
  readonly onAdd: (effectId: string) => void;
  readonly onAddPreset: (preset: JoyEffectPresetV1) => void;
  readonly onToggle: (effectId: string) => void;
  readonly onDuplicate: (effectId: string) => void;
  readonly onRemove: (effectId: string) => void;
  readonly onMove: (effectId: string, direction: -1 | 1) => void;
}

export function EffectStudioStackPanel({
  effects,
  selectedEffectId,
  onSelect,
  onAdd,
  onAddPreset,
  onToggle,
  onDuplicate,
  onRemove,
  onMove,
}: EffectStudioStackPanelProps) {
  const [tab, setTab] = useState<'stack' | 'library'>('stack');
  const [query, setQuery] = useState('');
  const descriptors = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return listEffects().filter(
      (effect) =>
        normalized.length === 0 ||
        effect.label.toLowerCase().includes(normalized) ||
        effect.tags.some((tag) => tag.includes(normalized)),
    );
  }, [query]);

  return (
    <aside className="es-panel es-stack-panel">
      <div className="es-panel-heading">
        <div>
          <span className="es-panel-eyebrow">Pipeline</span>
          <h2>Effect stack</h2>
        </div>
        <span className="es-count-pill">{effects.length}</span>
      </div>
      <div className="es-segmented" role="tablist" aria-label="Effect stack sections">
        <button
          type="button"
          className={tab === 'stack' ? 'is-active' : ''}
          onClick={() => setTab('stack')}
        >
          Stack
        </button>
        <button
          type="button"
          className={tab === 'library' ? 'is-active' : ''}
          onClick={() => setTab('library')}
        >
          Library
        </button>
      </div>

      {tab === 'stack' ? (
        <div className="es-stack-list">
          {effects.length === 0 && (
            <div className="es-empty-stack">
              <span className="es-empty-stack-orbit" />
              <strong>Build your visual pipeline</strong>
              <span>Add an effect or start from a recipe.</span>
              <button type="button" onClick={() => setTab('library')}>
                Browse effects
              </button>
            </div>
          )}
          {effects.map((effect, index) => {
            const descriptor = listEffects().find((item) => item.id === effect.effectId);
            return (
              <article
                key={effect.id}
                className={`es-stack-card${selectedEffectId === effect.id ? ' is-selected' : ''}${effect.enabled ? '' : ' is-disabled'}`}
                onClick={() => onSelect(effect.id)}
              >
                <div className="es-stack-order">{String(index + 1).padStart(2, '0')}</div>
                <img
                  src={`/effects/preview/${effect.effectId}.png`}
                  alt=""
                  width="40"
                  height="40"
                />
                <div className="es-stack-card-copy">
                  <strong>{effect.label ?? descriptor?.label ?? effect.effectId}</strong>
                  <span>{descriptor?.category ?? 'effect'}</span>
                </div>
                <button
                  className="es-card-action"
                  type="button"
                  title={effect.enabled ? 'Disable' : 'Enable'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(effect.id);
                  }}
                >
                  {effect.enabled ? <EyeIcon /> : <EyeOffIcon />}
                </button>
                <div className="es-stack-card-tools">
                  <button
                    type="button"
                    disabled={index === 0}
                    title="Move up"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(effect.id, -1);
                    }}
                  >
                    <ChevronUpIcon />
                  </button>
                  <button
                    type="button"
                    disabled={index === effects.length - 1}
                    title="Move down"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(effect.id, 1);
                    }}
                  >
                    <ChevronDownIcon />
                  </button>
                  <button
                    type="button"
                    title="Duplicate"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDuplicate(effect.id);
                    }}
                  >
                    <DuplicateIcon />
                  </button>
                  <button
                    type="button"
                    title="Remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemove(effect.id);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </article>
            );
          })}
          {effects.length > 0 && (
            <button className="es-add-effect-row" type="button" onClick={() => setTab('library')}>
              <PlusIcon />
              Add effect
            </button>
          )}
        </div>
      ) : (
        <div className="es-library">
          <label className="es-library-search">
            <SearchIcon />
            <input
              value={query}
              placeholder="Search 25 effects"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <p className="es-library-label">Starter recipes</p>
          <div className="es-preset-strip">
            {listPresets()
              .slice(0, 5)
              .map((preset) => (
                <button key={preset.id} type="button" onClick={() => onAddPreset(preset)}>
                  <span>{preset.name}</span>
                  <small>{preset.effects.length} effects</small>
                </button>
              ))}
          </div>
          <p className="es-library-label">All effects</p>
          <div className="es-library-grid">
            {descriptors.map((effect) => (
              <button key={effect.id} type="button" onClick={() => onAdd(effect.id)}>
                <img
                  src={`/effects/preview/${effect.id}.png`}
                  alt=""
                  width="64"
                  height="48"
                  loading="lazy"
                />
                <span>{effect.label}</span>
                <small>{effect.category}</small>
                <i>
                  <PlusIcon />
                </i>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
