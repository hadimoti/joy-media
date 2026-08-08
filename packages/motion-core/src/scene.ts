/**
 * MotionSceneDocument: the canonical, serialisable document for a motion scene
 * created in Motion Studio.  Every motion — original preset or user-created —
 * shares this model.  Layers carry CSS-like visual properties that are resolved
 * into DOM/CSS at render time (not stored as raw HTML).
 */

/* ─── Basic units ─── */

export type MotionLayerId = string;
export type MotionComponentId = string;
export type MotionVariableId = string;
export type TimeMs = number;

/* ─── Layer types ─── */

export type MotionLayerType =
  | 'text'
  | 'shape'
  | 'svg'
  | 'image'
  | 'video'
  | 'container'
  | 'group'
  | 'component-instance'
  | 'background'
  | 'mask'
  | 'html';

/* ─── Unit value ─── */

export interface UnitValue {
  readonly value: number;
  readonly unit: 'px' | '%' | 'vw' | 'vh' | 'em' | 'rem' | 'auto';
}

/* ─── Fill ─── */

export type GradientType = 'linear' | 'radial' | 'conic';

export interface GradientStop {
  readonly color: string;
  readonly opacity: number;
  readonly position: number;
}

export interface GradientFill {
  readonly type: GradientType;
  readonly stops: readonly GradientStop[];
  readonly angle?: number;
  readonly center?: { readonly x: number; readonly y: number };
  readonly radius?: number;
  readonly repeat?: boolean;
}

export type MotionFill =
  | { readonly kind: 'solid'; readonly color: string; readonly opacity: number }
  | { readonly kind: 'gradient'; readonly gradient: GradientFill; readonly opacity: number }
  | { readonly kind: 'image'; readonly assetId: string; readonly opacity: number }
  | { readonly kind: 'video'; readonly assetId: string; readonly opacity: number }
  | { readonly kind: 'transparent' };

/* ─── Stroke ─── */

export interface MotionStroke {
  readonly color: string;
  readonly width: number;
  readonly side?: 'all' | 'top' | 'right' | 'bottom' | 'left';
  readonly style?: 'solid' | 'dashed' | 'dotted';
  readonly dashArray?: readonly number[];
  readonly cap?: 'butt' | 'round' | 'square';
  readonly join?: 'miter' | 'round' | 'bevel';
}

/* ─── Shadow ─── */

export interface MotionShadow {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly color: string;
  readonly opacity: number;
  readonly inset: boolean;
}

/* ─── Filter ─── */

export type MotionFilter =
  | { readonly kind: 'blur'; readonly value: number }
  | { readonly kind: 'brightness'; readonly value: number }
  | { readonly kind: 'contrast'; readonly value: number }
  | { readonly kind: 'saturation'; readonly value: number }
  | { readonly kind: 'hueRotate'; readonly value: number }
  | { readonly kind: 'grayscale'; readonly value: number }
  | { readonly kind: 'sepia'; readonly value: number }
  | { readonly kind: 'invert'; readonly value: number }
  | { readonly kind: 'opacity'; readonly value: number }
  | { readonly kind: 'dropShadow'; readonly shadow: MotionShadow };

/* ─── Blend mode ─── */

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/* ─── Transform ─── */

export interface MotionTransform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDeg: number;
  readonly rotationXDeg: number;
  readonly rotationYDeg: number;
  readonly skewX: number;
  readonly skewY: number;
  readonly transformOriginX: string;
  readonly transformOriginY: string;
  readonly perspective: number;
  readonly opacity: number;
}

export const DEFAULT_TRANSFORM: MotionTransform = {
  x: 0,
  y: 0,
  z: 0,
  width: 0,
  height: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  rotationXDeg: 0,
  rotationYDeg: 0,
  skewX: 0,
  skewY: 0,
  transformOriginX: '50%',
  transformOriginY: '50%',
  perspective: 0,
  opacity: 1,
};

/* ─── Layout ─── */

export type FlexDirection = 'row' | 'column';
export type FlexWrap = 'nowrap' | 'wrap';
export type FlexAlign = 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
export type FlexJustify =
  'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';

export interface FlexLayout {
  readonly direction: FlexDirection;
  readonly wrap: FlexWrap;
  readonly gap: number;
  readonly align: FlexAlign;
  readonly justify: FlexJustify;
  readonly padding: number;
}

export interface GridLayout {
  readonly rows: number;
  readonly columns: number;
  readonly gap: number;
  readonly autoFlow: 'row' | 'column';
}

export type LayoutMode = 'free' | 'flex' | 'grid';

/* ─── Mask ─── */

export type MaskType = 'rectangle' | 'ellipse' | 'path' | 'text' | 'image-alpha';

export interface MotionMask {
  readonly type: MaskType;
  readonly inverted: boolean;
  readonly feather: number;
  readonly path?: string;
}

/* ─── Typography ─── */

export interface MotionTypography {
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic';
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly wordSpacing: number;
  readonly textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  readonly textAlign: 'left' | 'center' | 'right' | 'justify';
  readonly verticalAlign: 'top' | 'middle' | 'bottom';
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly wrap: boolean;
  readonly maxLines?: number;
  readonly ellipsis?: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly indent: number;
  readonly paragraphSpacing: number;
}

