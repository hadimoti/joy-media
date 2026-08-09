import type { MotionLayer, MotionSceneDocument } from '@joy-media/motion-core';
import type { TimelineCanvasIcon, TimelineCanvasTrack } from '../TimelineCanvas.js';

function layerIcon(type: MotionLayer['type']): TimelineCanvasIcon {
  switch (type) {
    case 'text':
      return 'text';
    case 'video':
      return 'video';
    case 'image':
      return 'generation';
    case 'svg':
    case 'shape':
    case 'container':
    case 'group':
    default:
      return 'generic';
  }
}

function layerCode(type: MotionLayer['type'], index: number): string {
  const prefix =
    type === 'text'
      ? 'T'
      : type === 'video'
        ? 'V'
        : type === 'image'
          ? 'I'
          : type === 'shape' || type === 'svg'
            ? 'S'
            : 'L';
  return `${prefix}${index + 1}`;
}

/**
 * Map Motion Studio layers → TimelineCanvas tracks (ms → µs).
 * One layer = one lane spanning inTime…outTime (defaults to full scene duration).
 */
export function motionSceneToTimelineTracks(
  document: MotionSceneDocument,
  handlers: {
    readonly onToggleVisibility: (layerId: string) => void;
    readonly onToggleLocked: (layerId: string) => void;
  },
): readonly TimelineCanvasTrack[] {
  const durationMs = Math.max(1, document.durationMs);
  // Paint order: top of layers list = top of stack → reverse so top layer is top lane.
  const layers = [...document.layers].reverse();

  return layers.map((layer, index) => {
    const startMs = layer.inTimeMs ?? 0;
    const endMs = layer.outTimeMs ?? durationMs;
    const icon = layerIcon(layer.type);
    const code = layerCode(layer.type, index);

    return {
      id: layer.id,
      label: layer.name,
      header: {
        kind: icon,
        code,
        name: layer.name,
      },
      controls: {
        trackId: layer.id,
        locked: layer.locked,
        visible: layer.visible,
        solo: false,
        onToggle: (flag) => {
          if (flag === 'locked') handlers.onToggleLocked(layer.id);
          if (flag === 'visible') handlers.onToggleVisibility(layer.id);
        },
      },
      items: [
        {
          id: layer.id,
          clipId: layer.id,
          label: layer.name,
          startUs: Math.max(0, startMs) * 1000,
          endUs: Math.max(startMs + 1, endMs) * 1000,
          icon,
        },
      ],
    };
  });
}

export function motionSceneDurationUs(document: MotionSceneDocument): number {
  return Math.max(1, document.durationMs) * 1000;
}
