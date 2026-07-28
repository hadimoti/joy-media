import type {
  MotionSceneDocument,
  MotionLayer,
  MotionLayerId,
  MotionTransform,
  MotionFill,
  MotionStroke,
  MotionShadow,
  MotionTypography,
  SceneBackground,
} from '@joy-media/motion-core';

export interface AddLayerCommand {
  readonly type: 'scene.addLayer';
  readonly payload: { readonly layer: MotionLayer; readonly index?: number };
}

export interface RemoveLayerCommand {
  readonly type: 'scene.removeLayer';
  readonly payload: { readonly layerId: MotionLayerId };
}

export interface MoveLayerCommand {
  readonly type: 'scene.moveLayer';
  readonly payload: { readonly layerId: MotionLayerId; readonly newIndex: number };
}

export interface SetLayerTransformCommand {
  readonly type: 'scene.setLayerTransform';
  readonly payload: { readonly layerId: MotionLayerId; readonly transform: Partial<MotionTransform> };
}

export interface SetLayerPropertyCommand {
  readonly type: 'scene.setLayerProperty';
  readonly payload: { readonly layerId: MotionLayerId; readonly property: string; readonly value: unknown };
}

export interface SetLayerTypographyCommand {
  readonly type: 'scene.setLayerTypography';
  readonly payload: { readonly layerId: MotionLayerId; readonly typography: Partial<MotionTypography> };
}

export interface SetLayerTextCommand {
  readonly type: 'scene.setLayerText';
  readonly payload: { readonly layerId: MotionLayerId; readonly text: string };
}

export interface SetLayerFillsCommand {
  readonly type: 'scene.setLayerFills';
  readonly payload: { readonly layerId: MotionLayerId; readonly fills: readonly MotionFill[] };
}

export interface SetLayerStrokesCommand {
  readonly type: 'scene.setLayerStrokes';
  readonly payload: { readonly layerId: MotionLayerId; readonly strokes: readonly MotionStroke[] };
}

export interface SetLayerShadowsCommand {
  readonly type: 'scene.setLayerShadows';
  readonly payload: { readonly layerId: MotionLayerId; readonly shadows: readonly MotionShadow[] };
}

export interface SetLayerBorderRadiusCommand {
  readonly type: 'scene.setLayerBorderRadius';
  readonly payload: { readonly layerId: MotionLayerId; readonly borderRadius: readonly [number, number, number, number] };
}

export interface SetLayerVisibilityCommand {
  readonly type: 'scene.setLayerVisibility';
  readonly payload: { readonly layerId: MotionLayerId; readonly visible: boolean };
}

export interface SetLayerLockedCommand {
  readonly type: 'scene.setLayerLocked';
  readonly payload: { readonly layerId: MotionLayerId; readonly locked: boolean };
}

export interface SetSceneBackgroundCommand {
  readonly type: 'scene.setSceneBackground';
  readonly payload: { readonly background: SceneBackground };
}

export interface SetDocumentDimensionsCommand {
  readonly type: 'scene.setDocumentDimensions';
  readonly payload: { readonly width: number; readonly height: number };
}

export interface SetDocumentDurationCommand {
  readonly type: 'scene.setDocumentDuration';
  readonly payload: { readonly durationMs: number };
}

export type SceneCommand =
  | AddLayerCommand | RemoveLayerCommand | MoveLayerCommand
  | SetLayerTransformCommand | SetLayerPropertyCommand
  | SetLayerTypographyCommand | SetLayerTextCommand
  | SetLayerFillsCommand | SetLayerStrokesCommand | SetLayerShadowsCommand
  | SetLayerBorderRadiusCommand | SetLayerVisibilityCommand | SetLayerLockedCommand
  | SetSceneBackgroundCommand | SetDocumentDimensionsCommand | SetDocumentDurationCommand;

export interface SceneCommandResult {
  readonly document: MotionSceneDocument;
  readonly inverse: SceneCommand;
}

function updateLayer(
  layers: readonly MotionLayer[],
  layerId: MotionLayerId,
  updater: (layer: MotionLayer) => MotionLayer,
): readonly MotionLayer[] {
  return layers.map((l) => (l.id === layerId ? updater(l) : l));
}

function layerIndex(layers: readonly MotionLayer[], layerId: MotionLayerId): number {
  return layers.findIndex((l) => l.id === layerId);
}

