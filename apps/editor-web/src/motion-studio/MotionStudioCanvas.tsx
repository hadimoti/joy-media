import { useCallback } from 'react';
import type { MotionSceneDocument, MotionLayer, MotionFill, SceneBackground } from '@joy-media/motion-core';
import { JOY_COLORS } from '../theme.js';

interface LayerElementProps {
  readonly layer: MotionLayer;
  readonly isSelected: boolean;
  readonly onSelect: () => void;
}

function fillToCSS(fills: readonly MotionFill[]): React.CSSProperties {
  if (fills.length === 0) return {};
  const fill = fills[0]!;
  if (fill.kind === 'solid') {
    return { backgroundColor: fill.color, opacity: fill.opacity };
  }
  if (fill.kind === 'transparent') {
    return { backgroundColor: 'transparent' };
  }
  return {};
}

function bgToCSS(bg: SceneBackground): string {
  if (bg.kind === 'solid' && bg.color) return bg.color;
  if (bg.kind === 'transparent') return 'transparent';
  return 'transparent';
}

function LayerElement({ layer, isSelected, onSelect }: LayerElementProps) {
  const { transform: t } = layer;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: t.x,
    top: t.y,
    width: t.width || undefined,
    height: t.height || undefined,
    transform: `rotate(${t.rotationDeg}deg) scale(${t.scaleX}, ${t.scaleY})`,
    transformOrigin: `${t.transformOriginX} ${t.transformOriginY}`,
    opacity: t.opacity,
    cursor: layer.locked ? 'default' : 'pointer',
    overflow: layer.overflow,
    borderRadius: layer.borderRadius.map((r) => `${r}px`).join(' '),
    borderWidth: layer.strokes.length > 0 ? `${layer.strokes[0]!.width}px` : undefined,
    borderStyle: layer.strokes.length > 0 ? (layer.strokes[0]!.style ?? 'solid') : undefined,
    borderColor: layer.strokes.length > 0 ? layer.strokes[0]!.color : undefined,
    boxShadow: layer.shadows
      .map((s) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`)
      .join(', ') || undefined,
    mixBlendMode: layer.blendMode !== 'normal' ? (layer.blendMode as React.CSSProperties['mixBlendMode']) : undefined,
    ...fillToCSS(layer.fills),
  };

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (layer.locked) return;
      e.stopPropagation();
      onSelect();
    },
    [layer.locked, onSelect],
  );

  if (!layer.visible) return null;

  if (layer.type === 'text') {
    return (
      <div
        onPointerDown={handlePointerDown}
        style={{
          ...style,
          fontFamily: layer.typography?.fontFamily,
          fontWeight: layer.typography?.fontWeight,
          fontStyle: layer.typography?.fontStyle,
          fontSize: layer.typography?.fontSize,
          lineHeight: layer.typography?.lineHeight,
          letterSpacing: layer.typography?.letterSpacing,
          textAlign: layer.typography?.textAlign as React.CSSProperties['textAlign'],
          direction: layer.typography?.direction as React.CSSProperties['direction'],
          textTransform: layer.typography?.textTransform as React.CSSProperties['textTransform'],
          textDecoration: [
            layer.typography?.underline ? 'underline' : '',
            layer.typography?.strikethrough ? 'line-through' : '',
          ].filter(Boolean).join(' ') || undefined,
          whiteSpace: layer.typography?.wrap ? 'normal' : 'nowrap',
          display: 'flex',
          alignItems: 'center',
          justifyContent: layer.typography?.textAlign === 'center' ? 'center'
            : layer.typography?.textAlign === 'right' ? 'flex-end'
            : 'flex-start',
          color: style.backgroundColor ? undefined : style.color,
          padding: '4px 8px',
          boxSizing: 'border-box',
        }}
        className={isSelected ? 'ms-layer-selected' : ''}
      >
        {layer.text ?? ''}
      </div>
    );
  }

  if (layer.type === 'image' && layer.assetId) {
    return (
      <div
        onPointerDown={handlePointerDown}
        style={style}
        className={isSelected ? 'ms-layer-selected' : ''}
      >
        <img
          src={`/api/assets/${layer.assetId}`}
          alt={layer.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      style={style}
      className={isSelected ? 'ms-layer-selected' : ''}
    />
  );
}

interface MotionStudioCanvasProps {
  readonly document: MotionSceneDocument;
  readonly selectedLayerIds: readonly string[];
  readonly onSelectLayer: (layerId: string | null) => void;
  readonly onLayerDragStart: () => void;
  readonly onLayerDragPreview: (layerId: string, transform: { x: number; y: number }) => void;
  readonly onLayerDragCommit: () => void;
  readonly canvasScale?: number;
  readonly playheadMs?: number;
}

export function MotionStudioCanvas({
  document,
  selectedLayerIds,
  onSelectLayer,
  onLayerDragStart,
  onLayerDragPreview,
  onLayerDragCommit,
  canvasScale = 1,
  playheadMs,
}: MotionStudioCanvasProps) {
  void playheadMs; // animation evaluation hook — expanded in Phase 6
  return (
    <div className="ms-canvas">
      <div className="ms-canvas-viewport">
        <div
          className="ms-canvas-stage"
          style={{
            width: document.width,
            height: document.height,
            backgroundColor: bgToCSS(document.background),
            transform: `scale(${canvasScale})`,
            transformOrigin: 'center center',
            position: 'relative',
            overflow: 'hidden',
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onSelectLayer(null);
          }}
        >
          {document.layers.map((layer) => (
            <LayerElement
              key={layer.id}
              layer={layer}
              isSelected={selectedLayerIds.includes(layer.id)}
              onSelect={() => onSelectLayer(layer.id)}
            />
          ))}
          {selectedLayerIds.map((id) => {
            const layer = document.layers.find((l) => l.id === id);
            if (!layer) return null;
            return (
              <SelectionOverlay
                key={`sel-${id}`}
                layer={layer}
                onDragStart={onLayerDragStart}
                onDragMove={(x, y) => {
                  onLayerDragPreview(id, { x: Math.round(x), y: Math.round(y) });
                }}
                onDragEnd={onLayerDragCommit}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface SelectionOverlayProps {
  readonly layer: MotionLayer;
  readonly onDragStart: () => void;
  readonly onDragMove: (x: number, y: number) => void;
  readonly onDragEnd: () => void;
}

function SelectionOverlay({ layer, onDragStart, onDragMove, onDragEnd }: SelectionOverlayProps) {
  const { transform: t } = layer;
  const handleSize = 8;

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      if (layer.locked) return;
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const baseX = t.x;
      const baseY = t.y;

      onDragStart();

      const onMove = (ev: PointerEvent) => {
        onDragMove(baseX + (ev.clientX - startX), baseY + (ev.clientY - startY));
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        onDragEnd();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [layer.locked, onDragStart, onDragMove, onDragEnd, t.x, t.y],
  );

  const style: React.CSSProperties = {
    position: 'absolute',
    left: t.x,
    top: t.y,
    width: t.width,
    height: t.height,
    border: `2px dashed ${JOY_COLORS.accent}`,
    pointerEvents: 'none',
    zIndex: 1000,
  };

  const handleStyle: React.CSSProperties = {
    position: 'absolute',
    width: handleSize,
    height: handleSize,
    backgroundColor: JOY_COLORS.accent,
    border: `1px solid ${JOY_COLORS.bgDeep}`,
    pointerEvents: 'auto',
    cursor: 'pointer',
  };

  return (
    <div style={style} aria-label={`Selection: ${layer.name}`}>
      <div
        style={{ ...handleStyle, top: -handleSize / 2, left: -handleSize / 2, cursor: 'nwse-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, top: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 'ns-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, top: -handleSize / 2, right: -handleSize / 2, cursor: 'nesw-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, top: '50%', marginTop: -handleSize / 2, left: -handleSize / 2, cursor: 'ew-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, top: '50%', marginTop: -handleSize / 2, right: -handleSize / 2, cursor: 'ew-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, bottom: -handleSize / 2, left: -handleSize / 2, cursor: 'nesw-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, bottom: -handleSize / 2, left: '50%', marginLeft: -handleSize / 2, cursor: 'ns-resize' }}
        onPointerDown={startDrag}
      />
      <div
        style={{ ...handleStyle, bottom: -handleSize / 2, right: -handleSize / 2, cursor: 'nwse-resize' }}
        onPointerDown={startDrag}
      />
    </div>
  );
}
