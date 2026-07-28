import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MotionFill, MotionLayer, MotionLayerId, MotionSceneDocument } from '@joy-media/motion-core';
import { evaluateMotionScene, resolveLayerWorld, resolvedLayerOpacity, resolvedLayerTransform, type LayerWorldEvaluation } from '@joy-media/motion-core';
import { JOY_COLORS } from '../theme.js';
import { TrashIcon, DuplicateIcon, LayersIcon, UnlockIcon, LockIcon } from '../icons.js';
import type { SceneCommand } from './state/sceneCommands.js';

interface LayerElementProps {
  readonly layer: MotionLayer;
  readonly evaluation: import('@joy-media/motion-core').LayerEvaluation | undefined;
  readonly world: import('@joy-media/motion-core').LayerWorldEvaluation | undefined;
  readonly isSelected: boolean;
  readonly editingText: boolean;
  readonly onPointerDown: (e: React.PointerEvent, layerId: MotionLayerId) => void;
  readonly onDoubleClick: (e: React.MouseEvent, layerId: MotionLayerId) => void;
  readonly onContextMenu: (e: React.MouseEvent, layerId: MotionLayerId) => void;
  readonly onTextChange: (layerId: MotionLayerId, text: string) => void;
  readonly onTextEditEnd: (layerId: MotionLayerId) => void;
}

function assetUrl(assetId: string | undefined): string {
  if (!assetId) return '';
  return `/v1/library/cloud-assets/${encodeURIComponent(assetId)}/content`;
}

function bgToCSS(background: MotionSceneDocument['background']): string {
  switch (background.kind) {
    case 'solid':
      return background.color ?? 'transparent';
    case 'gradient': {
      const g = background.gradient;
      if (!g) return 'transparent';
      const stops = g.stops
        .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
        .join(', ');
      return `linear-gradient(${g.angle ?? 90}deg, ${stops})`;
    }
    case 'image':
      return assetUrl(background.assetId);
    default:
      return 'transparent';
  }
}

function fillToCSS(fill: MotionFill): string {
  if (fill.kind === 'solid') return fill.color;
  if (fill.kind === 'gradient') {
    const g = fill.gradient;
    const stops = g.stops
      .map((s) => `${s.color} ${(s.position * 100).toFixed(1)}%`)
      .join(', ');
    return `linear-gradient(${g.angle ?? 90}deg, ${stops})`;
  }
  return 'transparent';
}

function LayerElement({
  layer,
  evaluation,
  world,
  isSelected,
  editingText,
  onPointerDown,
  onDoubleClick,
  onContextMenu,
  onTextChange,
  onTextEditEnd,
}: LayerElementProps) {
  const local = resolvedLayerTransform(layer, evaluation);
  const opacity = resolvedLayerOpacity(layer, evaluation);
  const t = world?.worldTransform ?? local;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: t.x,
    top: t.y,
    width: t.width || undefined,
    height: t.height || undefined,
    transform: `rotate(${t.rotationDeg}deg) scale(${t.scaleX}, ${t.scaleY})`,
    transformOrigin: `${t.transformOriginX} ${t.transformOriginY}`,
    opacity: layer.visible ? opacity : 0,
    cursor: layer.locked ? 'default' : editingText ? 'text' : isSelected ? 'move' : 'pointer',
    overflow: layer.overflow,
    borderRadius: `${layer.borderRadius[0] ?? 0}px ${layer.borderRadius[1] ?? 0}px ${layer.borderRadius[2] ?? 0}px ${layer.borderRadius[3] ?? 0}px`,
    mixBlendMode: (layer.blendMode as React.CSSProperties['mixBlendMode']) || 'normal',
    userSelect: 'none',
    pointerEvents: layer.locked ? 'none' : 'auto',
  };

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      onTextChange(layer.id, e.currentTarget.textContent || '');
    },
    [layer.id, onTextChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        e.currentTarget.blur();
      }
    },
    [onTextEditEnd],
  );

  const handleBlur = useCallback(() => {
    onTextEditEnd(layer.id);
  }, [layer.id, onTextEditEnd]);

  const commonProps = {
    'data-layer-id': layer.id,
    className: `ms-layer${isSelected ? ' ms-layer-selected' : ''}`,
    style,
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, layer.id),
    onDoubleClick: (e: React.MouseEvent) => onDoubleClick(e, layer.id),
    onContextMenu: (e: React.MouseEvent) => onContextMenu(e, layer.id),
  };

  if (layer.type === 'text') {
    if (editingText) {
      return (
        <div
          {...commonProps}
          suppressContentEditableWarning
          contentEditable
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={`${commonProps.className} ms-layer-text-editing`}
          style={{
            ...style,
            outline: 'none',
            pointerEvents: 'auto',
            userSelect: 'text',
          }}
          autoFocus
          role="textbox"
          aria-multiline
        >
          {layer.text ?? ''}
        </div>
      );
    }
    return (
      <div {...commonProps}>
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            color: layer.fills[0] ? fillToCSS(layer.fills[0]) : '#ffffff',
            fontFamily: layer.typography?.fontFamily ?? 'system-ui',
            fontSize: layer.typography?.fontSize ?? 40,
            fontWeight: layer.typography?.fontWeight ?? 400,
            lineHeight: layer.typography?.lineHeight ?? 1.2,
            letterSpacing: layer.typography?.letterSpacing ?? 0,
            textAlign: (layer.typography?.textAlign as React.CSSProperties['textAlign']) ?? 'left',
            textTransform: (layer.typography?.textTransform as React.CSSProperties['textTransform']) ?? 'none',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            pointerEvents: 'none',
          }}
        >
          {layer.text ?? ''}
        </div>
      </div>
    );
  }

  if (layer.type === 'shape') {
    const fill = layer.fills[0];
    const stroke = layer.strokes[0];
    return (
      <div {...commonProps}>
        <div
          style={{
            width: '100%',
            height: '100%',
            background: fill ? fillToCSS(fill) : 'transparent',
            border: stroke ? `${stroke.width}px solid ${stroke.color}` : 'none',
            borderRadius: `${(layer.borderRadius[0] ?? 0)}px ${(layer.borderRadius[1] ?? 0)}px ${(layer.borderRadius[2] ?? 0)}px ${(layer.borderRadius[3] ?? 0)}px`,
            pointerEvents: 'none',
          }}
        />
      </div>
    );
  }

  if (layer.type === 'image' || layer.type === 'video') {
    return (
      <div {...commonProps}>
        {layer.assetId ? (
          <img
            src={assetUrl(layer.assetId)}
            alt={layer.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
            draggable={false}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#333', pointerEvents: 'none' }} />
        )}
      </div>
    );
  }

  return (
    <div {...commonProps}>
      <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.08)', pointerEvents: 'none' }} />
    </div>
  );
}