export function applySceneCommand(
  document: MotionSceneDocument,
  command: SceneCommand,
): SceneCommandResult {
  switch (command.type) {
    case 'scene.addLayer': {
      const { layer, index } = command.payload;
      const layers = [...document.layers];
      const at = index ?? layers.length;
      layers.splice(at, 0, layer);
      return {
        document: { ...document, layers },
        inverse: { type: 'scene.removeLayer', payload: { layerId: layer.id } },
      };
    }
    case 'scene.removeLayer': {
      const { layerId } = command.payload;
      const idx = layerIndex(document.layers, layerId);
      if (idx === -1) return { document, inverse: command };
      const removed = document.layers[idx]!;
      const layers = document.layers.filter((l) => l.id !== layerId);
      return {
        document: { ...document, layers },
        inverse: { type: 'scene.addLayer', payload: { layer: removed, index: idx } },
      };
    }
    case 'scene.moveLayer': {
      const { layerId, newIndex } = command.payload;
      const oldIdx = layerIndex(document.layers, layerId);
      if (oldIdx === -1 || oldIdx === newIndex) return { document, inverse: command };
      const layers = [...document.layers];
      const [layer] = layers.splice(oldIdx, 1);
      if (!layer) return { document, inverse: command };
      layers.splice(newIndex, 0, layer);
      return {
        document: { ...document, layers },
        inverse: { type: 'scene.moveLayer', payload: { layerId, newIndex: oldIdx } },
      };
    }
    case 'scene.setLayerTransform': {
      const { layerId, transform } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldT = { ...old.transform };
      const next = { ...old.transform, ...transform };
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, transform: next })) },
        inverse: { type: 'scene.setLayerTransform', payload: { layerId, transform: oldT } },
      };
    }
    case 'scene.setLayerProperty': {
      const { layerId, property, value } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldVal = (old as unknown as Record<string, unknown>)[property];
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, [property]: value } as MotionLayer)) },
        inverse: { type: 'scene.setLayerProperty', payload: { layerId, property, value: oldVal } },
      };
    }
    case 'scene.setLayerTypography': {
      const { layerId, typography } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldTypo = old.typography;
      const next = { ...(old.typography ?? {}), ...typography } as MotionTypography;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, typography: next })) },
        inverse: { type: 'scene.setLayerTypography', payload: { layerId, typography: (oldTypo ?? {}) as Partial<MotionTypography> } },
      };
    }
    case 'scene.setLayerText': {
      const { layerId, text } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldText = old.text;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, text })) },
        inverse: { type: 'scene.setLayerText', payload: { layerId, text: oldText ?? '' } },
      };
    }
    case 'scene.setLayerFills': {
      const { layerId, fills } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldFills = old.fills;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, fills })) },
        inverse: { type: 'scene.setLayerFills', payload: { layerId, fills: oldFills } },
      };
    }
    case 'scene.setLayerStrokes': {
      const { layerId, strokes } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldStrokes = old.strokes;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, strokes })) },
        inverse: { type: 'scene.setLayerStrokes', payload: { layerId, strokes: oldStrokes } },
      };
    }
    case 'scene.setLayerShadows': {
      const { layerId, shadows } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldShadows = old.shadows;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, shadows })) },
        inverse: { type: 'scene.setLayerShadows', payload: { layerId, shadows: oldShadows } },
      };
    }
    case 'scene.setLayerBorderRadius': {
      const { layerId, borderRadius } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldR = old.borderRadius;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, borderRadius })) },
        inverse: { type: 'scene.setLayerBorderRadius', payload: { layerId, borderRadius: oldR } },
      };
    }
    case 'scene.setLayerVisibility': {
      const { layerId, visible } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldV = old.visible;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, visible })) },
        inverse: { type: 'scene.setLayerVisibility', payload: { layerId, visible: oldV } },
      };
    }
    case 'scene.setLayerLocked': {
      const { layerId, locked } = command.payload;
      const old = document.layers.find((l) => l.id === layerId);
      if (!old) return { document, inverse: command };
      const oldL = old.locked;
      return {
        document: { ...document, layers: updateLayer(document.layers, layerId, (l) => ({ ...l, locked })) },
        inverse: { type: 'scene.setLayerLocked', payload: { layerId, locked: oldL } },
      };
    }
    case 'scene.setSceneBackground': {
      const oldBg = document.background;
      return {
        document: { ...document, background: command.payload.background },
        inverse: { type: 'scene.setSceneBackground', payload: { background: oldBg } },
      };
    }
    case 'scene.setDocumentDimensions': {
      const { width, height } = command.payload;
      const oldW = document.width;
      const oldH = document.height;
      return {
        document: { ...document, width, height },
        inverse: { type: 'scene.setDocumentDimensions', payload: { width: oldW, height: oldH } },
      };
    }
    case 'scene.setDocumentDuration': {
      const { durationMs } = command.payload;
      const oldDuration = document.durationMs;
      return {
        document: { ...document, durationMs: Math.max(100, durationMs) },
        inverse: { type: 'scene.setDocumentDuration', payload: { durationMs: oldDuration } },
      };
    }
    default:
      return { document, inverse: command };
  }
}
