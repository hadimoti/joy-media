import type { MotionLayer, MotionLayerType } from '@joy-media/motion-core';
import { DEFAULT_TRANSFORM, DEFAULT_TYPOGRAPHY } from '@joy-media/motion-core';

let counter = 0;

function nextId(): string {
  counter += 1;
  return `layer-${Date.now()}-${counter}`;
}

function base(type: MotionLayerType, name: string): MotionLayer {
  return {
    id: nextId(), type, name, visible: true, locked: false,
    transform: { ...DEFAULT_TRANSFORM },
    fills: [], strokes: [], shadows: [], filters: [],
    blendMode: 'normal', borderRadius: [0, 0, 0, 0] as const,
    overflow: 'visible' as const,
    layout: { mode: 'free' as const },
    children: [], animations: [],
  };
}

export function createTextLayer(text: string, x = 100, y = 100, w = 400, h = 100): MotionLayer {
  return {
    ...base('text', `Text "${text.slice(0, 12)}"`),
    text,
    typography: { ...DEFAULT_TYPOGRAPHY },
    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
    fills: [{ kind: 'solid', color: '#ffffff', opacity: 1 }],
  };
}

export function createRectangleLayer(x = 100, y = 100, w = 200, h = 150): MotionLayer {
  return {
    ...base('shape', 'Rectangle'),
    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
    fills: [{ kind: 'solid', color: '#f4b72f', opacity: 1 }],
    strokes: [{ color: '#ffffff', width: 2 }],
  };
}

export function createEllipseLayer(x = 100, y = 100, w = 200, h = 200): MotionLayer {
  return {
    ...base('shape', 'Ellipse'),
    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
    fills: [{ kind: 'solid', color: '#6fcf97', opacity: 1 }],
    borderRadius: [9999, 9999, 9999, 9999] as const,
  };
}

export function createImageLayer(assetId: string, name = 'Image', x = 100, y = 100, w = 300, h = 300): MotionLayer {
  return {
    ...base('image', name),
    assetId,
    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
  };
}

export function createContainerLayer(name = 'Container', x = 50, y = 50, w = 400, h = 300): MotionLayer {
  return {
    ...base('container', name),
    transform: { ...DEFAULT_TRANSFORM, x, y, width: w, height: h },
  };
}