export interface MotionStudioCanvasProps {
  readonly document: MotionSceneDocument;
  readonly selectedLayerIds: readonly MotionLayerId[];
  readonly onSelectLayer: (layerId: MotionLayerId | null) => void;
  readonly onSelectLayers: (layerIds: readonly MotionLayerId[]) => void;
  readonly onToggleLayerSelection: (layerId: MotionLayerId) => void;
  readonly onClearSelection: () => void;
  readonly onSetLayerTransform: (layerId: MotionLayerId, transform: Partial<MotionLayer['transform']>) => void;
  readonly onDispatch: (label: string, ...commands: SceneCommand[]) => void;
  readonly onBeginTransaction: () => void;
  readonly onUpdateTransaction: (...commands: SceneCommand[]) => void;
  readonly onCommitTransaction: (label: string) => void;
  readonly onCancelTransaction: () => void;
  readonly onDuplicateSelected: () => void;
  readonly onDeleteSelected: () => void;
  readonly onBringToFront: () => void;
  readonly onSendToBack: () => void;
  readonly onGroupSelected: () => void;
  readonly onUngroupSelected: () => void;
  readonly onAddTextLayer: () => void;
  readonly onAddRectangleLayer: () => void;
  readonly onAddEllipseLayer: () => void;
  readonly onAddImageLayer: () => void;
  readonly onAddVideoLayer: () => void;
  readonly canvasScale?: number;
  readonly playheadMs?: number;
}

interface GuideLine {
  readonly orientation: 'vertical' | 'horizontal';
  readonly position: number;
}

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly layerId: MotionLayerId | null;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const HANDLE_SIZE = 8;
const ROTATE_HANDLE_OFFSET = 24;
const SNAP_THRESHOLD = 8;

function rotatedAxes(deg: number): { axisX: Point; axisY: Point } {
  const rad = (deg * Math.PI) / 180;
  return { axisX: { x: Math.cos(rad), y: Math.sin(rad) }, axisY: { x: -Math.sin(rad), y: Math.cos(rad) } };
}

function worldToLocal(point: Point, center: Point, deg: number): Point {
  const { axisX, axisY } = rotatedAxes(deg);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return { x: dx * axisX.x + dy * axisX.y, y: dx * axisY.x + dy * axisY.y };
}

function localToWorld(local: Point, center: Point, deg: number): Point {
  const { axisX, axisY } = rotatedAxes(deg);
  return {
    x: center.x + local.x * axisX.x + local.y * axisY.x,
    y: center.y + local.x * axisX.y + local.y * axisY.y,
  };
}

