import { useCallback } from 'react';
import type { MotionSceneDocument, MotionLayer, MotionLayerId } from '@joy-media/motion-core';
import { createTextLayer, createRectangleLayer, createEllipseLayer } from './state/layerFactory.js';
import {
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  UnlockIcon,
  CloseIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from '../icons.js';

interface LayersPanelProps {
  readonly document: MotionSceneDocument;
  readonly selectedLayerIds: readonly MotionLayerId[];
  readonly onSelectLayer: (layerId: MotionLayerId | null) => void;
  readonly onAddLayer: (layer: MotionLayer) => void;
  readonly onRemoveLayer: (layerId: MotionLayerId) => void;
  readonly onToggleVisibility: (layerId: MotionLayerId) => void;
  readonly onToggleLocked: (layerId: MotionLayerId) => void;
  readonly onMoveLayer: (layerId: MotionLayerId, direction: 'up' | 'down') => void;
}

function layerIcon(type: MotionLayer['type']): string {
  switch (type) {
    case 'text':
      return 'T';
    case 'shape':
      return '\u25A0';
    case 'svg':
      return '\u2B1A';
    case 'image':
      return '\u2B1C';
    case 'video':
      return '\u25B6';
    case 'container':
      return '\u25A3';
    case 'group':
      return '\u25A3';
    case 'mask':
      return '\u2B1E';
    default:
      return '\u25CB';
  }
}

export function MotionStudioLayersPanel({
  document,
  selectedLayerIds,
  onSelectLayer,
  onAddLayer,
  onRemoveLayer,
  onToggleVisibility,
  onToggleLocked,
  onMoveLayer,
}: LayersPanelProps) {
  const handleAddText = useCallback(() => {
    onAddLayer(createTextLayer('Hello'));
  }, [onAddLayer]);

  const handleAddRect = useCallback(() => {
    onAddLayer(createRectangleLayer());
  }, [onAddLayer]);

  const handleAddEllipse = useCallback(() => {
    onAddLayer(createEllipseLayer());
  }, [onAddLayer]);

  const reversedLayers = [...document.layers].reverse();

  return (
    <aside className="ms-panel ms-left" aria-label="Layers">
      <div className="ms-panel-header">
        <h3 className="ms-panel-title">Layers</h3>
        <div className="ms-panel-actions">
          <button
            type="button"
            className="ms-icon-btn"
            title="Add text"
            aria-label="Add text layer"
            onClick={handleAddText}
          >
            T
          </button>
          <button
            type="button"
            className="ms-icon-btn"
            title="Add rectangle"
            aria-label="Add rectangle"
            onClick={handleAddRect}
          >
            <span className="ms-shape-icon-rect" />
          </button>
          <button
            type="button"
            className="ms-icon-btn"
            title="Add ellipse"
            aria-label="Add ellipse"
            onClick={handleAddEllipse}
          >
            <span className="ms-shape-icon-ellipse" />
          </button>
        </div>
      </div>
      <div className="ms-panel-body ms-layer-list">
        {reversedLayers.length === 0 ? (
          <div className="ms-empty-state" lang="fa">
            هنوز لایه‌ای وجود ندارد. شکل، متن یا تصویر اضافه کنید.
          </div>
        ) : (
          reversedLayers.map((layer, idx) => {
            const selected = selectedLayerIds.includes(layer.id);
            const origIdx = document.layers.length - 1 - idx;
            return (
              <div
                key={layer.id}
                className={`ms-layer-row${selected ? ' ms-layer-row-selected' : ''}`}
                onClick={() => onSelectLayer(layer.id)}
              >
                <button
                  type="button"
                  className="ms-layer-toggle"
                  aria-label="Move layer up"
                  title="Move up"
                  disabled={origIdx >= document.layers.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveLayer(layer.id, 'up');
                  }}
                >
                  <ChevronUpIcon />
                </button>
                <button
                  type="button"
                  className="ms-layer-toggle"
                  aria-label="Move layer down"
                  title="Move down"
                  disabled={origIdx <= 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveLayer(layer.id, 'down');
                  }}
                >
                  <ChevronDownIcon />
                </button>
                <span className="ms-layer-icon">{layerIcon(layer.type)}</span>
                <span className="ms-layer-name">{layer.name}</span>
                <button
                  type="button"
                  className="ms-layer-toggle"
                  aria-label={layer.visible ? 'Hide layer' : 'Show layer'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility(layer.id);
                  }}
                >
                  {layer.visible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
                <button
                  type="button"
                  className="ms-layer-toggle"
                  aria-label={layer.locked ? 'Unlock layer' : 'Lock layer'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLocked(layer.id);
                  }}
                >
                  {layer.locked ? <LockIcon /> : <UnlockIcon />}
                </button>
                <button
                  type="button"
                  className="ms-layer-toggle ms-layer-delete"
                  aria-label="Delete layer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveLayer(layer.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
