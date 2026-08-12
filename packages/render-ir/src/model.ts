/**
 * Versioned, evaluated render intermediate representation.
 *
 * This is deliberately ephemeral and renderer-neutral: it carries evaluated
 * pixels/geometry for one frame, never project-model objects or renderer
 * instances. Editor-only overlays travel on a separate contract and cannot
 * accidentally be rendered by export adapters.
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Already-evaluated affine subset used by this spike. */
export interface Transform2D {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

interface RenderNodeBase {
  readonly id: string;
  /** Higher values render later (on top). */
  readonly zIndex: number;
  readonly opacity: number;
  readonly transform: Transform2D;
}

/** A resolved still-image surface. The source URI/decoder is intentionally absent. */
export interface SpriteNode extends RenderNodeBase {
  readonly kind: 'sprite';
  readonly width: number;
  readonly height: number;
  readonly color: Rgba;
  readonly effects?: readonly EffectInstanceIR[];
}

/** A resolved video frame. Decoding has happened before this boundary. */
export interface VideoFrameNode extends RenderNodeBase {
  readonly kind: 'video-frame';
  readonly width: number;
  readonly height: number;
  readonly sourceTimeUs: number;
  readonly color: Rgba;
  readonly effects?: readonly EffectInstanceIR[];
}

/** An inline styled run inside a TextNode (karaoke/keyword emphasis). */
export interface TextSpan {
  readonly text: string;
  readonly color: Rgba;
  /** Marks the emphasized (e.g. active-word) run for renderers with effects. */
  readonly emphasis?: boolean;
}

/** A text run rendered with the spike's pinned bitmap glyph set. */
export interface TextNode extends RenderNodeBase {
  readonly kind: 'text';
  readonly text: string;
  readonly color: Rgba;
  /** Resolved base direction; renderers must not re-detect it. Default 'ltr'. */
  readonly direction?: 'ltr' | 'rtl';
  /** How the rendered run anchors to transform.translate. Default 'left'. */
  readonly align?: 'left' | 'center' | 'right';
  /** Layout constraint in viewport pixels; renderers wrap/shrink within it. */
  readonly maxWidth?: number;
  /** Evaluated glyph size in viewport pixels; renderer default when absent. */
  readonly fontSizePx?: number;
  /** Box drawn behind the run (caption plates). Absent = no box. */
  readonly background?: Rgba;
  /** Styled runs; when present their concatenated text MUST equal `text`. */
  readonly spans?: readonly TextSpan[];
  readonly effects?: readonly EffectInstanceIR[];
}

/** A transform/opacity container. Its children remain evaluated visual nodes. */
export interface GroupNode extends RenderNodeBase {
  readonly kind: 'group';
  readonly children: readonly RenderNode[];
}

/** A transition between two clips (registry id + progress). */
export interface TransitionNode extends RenderNodeBase {
  readonly kind: 'transition';
  readonly width: number;
  readonly height: number;
  readonly color: Rgba;
  /** Registry id (`dissolve` / `wipe` / `slide` / `gl:…`). */
  readonly transitionType: string;
  /** Resolved shader id for adapters (usually same as transitionType). */
  readonly shaderId: string;
  readonly progress: number; // 0 to 1
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** Per-object effect instance carried on visual nodes for GPU/CPU adapters. */
export type EffectKindIR = string;

export interface EffectInstanceIR {
  readonly id: string;
  readonly kind: EffectKindIR;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, number>>;
}

/** Alias kept for call sites / docs that say EffectNode. */
export type EffectNode = EffectInstanceIR;

/** Adapter-neutral evaluated effect representation for Render IR. */
export interface EffectRenderSpec {
  readonly instanceId: string;
  readonly effectId: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Master color grade applied once per frame (DaVinci-style lift/gamma/gain). */
export interface ColorGradeIR {
  readonly version?: 2;
  readonly enabled?: boolean;
  readonly lift: number;
  readonly gamma: number;
  readonly gain: number;
  readonly saturation: number;
  readonly lutId?: 'none' | 'rec709' | 'contrast';
  readonly adjust?: {
    readonly temperature?: number;
    readonly tint?: number;
    readonly exposure?: number;
    readonly contrast?: number;
    readonly pivot?: number;
    readonly highlights?: number;
    readonly shadows?: number;
    readonly whites?: number;
    readonly blacks?: number;
    readonly saturation?: number;
    readonly vibrance?: number;
    readonly hue?: number;
  };
  readonly wheels?: Readonly<
    Record<
      'lift' | 'gamma' | 'gain' | 'offset',
      {
        readonly r: number;
        readonly g: number;
        readonly b: number;
        readonly master: number;
      }
    >
  >;
  readonly curves?: Readonly<
    Record<'rgb' | 'red' | 'green' | 'blue', readonly { readonly x: number; readonly y: number }[]>
  >;
  readonly hsl?: readonly {
    readonly hue: number;
    readonly hueWidth: number;
    readonly softness: number;
    readonly saturation: number;
    readonly luminance: number;
  }[];
  readonly lut?: {
    readonly assetId?: string;
    readonly sha256?: string;
    readonly builtIn?: string;
    readonly intensity: number;
  };
  readonly outputSafety?: { readonly softClip: number; readonly legalRange: boolean };
}

/** Alias kept for call sites / docs that say GradeNode. */
export type GradeNode = ColorGradeIR;

export type RenderNode = SpriteNode | VideoFrameNode | TextNode | GroupNode | TransitionNode;
export type VisualRenderNode = Exclude<RenderNode, GroupNode>;

export interface RenderFrameIR {
  readonly version: 1;
  readonly compositionId: string;
  readonly timeUs: number;
  readonly viewport: Viewport;
  readonly background: Rgba;
  readonly nodes: readonly RenderNode[];
  /** Optional master color grade for the frame. */
  readonly colorGrade?: ColorGradeIR;
}

/** Editor-only affordances; deliberately excluded from RenderFrameIR/export. */
export interface EditorOverlayIR {
  readonly version: 1;
  readonly selections: readonly {
    readonly nodeId: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Fails fast at the execution boundary rather than allowing a renderer-specific crash. */
export function validateRenderFrameIR(frame: RenderFrameIR): void {
  if (frame.version !== 1)
    throw new RangeError(`unsupported RenderFrameIR version ${frame.version}`);
  if (!Number.isSafeInteger(frame.timeUs) || frame.timeUs < 0) {
    throw new RangeError(`timeUs must be a non-negative safe integer, got ${frame.timeUs}`);
  }
  if (
    !Number.isSafeInteger(frame.viewport.width) ||
    !Number.isSafeInteger(frame.viewport.height) ||
    frame.viewport.width <= 0 ||
    frame.viewport.height <= 0 ||
    !Number.isFinite(frame.viewport.dpr) ||
    frame.viewport.dpr <= 0
  ) {
    throw new RangeError('viewport must have positive finite dimensions and dpr');
  }
  validateNodes(frame.nodes, new Set<string>());
  assertRgba(frame.background, 'background');
}

/** Resolves group transforms and opacity into adapter-ready, draw-ordered visual nodes. */
export function flattenRenderNodes(nodes: readonly RenderNode[]): readonly VisualRenderNode[] {
  return nodes.flatMap((node) => flattenNode(node, IDENTITY_TRANSFORM, 1));
}

function validateNodes(nodes: readonly RenderNode[], ids: Set<string>): void {
  for (const node of nodes) {
    if (node.id.length === 0 || ids.has(node.id)) {
      throw new RangeError(`render node ids must be non-empty and unique; got "${node.id}"`);
    }
    ids.add(node.id);
    if (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1) {
      throw new RangeError(`node "${node.id}" opacity must be in [0, 1]`);
    }
    if (
      !Number.isFinite(node.transform.translateX) ||
      !Number.isFinite(node.transform.translateY) ||
      !Number.isFinite(node.transform.scaleX) ||
      !Number.isFinite(node.transform.scaleY) ||
      node.transform.scaleX <= 0 ||
      node.transform.scaleY <= 0
    ) {
      throw new RangeError(`node "${node.id}" transform must be finite with positive scales`);
    }
    if (node.kind === 'sprite' || node.kind === 'video-frame') {
      if (
        !Number.isFinite(node.width) ||
        !Number.isFinite(node.height) ||
        node.width <= 0 ||
        node.height <= 0
      ) {
        throw new RangeError(`node "${node.id}" dimensions must be positive`);
      }
    }
    if (node.kind === 'text') {
      if (node.direction !== undefined && node.direction !== 'ltr' && node.direction !== 'rtl') {
        throw new RangeError(`node "${node.id}" direction must be ltr or rtl`);
      }
      if (
        node.align !== undefined &&
        node.align !== 'left' &&
        node.align !== 'center' &&
        node.align !== 'right'
      ) {
        throw new RangeError(`node "${node.id}" align must be left, center, or right`);
      }
      if (node.maxWidth !== undefined && (!Number.isFinite(node.maxWidth) || node.maxWidth <= 0)) {
        throw new RangeError(`node "${node.id}" maxWidth must be positive`);
      }
      if (
        node.fontSizePx !== undefined &&
        (!Number.isFinite(node.fontSizePx) || node.fontSizePx <= 0)
      ) {
        throw new RangeError(`node "${node.id}" fontSizePx must be positive`);
      }
      if (node.background !== undefined)
        assertRgba(node.background, `node "${node.id}" background`);
      if (node.spans !== undefined) {
        const joined = node.spans.map((span) => span.text).join('');
        if (joined !== node.text) {
          throw new RangeError(`node "${node.id}" spans must concatenate to its text`);
        }
        for (const span of node.spans) assertRgba(span.color, `node "${node.id}" span color`);
      }
    }
    if (node.kind === 'group') {
      validateNodes(node.children, ids);
    } else if (node.kind !== 'transition') {
      assertRgba(node.color, `node "${node.id}" color`);
    }
  }
}

const IDENTITY_TRANSFORM: Transform2D = {
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
};

function flattenNode(
  node: RenderNode,
  parentTransform: Transform2D,
  parentOpacity: number,
): readonly VisualRenderNode[] {
  const transform = composeTransform(parentTransform, node.transform);
  const opacity = parentOpacity * node.opacity;
  if (node.kind === 'group') {
    return node.children.flatMap((child) => flattenNode(child, transform, opacity));
  }
  return [{ ...node, transform, opacity }];
}

function composeTransform(parent: Transform2D, child: Transform2D): Transform2D {
  return {
    translateX: parent.translateX + child.translateX * parent.scaleX,
    translateY: parent.translateY + child.translateY * parent.scaleY,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
  };
}

function assertRgba(color: Rgba, label: string): void {
  for (const [channel, value] of Object.entries(color)) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new RangeError(`${label}.${channel} must be an integer in [0, 255]`);
    }
  }
}