export function MotionStudioCanvas({
  document,
  selectedLayerIds,
  onSelectLayer,
  onSelectLayers,
  onToggleLayerSelection,
  onClearSelection,
  onSetLayerTransform,
  onDispatch,
  onBeginTransaction,
  onUpdateTransaction,
  onCommitTransaction,
  onCancelTransaction,
  onDuplicateSelected,
  onDeleteSelected,
  onBringToFront,
  onSendToBack,
  onGroupSelected,
  onUngroupSelected,
  onAddTextLayer,
  onAddRectangleLayer,
  onAddEllipseLayer,
  onAddImageLayer,
  onAddVideoLayer,
  canvasScale = 1,
  playheadMs = 0,
}: MotionStudioCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [editingTextLayerId, setEditingTextLayerId] = useState<MotionLayerId | null>(null);
  const evaluated = useMemo(() => evaluateMotionScene(document, playheadMs), [document, playheadMs]);
  const layersById = useMemo(() => {
    const map: Record<string, MotionLayer> = {};
    for (const layer of document.layers) map[layer.id] = layer;
    return map;
  }, [document.layers]);
  const world = useMemo(() => {
    const map = new Map<MotionLayerId, LayerWorldEvaluation>();
    for (const layer of document.layers) {
      map.set(layer.id, resolveLayerWorld(layer, evaluated.get(layer.id), layersById));
    }
    return map;
  }, [document.layers, evaluated, layersById]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null);
  const [guides, setGuides] = useState<GuideLine[]>([]);

  const dragRef = useRef<{
    mode: 'move' | 'resize' | 'rotate' | 'marquee' | null;
    layerId: MotionLayerId | null;
    handle: string | null;
    initialPointer: Point;
    initialTransforms: Map<MotionLayerId, MotionLayer['transform']>;
    initialRotation: number;
    initialCenter: Point;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    canvasScale: number;
  }>({
    mode: null,
    layerId: null,
    handle: null,
    initialPointer: { x: 0, y: 0 },
    initialTransforms: new Map(),
    initialRotation: 0,
    initialCenter: { x: 0, y: 0 },
    shiftKey: false,
    altKey: false,
    metaKey: false,
    canvasScale: 1,
  });

  const sceneToScreen = useCallback(
    (p: Point): Point => {
      const stage = stageRef.current;
      if (!stage) return p;
      const rect = stage.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      return {
        x: centerX + (p.x - document.width / 2) * canvasScale,
        y: centerY + (p.y - document.height / 2) * canvasScale,
      };
    },
    [canvasScale, document.width, document.height],
  );

  const screenToScene = useCallback(
    (clientX: number, clientY: number): Point => {
      const stage = stageRef.current;
      if (!stage) return { x: 0, y: 0 };
      const rect = stage.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      return {
        x: document.width / 2 + (clientX - rect.left - centerX) / canvasScale,
        y: document.height / 2 + (clientY - rect.top - centerY) / canvasScale,
      };
    },
    [canvasScale, document.width, document.height],
  );

  const singleSelectedLayer = useMemo(() => {
    if (selectedLayerIds.length === 1) {
      return document.layers.find((l) => l.id === selectedLayerIds[0]) ?? null;
    }
    return null;
  }, [document.layers, selectedLayerIds]);

  const selectedLayers = useMemo(
    () => document.layers.filter((l) => selectedLayerIds.includes(l.id)),
    [document.layers, selectedLayerIds],
  );

  const commitLayerTransforms = useCallback(
    (layerIds: readonly MotionLayerId[], transformMap: Map<MotionLayerId, MotionLayer['transform']>) => {
      const commands: SceneCommand[] = [];
      for (const id of layerIds) {
        const layer = document.layers.find((l) => l.id === id);
        const base = transformMap.get(id);
        if (!layer || !base) continue;
        const next = layer.transform;
        if (next !== base) {
          commands.push({ type: 'scene.setLayerTransform', payload: { layerId: id, transform: next } });
        }
      }
      if (commands.length > 0) {
        onUpdateTransaction(...commands);
      }
    },
    [document.layers, onUpdateTransaction],
  );

  const computeSnap = useCallback(
    (
      movingLayers: readonly MotionLayer[],
      transformMap: Map<MotionLayerId, MotionLayer['transform']>,
      delta: Point,
    ): { snap: Point; guides: GuideLine[] } => {
      const threshold = SNAP_THRESHOLD / canvasScale;
      let snapX = 0;
      let snapY = 0;
      const foundGuides: GuideLine[] = [];

      const candidates: number[] = [];
      const addVertical = (x: number) => candidates.push(x);
      const addHorizontal = (y: number) => candidates.push(y);

      const sceneTargets = [
        document.width / 2,
        0,
        document.width,
      ];

      for (const layer of movingLayers) {
        const base = transformMap.get(layer.id);
        if (!base) continue;
        const t = {
          ...base,
          x: base.x + delta.x,
          y: base.y + delta.y,
        };
        addVertical(t.x + t.width / 2);
        addVertical(t.x);
        addVertical(t.x + t.width);
        addHorizontal(t.y + t.height / 2);
        addHorizontal(t.y);
        addHorizontal(t.y + t.height);
      }

      for (const layer of document.layers) {
        if (movingLayers.some((l) => l.id === layer.id)) continue;
        addVertical(layer.transform.x + layer.transform.width / 2);
        addVertical(layer.transform.x);
        addVertical(layer.transform.x + layer.transform.width);
        addHorizontal(layer.transform.y + layer.transform.height / 2);
        addHorizontal(layer.transform.y);
        addHorizontal(layer.transform.y + layer.transform.height);
      }

      for (const target of sceneTargets) {
        for (const c of candidates) {
          const diff = target - c;
          if (Math.abs(diff) < threshold && Math.abs(diff) > Math.abs(snapX)) {
            snapX = diff;
          }
        }
      }

      for (const target of [0, document.height / 2, document.height]) {
        for (const c of candidates) {
          const diff = target - c;
          if (Math.abs(diff) < threshold && Math.abs(diff) > Math.abs(snapY)) {
            snapY = diff;
          }
        }
      }

      for (const layer of document.layers) {
        if (movingLayers.some((l) => l.id === layer.id)) continue;
        const targetV = layer.transform.x + layer.transform.width / 2;
        for (const c of candidates) {
          const diff = targetV - c;
          if (Math.abs(diff) < threshold && Math.abs(diff) > Math.abs(snapX)) {
            snapX = diff;
          }
        }
        const targetH = layer.transform.y + layer.transform.height / 2;
        for (const c of candidates) {
          const diff = targetH - c;
          if (Math.abs(diff) < threshold && Math.abs(diff) > Math.abs(snapY)) {
            snapY = diff;
          }
        }
      }

      if (snapX !== 0) {
        const guideX = movingLayers[0] ? movingLayers[0].transform.x + movingLayers[0].transform.width / 2 + snapX : document.width / 2;
        foundGuides.push({ orientation: 'vertical', position: guideX });
      }
      if (snapY !== 0) {
        const guideY = movingLayers[0] ? movingLayers[0].transform.y + movingLayers[0].transform.height / 2 + snapY : document.height / 2;
        foundGuides.push({ orientation: 'horizontal', position: guideY });
      }

      return { snap: { x: snapX, y: snapY }, guides: foundGuides };
    },
    [canvasScale, document.layers, document.width, document.height],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editingTextLayerId) {
        setEditingTextLayerId(null);
      }
      const target = e.target as HTMLElement;
      const layerEl = target.closest('[data-layer-id]') as HTMLElement | null;
      const stage = stageRef.current;
      if (!stage) return;

      const addToSelection = e.shiftKey || e.metaKey || e.ctrlKey;
      const scenePoint = screenToScene(e.clientX, e.clientY);

      if (layerEl) {
        const layerId = layerEl.dataset.layerId!;
        const layer = document.layers.find((l) => l.id === layerId);
        if (!layer || layer.locked) return;

        if (!selectedLayerIds.includes(layerId)) {
          if (addToSelection) {
            onToggleLayerSelection(layerId);
          } else {
            onSelectLayer(layerId);
          }
        }

        const selection = addToSelection && selectedLayerIds.includes(layerId)
          ? [...selectedLayerIds]
          : selectedLayerIds.includes(layerId) && selectedLayerIds.length > 1
            ? [...selectedLayerIds]
            : [layerId];

        const transforms = new Map<MotionLayerId, MotionLayer['transform']>();
        for (const id of selection) {
          const l = document.layers.find((x) => x.id === id);
          if (l) transforms.set(id, l.transform);
        }

        dragRef.current = {
          mode: 'move',
          layerId,
          handle: null,
          initialPointer: scenePoint,
          initialTransforms: transforms,
          initialRotation: 0,
          initialCenter: { x: 0, y: 0 },
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey || e.ctrlKey,
          canvasScale,
        };
        onBeginTransaction();
        setGuides([]);
      } else {
        if (!addToSelection) {
          onClearSelection();
        }
        dragRef.current = {
          mode: 'marquee',
          layerId: null,
          handle: null,
          initialPointer: scenePoint,
          initialTransforms: new Map(),
          initialRotation: 0,
          initialCenter: { x: 0, y: 0 },
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey || e.ctrlKey,
          canvasScale,
        };
        setMarquee({ start: scenePoint, current: scenePoint });
        onBeginTransaction();
      }

      stage.setPointerCapture(e.pointerId);
    },
    [document.layers, editingTextLayerId, onBeginTransaction, onClearSelection, onSelectLayer, onToggleLayerSelection, screenToScene, selectedLayerIds, canvasScale],
  );

  const handleHandlePointerDown = useCallback(
    (e: React.PointerEvent, handle: string) => {
      e.stopPropagation();
      e.preventDefault();
      const layer = singleSelectedLayer;
      const stage = stageRef.current;
      if (!layer || !stage) return;

      const scenePoint = screenToScene(e.clientX, e.clientY);
      const t = layer.transform;
      const center = { x: t.x + t.width / 2, y: t.y + t.height / 2 };

      dragRef.current = {
        mode: handle === 'rotate' ? 'rotate' : 'resize',
        layerId: layer.id,
        handle,
        initialPointer: scenePoint,
        initialTransforms: new Map([[layer.id, layer.transform]]),
        initialRotation: t.rotationDeg,
        initialCenter: center,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey || e.ctrlKey,
        canvasScale,
      };
      onBeginTransaction();
      setGuides([]);
      stage.setPointerCapture(e.pointerId);
    },
    [onBeginTransaction, screenToScene, singleSelectedLayer, canvasScale],
  );

  const handleRotateMove = useCallback(
    (pointer: Point) => {
      const { layerId, initialCenter, initialRotation, shiftKey } = dragRef.current;
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer || !layerId) return;

      const angle = Math.atan2(pointer.y - initialCenter.y, pointer.x - initialCenter.x);
      let deg = (angle * 180) / Math.PI;
      deg -= 90;
      let final = initialRotation + deg;
      if (shiftKey) {
        final = Math.round(final / 15) * 15;
      } else {
        const cardinals = [0, 90, 180, 270, -90, -180];
        for (const c of cardinals) {
          if (Math.abs(final - c) < 7) {
            final = c;
            break;
          }
        }
      }
      onSetLayerTransform(layerId, { rotationDeg: final });
    },
    [document.layers, onSetLayerTransform],
  );

  const handleResizeMove = useCallback(
    (pointer: Point) => {
      const { layerId, handle, initialTransforms, initialCenter, shiftKey, altKey } = dragRef.current;
      const layer = document.layers.find((l) => l.id === layerId);
      if (!layer || !layerId || !handle) return;
      const base = initialTransforms.get(layerId);
      if (!base) return;

      const t = base;
      const w = t.width;
      const h = t.height;
      const deg = t.rotationDeg;
      const { axisX, axisY } = rotatedAxes(deg);
      const anchorLocal = { x: 0, y: 0 };
      const pointerLocal = worldToLocal(pointer, initialCenter, deg);

      const handleMap: Record<string, { anchor: Point; sign: Point }> = {
        nw: { anchor: { x: w / 2, y: h / 2 }, sign: { x: -1, y: -1 } },
        n: { anchor: { x: 0, y: h / 2 }, sign: { x: 0, y: -1 } },
        ne: { anchor: { x: -w / 2, y: h / 2 }, sign: { x: 1, y: -1 } },
        e: { anchor: { x: -w / 2, y: 0 }, sign: { x: 1, y: 0 } },
        se: { anchor: { x: -w / 2, y: -h / 2 }, sign: { x: 1, y: 1 } },
        s: { anchor: { x: 0, y: -h / 2 }, sign: { x: 0, y: 1 } },
        sw: { anchor: { x: w / 2, y: -h / 2 }, sign: { x: -1, y: 1 } },
        w: { anchor: { x: w / 2, y: 0 }, sign: { x: -1, y: 0 } },
      };

      const cfg = handleMap[handle];
      if (!cfg) return;
      const anchorWorld = localToWorld(cfg.anchor, initialCenter, deg);
      const v = { x: pointer.x - anchorWorld.x, y: pointer.y - anchorWorld.y };
      const localV = { x: v.x * axisX.x + v.y * axisX.y, y: v.x * axisY.x + v.y * axisY.y };

      let newW = w;
      let newH = h;
      let newLocalX = 0;
      let newLocalY = 0;

      if (handle === 'n' || handle === 's') {
        newH = Math.max(10, cfg.sign.y * localV.y);
        newLocalX = 0;
        newLocalY = cfg.sign.y > 0 ? newH / 2 - h / 2 : -newH / 2 + h / 2;
      } else if (handle === 'e' || handle === 'w') {
        newW = Math.max(10, cfg.sign.x * localV.x);
        newLocalX = cfg.sign.x > 0 ? newW / 2 - w / 2 : -newW / 2 + w / 2;
        newLocalY = 0;
      } else {
        newW = Math.max(10, cfg.sign.x * localV.x);
        newH = Math.max(10, cfg.sign.y * localV.y);
      }

      if (shiftKey) {
        const ratio = w / h;
        if (handle === 'n' || handle === 's') {
          newW = newH * ratio;
        } else if (handle === 'e' || handle === 'w') {
          newH = newW / ratio;
        } else {
          if (newW / newH > ratio) {
            newW = newH * ratio;
          } else {
            newH = newW / ratio;
          }
        }
      }

      let newCenter = { ...initialCenter };
      if (!altKey) {
        const anchorSignX = cfg.anchor.x === 0 ? 0 : cfg.anchor.x > 0 ? 1 : -1;
        const anchorSignY = cfg.anchor.y === 0 ? 0 : cfg.anchor.y > 0 ? 1 : -1;
        const dw = newW - w;
        const dh = newH - h;
        const newLocalCenter = { x: (-anchorSignX * dw) / 2, y: (-anchorSignY * dh) / 2 };
        newCenter = localToWorld(newLocalCenter, initialCenter, deg);
      }

      const newTopLeft = localToWorld({ x: -newW / 2, y: -newH / 2 }, newCenter, deg);
      onSetLayerTransform(layerId, { x: newTopLeft.x, y: newTopLeft.y, width: newW, height: newH });
    },
    [document.layers, onSetLayerTransform],
  );

  const handleMoveMove = useCallback(
    (pointer: Point) => {
      const { initialPointer, initialTransforms, shiftKey } = dragRef.current;
      const dx = pointer.x - initialPointer.x;
      const dy = pointer.y - initialPointer.y;

      const movingLayers = selectedLayers.filter((l) => !l.locked);
      const { snap, guides } = shiftKey ? computeSnap(movingLayers, initialTransforms, { x: dx, y: dy }) : { snap: { x: 0, y: 0 }, guides: [] };
      setGuides(guides);

      const finalDx = dx + snap.x;
      const finalDy = dy + snap.y;
      for (const layer of movingLayers) {
        const base = initialTransforms.get(layer.id);
        if (!base) continue;
        onSetLayerTransform(layer.id, { x: base.x + finalDx, y: base.y + finalDy });
      }
    },
    [computeSnap, onSetLayerTransform, selectedLayers],
  );

  const handleMarqueeMove = useCallback(
    (pointer: Point) => {
      if (!marquee) return;
      setMarquee({ ...marquee, current: pointer });
    },
    [marquee],
  );

  const handleMarqueeEnd = useCallback(() => {
    if (!marquee) return;
    const left = Math.min(marquee.start.x, marquee.current.x);
    const right = Math.max(marquee.start.x, marquee.current.x);
    const top = Math.min(marquee.start.y, marquee.current.y);
    const bottom = Math.max(marquee.start.y, marquee.current.y);
    const inside = document.layers
      .filter((l) => {
        const t = l.transform;
        return t.x < right && t.x + t.width > left && t.y < bottom && t.y + t.height > top;
      })
      .map((l) => l.id);
    if (dragRef.current.metaKey) {
      const set = new Set([...selectedLayerIds, ...inside]);
      onSelectLayers([...set]);
    } else {
      onSelectLayers(inside);
    }
    setMarquee(null);
  }, [document.layers, marquee, onSelectLayers, selectedLayerIds]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const pointer = screenToScene(e.clientX, e.clientY);
      const { mode } = dragRef.current;
      if (mode === 'move') {
        handleMoveMove(pointer);
      } else if (mode === 'resize') {
        handleResizeMove(pointer);
      } else if (mode === 'rotate') {
        handleRotateMove(pointer);
      } else if (mode === 'marquee') {
        handleMarqueeMove(pointer);
      }
    },
    [handleMarqueeMove, handleMoveMove, handleResizeMove, handleRotateMove, screenToScene],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const { mode } = dragRef.current;
      if (mode === 'marquee') {
        handleMarqueeEnd();
      } else if (mode === 'move' || mode === 'resize' || mode === 'rotate') {
        onCommitTransaction(mode === 'move' ? 'Move layers' : mode === 'resize' ? 'Resize layer' : 'Rotate layer');
      }
      dragRef.current = {
        ...dragRef.current,
        mode: null,
        layerId: null,
        handle: null,
      };
      setGuides([]);
      try {
        stageRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [handleMarqueeEnd, onCommitTransaction],
  );

  const handleLayerPointerDown = useCallback(
    (e: React.PointerEvent, layerId: MotionLayerId) => {
      if (editingTextLayerId === layerId) {
        e.stopPropagation();
        return;
      }
      handlePointerDown(e);
    },
    [editingTextLayerId, handlePointerDown],
  );

  const handleLayerDoubleClick = useCallback(
    (_e: React.MouseEvent, layerId: MotionLayerId) => {
      const layer = document.layers.find((l) => l.id === layerId);
      if (layer?.type === 'text') {
        setEditingTextLayerId(layerId);
      }
    },
    [document.layers],
  );

  const handleLayerContextMenu = useCallback(
    (e: React.MouseEvent, layerId: MotionLayerId) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedLayerIds.includes(layerId)) {
        onSelectLayer(layerId);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, layerId });
    },
    [onSelectLayer, selectedLayerIds],
  );

  const handleStageContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, layerId: null });
    },
    [],
  );

  const handleTextChange = useCallback(
    (layerId: MotionLayerId, text: string) => {
      onDispatch('Set text', { type: 'scene.setLayerText', payload: { layerId, text } });
    },
    [onDispatch],
  );

  const handleTextEditEnd = useCallback(() => {
    setEditingTextLayerId(null);
  }, []);

  const handleMenuClose = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleMenuAction = useCallback(
    (action: string) => {
      setContextMenu(null);
      switch (action) {
        case 'cut':
        case 'copy':
          break;
        case 'duplicate':
          onDuplicateSelected();
          break;
        case 'delete':
          onDeleteSelected();
          break;
        case 'bring-front':
          onBringToFront();
          break;
        case 'send-back':
          onSendToBack();
          break;
        case 'group':
          onGroupSelected();
          break;
        case 'ungroup':
          onUngroupSelected();
          break;
        case 'select-all':
          onSelectLayers(document.layers.map((l) => l.id));
          break;
        case 'add-text':
          onAddTextLayer();
          break;
        case 'add-rect':
          onAddRectangleLayer();
          break;
        case 'add-ellipse':
          onAddEllipseLayer();
          break;
        case 'add-image':
          onAddImageLayer();
          break;
        case 'add-video':
          onAddVideoLayer();
          break;
      }
    },
    [document.layers, onAddEllipseLayer, onAddRectangleLayer, onAddTextLayer, onBringToFront, onDeleteSelected, onDuplicateSelected, onGroupSelected, onSelectLayers, onSendToBack, onUngroupSelected, onAddImageLayer, onAddVideoLayer],
  );

  useEffect(() => {
    function onGlobalPointerMove(ev: PointerEvent) {
      const stage = stageRef.current;
      if (!stage || dragRef.current.mode === null) return;
      handlePointerMove(ev as unknown as React.PointerEvent);
    }
    function onGlobalPointerUp(ev: PointerEvent) {
      handlePointerUp(ev as unknown as React.PointerEvent);
    }
    window.addEventListener('pointermove', onGlobalPointerMove);
    window.addEventListener('pointerup', onGlobalPointerUp);
    return () => {
      window.removeEventListener('pointermove', onGlobalPointerMove);
      window.removeEventListener('pointerup', onGlobalPointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  useEffect(() => {
    function onClick() {
      setContextMenu(null);
    }
    if (contextMenu) {
      window.addEventListener('click', onClick, { once: true });
      return () => window.removeEventListener('click', onClick);
    }
  }, [contextMenu]);

  const stageStyle: React.CSSProperties = {
    width: document.width,
    height: document.height,
    backgroundColor: bgToCSS(document.background),
    transform: `scale(${canvasScale})`,
    transformOrigin: 'center center',
    position: 'relative',
    overflow: 'hidden',
  };

  return (
    <div className="ms-canvas">
      <div className="ms-canvas-viewport">
        <div
          ref={stageRef}
          className="ms-canvas-stage"
          style={stageStyle}
          onPointerDown={handlePointerDown}
          onContextMenu={handleStageContextMenu}
          data-playhead={playheadMs}
        >
          {document.layers.map((layer) => (
            <LayerElement
              key={layer.id}
              layer={layer}
              evaluation={evaluated.get(layer.id)}
              world={world.get(layer.id)}
              isSelected={selectedLayerIds.includes(layer.id)}
              editingText={editingTextLayerId === layer.id}
              onPointerDown={handleLayerPointerDown}
              onDoubleClick={handleLayerDoubleClick}
              onContextMenu={handleLayerContextMenu}
              onTextChange={handleTextChange}
              onTextEditEnd={handleTextEditEnd}
            />
          ))}

          {singleSelectedLayer && !editingTextLayerId && (
            <SelectionOverlay
              layer={singleSelectedLayer}
              canvasScale={canvasScale}
              onHandlePointerDown={handleHandlePointerDown}
            />
          )}

          {selectedLayerIds.length > 1 &&
            selectedLayers.map(
              (layer) =>
                !layer.locked && (
                  <div
                    key={`box-${layer.id}`}
                    className="ms-selection-box"
                    style={{
                      position: 'absolute',
                      left: layer.transform.x,
                      top: layer.transform.y,
                      width: layer.transform.width,
                      height: layer.transform.height,
                      transform: `rotate(${layer.transform.rotationDeg}deg) scale(${layer.transform.scaleX}, ${layer.transform.scaleY})`,
                      transformOrigin: 'center center',
                      pointerEvents: 'none',
                    }}
                  />
                ),
            )}

          {guides.map((guide, idx) =>
            guide.orientation === 'vertical' ? (
              <div
                key={`v-${idx}`}
                className="ms-guide"
                style={{
                  position: 'absolute',
                  left: guide.position,
                  top: 0,
                  width: 1,
                  height: document.height,
                  pointerEvents: 'none',
                }}
              />
            ) : (
              <div
                key={`h-${idx}`}
                className="ms-guide"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: guide.position,
                  width: document.width,
                  height: 1,
                  pointerEvents: 'none',
                }}
              />
            ),
          )}

          {marquee && (
            <div
              className="ms-marquee"
              style={{
                position: 'absolute',
                left: Math.min(marquee.start.x, marquee.current.x),
                top: Math.min(marquee.start.y, marquee.current.y),
                width: Math.abs(marquee.current.x - marquee.start.x),
                height: Math.abs(marquee.current.y - marquee.start.y),
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          layerId={contextMenu.layerId}
          onClose={handleMenuClose}
          onAction={handleMenuAction}
          onSelectLayer={onSelectLayer}
          onDeleteSelected={onDeleteSelected}
          onDuplicateSelected={onDuplicateSelected}
          onBringToFront={onBringToFront}
          onSendToBack={onSendToBack}
          onGroupSelected={onGroupSelected}
          onUngroupSelected={onUngroupSelected}
        />
      )}
    </div>
  );
}

interface SelectionOverlayProps {
  readonly layer: MotionLayer;
  readonly canvasScale: number;
  readonly onHandlePointerDown: (e: React.PointerEvent, handle: string) => void;
}

function SelectionOverlay({ layer, onHandlePointerDown }: SelectionOverlayProps) {
  const t = layer.transform;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: t.x,
    top: t.y,
    width: t.width,
    height: t.height,
    transform: `rotate(${t.rotationDeg}deg) scale(${t.scaleX}, ${t.scaleY})`,
    transformOrigin: 'center center',
    pointerEvents: 'none',
  };

  const handlePositions: Record<string, React.CSSProperties> = {
    nw: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 },
    n: { left: '50%', top: -HANDLE_SIZE / 2, marginLeft: -HANDLE_SIZE / 2 },
    ne: { right: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 },
    e: { right: -HANDLE_SIZE / 2, top: '50%', marginTop: -HANDLE_SIZE / 2 },
    se: { right: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 },
    s: { left: '50%', bottom: -HANDLE_SIZE / 2, marginLeft: -HANDLE_SIZE / 2 },
    sw: { left: -HANDLE_SIZE / 2, bottom: -HANDLE_SIZE / 2 },
    w: { left: -HANDLE_SIZE / 2, top: '50%', marginTop: -HANDLE_SIZE / 2 },
  };

  return (
    <div className="ms-selection-overlay" style={style}>
      {Object.entries(handlePositions).map(([name, pos]) => (
        <div
          key={name}
          className={`ms-handle ms-handle-${name}`}
          style={{
            position: 'absolute',
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            borderRadius: 2,
            background: JOY_COLORS.accent,
            border: '1px solid #fff',
            pointerEvents: 'auto',
            cursor: name.length === 2 ? `${name}-resize` : name === 'n' || name === 's' ? `${name}s-resize` : `${name}w-resize`,
            ...pos,
          }}
          onPointerDown={(e) => onHandlePointerDown(e, name)}
          data-handle={name}
        />
      ))}
      <div
        className="ms-handle ms-handle-rotate"
        style={{
          position: 'absolute',
          left: '50%',
          top: -ROTATE_HANDLE_OFFSET,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          marginLeft: -HANDLE_SIZE / 2,
          borderRadius: '50%',
          background: JOY_COLORS.accent,
          border: '1px solid #fff',
          pointerEvents: 'auto',
          cursor: 'grab',
        }}
        onPointerDown={(e) => onHandlePointerDown(e, 'rotate')}
        data-handle="rotate"
      >
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: HANDLE_SIZE / 2,
            width: 1,
            height: ROTATE_HANDLE_OFFSET - HANDLE_SIZE / 2,
            background: JOY_COLORS.accent,
            transform: 'translateX(-50%)',
          }}
        />
      </div>
    </div>
  );
}

interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly layerId: MotionLayerId | null;
  readonly onClose: () => void;
  readonly onAction: (action: string) => void;
  readonly onSelectLayer: (id: MotionLayerId | null) => void;
  readonly onDeleteSelected: () => void;
  readonly onDuplicateSelected: () => void;
  readonly onBringToFront: () => void;
  readonly onSendToBack: () => void;
  readonly onGroupSelected: () => void;
  readonly onUngroupSelected: () => void;
}

function ContextMenu({
  x,
  y,
  layerId,
  onClose,
  onAction,
  onDeleteSelected,
  onDuplicateSelected,
  onBringToFront,
  onSendToBack,
  onGroupSelected,
  onUngroupSelected,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ms-context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      role="menu"
    >
      {layerId ? (
        <>
          <button className="ms-context-item" role="menuitem" onClick={() => onDuplicateSelected()}>
            <span className="ms-context-icon"><DuplicateIcon /></span> Duplicate
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onDeleteSelected()}>
            <span className="ms-context-icon"><TrashIcon /></span> Delete
          </button>
          <div className="ms-context-separator" />
          <button className="ms-context-item" role="menuitem" onClick={() => onBringToFront()}>
            <span className="ms-context-icon"><LayersIcon /></span> Bring to front
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onSendToBack()}>
            <span className="ms-context-icon"><LayersIcon /></span> Send to back
          </button>
          <div className="ms-context-separator" />
          <button className="ms-context-item" role="menuitem" onClick={() => onGroupSelected()}>
            <span className="ms-context-icon"><LockIcon /></span> Group
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onUngroupSelected()}>
            <span className="ms-context-icon"><UnlockIcon /></span> Ungroup
          </button>
        </>
      ) : (
        <>
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-text')}>
            <span className="ms-add-text-glyph" aria-hidden="true">T</span> Add text
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-rect')}>
            <span className="ms-shape-icon-rect" /> Add rectangle
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-ellipse')}>
            <span className="ms-shape-icon-ellipse" /> Add ellipse
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-image')}>
            <span className="ms-image-icon" aria-hidden="true">🖼</span> Add image
          </button>
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('add-video')}>
            <span className="ms-video-icon" aria-hidden="true">🎬</span> Add video
          </button>
          <div className="ms-context-separator" />
          <button className="ms-context-item" role="menuitem" onClick={() => onAction('select-all')}>
            Select all
          </button>
        </>
      )}
    </div>
  );
}