export const DEFAULT_TYPOGRAPHY: MotionTypography = {
  fontFamily: 'system-ui',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSize: 48,
  lineHeight: 1.2,
  letterSpacing: 0,
  wordSpacing: 0,
  textTransform: 'none',
  textAlign: 'center',
  verticalAlign: 'middle',
  direction: 'auto',
  wrap: true,
  underline: false,
  strikethrough: false,
  indent: 0,
  paragraphSpacing: 0,
};

/* ─── Easing ─── */

export type MotionEasingName =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'cubic'
  | 'quart'
  | 'quint'
  | 'expo'
  | 'back'
  | 'bounce'
  | 'elastic'
  | 'steps'
  | 'spring';

export interface CubicBezierEasing {
  readonly kind: 'cubic-bezier';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export type MotionEasing =
  { readonly kind: 'builtin'; readonly name: MotionEasingName } | CubicBezierEasing;

/* ─── Keyframe ─── */

export interface MotionKeyframe {
  readonly id: string;
  readonly timeMs: TimeMs;
  readonly value: number;
  readonly easing: MotionEasing;
  readonly hold?: boolean;
}

export interface MotionKeyframeCurve {
  readonly keyframes: readonly MotionKeyframe[];
}

/* ─── Animation ─── */

export type AnimatableMotionProperty = string;

export interface MotionAnimation {
  readonly property: AnimatableMotionProperty;
  readonly curve: MotionKeyframeCurve;
}

/* ─── Layer ─── */

export interface MotionLayer {
  readonly id: MotionLayerId;
  readonly type: MotionLayerType;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly transform: MotionTransform;
  readonly fills: readonly MotionFill[];
  readonly strokes: readonly MotionStroke[];
  readonly shadows: readonly MotionShadow[];
  readonly filters: readonly MotionFilter[];
  readonly backdropFilter?: readonly MotionFilter[];
  readonly blendMode: BlendMode;
  readonly borderRadius: readonly [number, number, number, number];
  readonly mask?: MotionMask;
  readonly overflow: 'visible' | 'hidden';
  readonly layout: {
    readonly mode: LayoutMode;
    readonly flex?: FlexLayout;
    readonly grid?: GridLayout;
  };
  readonly typography?: MotionTypography;
  readonly text?: string;
  readonly assetId?: string;
  readonly svgContent?: string;
  readonly children: readonly MotionLayerId[];
  readonly parentId?: MotionLayerId;
  readonly animations: readonly MotionAnimation[];
  readonly inTimeMs?: TimeMs;
  readonly outTimeMs?: TimeMs;
  readonly componentId?: MotionComponentId;
}

/* ─── Scene background ─── */

export interface SceneBackground {
  readonly kind:
    | 'transparent'
    | 'solid'
    | 'gradient'
    | 'image'
    | 'video'
    | 'animated-gradient'
    | 'noise'
    | 'particles';
  readonly color?: string;
  readonly gradient?: GradientFill;
  readonly assetId?: string;
  readonly intensity?: number;
  readonly scale?: number;
  readonly speed?: number;
  readonly seed?: number;
  readonly blend?: BlendMode;
  readonly opacity?: number;
}

/* ─── Variable ─── */

export type MotionVariableType =
  | 'color'
  | 'number'
  | 'string'
  | 'boolean'
  | 'font'
  | 'duration'
  | 'easing'
  | 'gradient'
  | 'shadow'
  | 'spacing';

export interface MotionVariable {
  readonly id: MotionVariableId;
  readonly name: string;
  readonly type: MotionVariableType;
  readonly defaultValue: string | number | boolean;
  readonly description?: string;
}

/* ─── Component ─── */

export interface ComponentProperty {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'color' | 'font' | 'image' | 'duration' | 'boolean' | 'number' | 'select';
  readonly defaultValue: string | number | boolean;
  readonly options?: readonly string[];
}

export interface MotionComponentVariant {
  readonly id: string;
  readonly name: string;
  readonly overrides: Record<string, unknown>;
}

export interface MotionComponent {
  readonly id: MotionComponentId;
  readonly name: string;
  readonly layerIds: readonly MotionLayerId[];
  readonly properties: readonly ComponentProperty[];
  readonly variants: readonly MotionComponentVariant[];
}

/* ─── Marker ─── */

export interface MotionMarker {
  readonly id: string;
  readonly timeMs: TimeMs;
  readonly label: string;
  readonly color?: string;
}

/* ─── Custom code ─── */

export interface SandboxedCodeBundle {
  readonly html?: string;
  readonly css?: string;
  readonly js?: string;
}

/* ─── Scene document ─── */

export interface MotionSceneDocument {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: TimeMs;
  readonly frameRate: number;
  readonly background: SceneBackground;
  readonly layers: readonly MotionLayer[];
  readonly variables: readonly MotionVariable[];
  readonly components: readonly MotionComponent[];
  readonly markers: readonly MotionMarker[];
  readonly customCode?: SandboxedCodeBundle;
}

export const CURRENT_SCENE_SCHEMA_VERSION = 1;

export function createBlankScene(name: string, width = 1080, height = 1920): MotionSceneDocument {
  return {
    schemaVersion: CURRENT_SCENE_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name,
    width,
    height,
    durationMs: 3000,
    frameRate: 30,
    background: { kind: 'transparent' },
    layers: [],
    variables: [],
    components: [],
    markers: [],
  };
}
