import type { MotionLayerType, BlendMode } from '@joy-media/motion-core';

export type CapabilitySection =
  | 'scene'
  | 'transform'
  | 'text'
  | 'typography'
  | 'fill'
  | 'stroke'
  | 'shadow'
  | 'cornerRadius'
  | 'blendMode'
  | 'filter'
  | 'mask'
  | 'crop'
  | 'visibility';

export type AnimatablePath =
  | 'transform.x'
  | 'transform.y'
  | 'transform.width'
  | 'transform.height'
  | 'transform.rotationDeg'
  | 'transform.rotationXDeg'
  | 'transform.rotationYDeg'
  | 'transform.scaleX'
  | 'transform.scaleY'
  | 'transform.opacity'
  | 'transform.skewX'
  | 'transform.skewY'
  | 'fill.opacity'
  | 'stroke.width'
  | 'shadow.opacity'
  | 'typography.fontSize'
  | 'typography.lineHeight'
  | 'typography.letterSpacing'
  | 'typography.wordSpacing'
  | 'typography.paragraphSpacing'
  | 'filter.value';

export interface LayerCapability {
  readonly sections: readonly CapabilitySection[];
  readonly animatable: readonly AnimatablePath[];
  readonly supportsMultiSelect: readonly CapabilitySection[];
}

const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

export const MOTION_BLEND_MODES = BLEND_MODES;

export function layerCapabilities(type: MotionLayerType): LayerCapability {
  switch (type) {
    case 'text':
      return {
        sections: ['transform', 'text', 'typography', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
          'fill.opacity',
          'stroke.width',
          'shadow.opacity',
          'typography.fontSize',
          'typography.lineHeight',
          'typography.letterSpacing',
          'typography.wordSpacing',
          'typography.paragraphSpacing',
        ],
        supportsMultiSelect: ['transform', 'text', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
      };
    case 'shape':
      return {
        sections: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
          'fill.opacity',
          'stroke.width',
          'shadow.opacity',
        ],
        supportsMultiSelect: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
      };
    case 'image':
    case 'video':
      return {
        sections: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter', 'crop'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
          'fill.opacity',
          'stroke.width',
          'shadow.opacity',
        ],
        supportsMultiSelect: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
      };
    case 'svg':
      return {
        sections: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
          'fill.opacity',
          'stroke.width',
          'shadow.opacity',
        ],
        supportsMultiSelect: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
      };
    case 'container':
    case 'group':
      return {
        sections: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
          'fill.opacity',
          'stroke.width',
          'shadow.opacity',
        ],
        supportsMultiSelect: ['transform', 'fill', 'stroke', 'shadow', 'cornerRadius', 'blendMode', 'filter'],
      };
    case 'component-instance':
      return {
        sections: ['transform', 'visibility', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.scaleX',
          'transform.scaleY',
          'transform.opacity',
        ],
        supportsMultiSelect: ['transform', 'blendMode', 'filter'],
      };
    case 'background':
      return {
        sections: ['fill', 'filter'],
        animatable: ['fill.opacity', 'filter.value'],
        supportsMultiSelect: ['fill', 'filter'],
      };
    case 'mask':
      return {
        sections: ['transform', 'mask'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
        ],
        supportsMultiSelect: ['transform'],
      };
    case 'html':
      return {
        sections: ['transform', 'blendMode', 'filter'],
        animatable: [
          'transform.x',
          'transform.y',
          'transform.width',
          'transform.height',
          'transform.rotationDeg',
          'transform.opacity',
        ],
        supportsMultiSelect: ['transform', 'blendMode', 'filter'],
      };
    default:
      return { sections: ['transform'], animatable: ['transform.x', 'transform.y', 'transform.opacity'], supportsMultiSelect: ['transform'] };
  }
}

export function commonCapabilities(types: readonly MotionLayerType[]): readonly CapabilitySection[] {
  if (types.length === 0) return [];
  const caps = types.map((t) => layerCapabilities(t).supportsMultiSelect);
  const first = caps[0]!;
  return first.filter((section) => caps.every((list) => list.includes(section)));
}

export function isAnimatable(type: MotionLayerType, path: AnimatablePath): boolean {
  return layerCapabilities(type).animatable.includes(path);
}
