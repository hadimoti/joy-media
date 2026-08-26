import type {
  ColorGradeV1,
  EffectInstanceV1,
  ExportPresetId,
  JoyProjectV1,
  SpikeProject,
} from '@joy-media/project-schema';
import {
  DEFAULT_CAPTION_TEMPLATE_ID,
  JOY_CAPTION_TEMPLATES,
  resolveCaptionDirection,
  segmentDisplayText,
} from '@joy-media/captions-core';
import type { CompositionV1 } from '@joy-media/project-schema';
import type { MotionSceneDocument } from '../../motion-core/src/scene.js';
import type { TransitionV1 } from '@joy-media/project-schema';

/** A content-addressed, Worker-local media binding. Paths and URLs are never wire values. */
export interface AssetBindingV2 {
  readonly assetId: string;
  readonly opaqueRef: string;
  readonly integrity?: {
    readonly sha256: string;
    readonly bytes: number;
    readonly mime: string;
  };
  readonly sha256?: string;
  readonly bytes?: number;
  readonly mimeType?: string;
  /** Published first-party scene identity, immutable across export retries. */
  readonly htmlScene?: { readonly packageId: string; readonly sourceSha256: string };
  /** Immutable published Motion Studio document and its Worker-local layer media bindings. */
  readonly motionScene?: {
    readonly snapshot: MotionSceneDocument;
    readonly snapshotSha256: string;
    readonly layers: Readonly<
      Record<
        string,
        {
          readonly opaqueRef: string;
          readonly integrity: {
            readonly sha256: string;
            readonly bytes: number;
            readonly mime: string;
          };
        }
      >
    >;
  };
  /** Verified text surface: pixels are rasterized by the Worker-local publisher. */
  readonly textBitmap?: {
    readonly sourceSha256: string;
    readonly width: number;
    readonly height: number;
    readonly fontId: string;
  };
}

export interface CompositionV2 {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface ViewportV2 {
  readonly width: number;
  readonly height: number;
}

export interface FrameRateV2 {
  readonly num: number;
  readonly den: number;
}

export interface LayerTransformV2 {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** Static rotation in degrees; omitted means 0 for backwards-compatible plans. */
  readonly rotationDeg?: number;
  readonly opacity: number;
  /** Fractional source-image insets; supported only on static image layers. */
  readonly crop?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export interface VideoLayerV2 extends LayerTransformV2 {
  readonly id: string;
  readonly kind: 'video';
  /** Timeline track identity, retained for junction validation. */
  readonly trackId?: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  readonly playbackRate: number;
  readonly zIndex: number;
}

export interface ImageLayerV2 extends LayerTransformV2 {
  readonly id: string;
  readonly kind: 'image';
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly zIndex: number;
  /** The sole per-layer V2 effect currently source-backed: static image brightness/contrast. */
  readonly effects?: readonly EffectInstanceV1[];
}

export interface HtmlSceneLayerV2 extends LayerTransformV2 {
  readonly id: string;
  readonly kind: 'html-scene';
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly zIndex: number;
}

export interface TextLayerV2 extends LayerTransformV2 {
  readonly id: string;
  readonly kind: 'text';
  readonly text: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly zIndex: number;
  /** Asset containing the already-shaped RGBA title bitmap. */
  readonly bitmapAssetId?: string;
  /** Curated pinned-font identity used by the publisher (never discovered by host). */
  readonly fontId?: string;
  readonly sourceSha256?: string;
}

export interface MotionSceneLayerV2 extends LayerTransformV2 {
  readonly id: string;
  readonly kind: 'motion-scene';
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly zIndex: number;
}
export type CompositionLayerV2 =
  VideoLayerV2 | ImageLayerV2 | HtmlSceneLayerV2 | MotionSceneLayerV2 | TextLayerV2;

/** The only clip-junction transition admitted by verified V2 delivery. */
export interface TransitionV2 {
  readonly id: string;
  readonly trackId: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly type: 'dissolve';
  readonly durationUs: number;
  /** Exact active interval: [rightClip.startUs - durationUs, rightClip.startUs). */
  readonly startUs: number;
  readonly endUs: number;
  readonly transitionSha256: string;
}

export interface AudioLayerV2 {
  readonly id: string;
  /** Native audio from a video source or a separate file-backed audio asset. */
  readonly sourceKind?: 'video-native' | 'audio-asset';
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
  /** Playback rate inherited from a video clip's native audio. */
  readonly playbackRate?: number;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
  /** Optional semantic label (for example dialogue, music, or VO). */
  readonly role?: string;
  /** Normalized bus destination. Omitted means the master bus. */
  readonly busId?: string;
}

export interface AudioBusV2 {
  readonly id: string;
  readonly name: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly inputs?: readonly string[];
}

/** One deliberately bounded post-mix processor. It runs on the master bus only. */
export interface MasterLimiterV2 {
  readonly ceilingDb: number;
  readonly releaseUs: number;
}

/** The only caption styles that may cross the verified-delivery boundary. */
export type BuiltinCaptionStyleRefV2 = (typeof JOY_CAPTION_TEMPLATES)[number]['id'];

/** A resolved caption segment; source words, providers, and animation are absent by design. */
export interface CaptionSegmentV2 {
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly text: string;
  readonly direction: 'ltr' | 'rtl';
}

/** Signed, renderer-valid caption intent carried by a V2 plan. */
export interface CaptionBurnInV2 {
  readonly intent: 'burn-in';
  readonly styleRef: BuiltinCaptionStyleRefV2;
  readonly segments: readonly CaptionSegmentV2[];
  readonly payloadSha256: string;
}

/** Normalized render intent. It deliberately contains no mutable project document. */
export interface CompositionPlanV2 {
  readonly version: 2;
  readonly composition: CompositionV2;
  readonly viewport: ViewportV2;
  readonly frameRate: FrameRateV2;
  readonly durationUs: number;
  readonly background: string;
  /** Optional normalized master grade applied once to final delivery pixels. */
  readonly colorGrade?: ColorGradeV1;
  readonly layers: readonly CompositionLayerV2[];
  readonly transitions?: readonly TransitionV2[];
  readonly audio: readonly AudioLayerV2[];
  /** Optional narrow bus graph: master and at most one music bus. */
  readonly audioBuses?: readonly AudioBusV2[];
  readonly masterLimiter?: MasterLimiterV2;
  readonly captionBurnIn?: CaptionBurnInV2;
  readonly outputPreset: ExportPresetId | 'preview';
  readonly planSha256: string;
}

export interface RenderBundleSnapshotV2 {
  readonly projectRef: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly planSha256: string;
  readonly bundleSha256: string;
}

export interface RenderBundleV2 {
  readonly version: 2;
  readonly plan: CompositionPlanV2;
  readonly assets: Readonly<Record<string, AssetBindingV2>>;
  readonly snapshot: RenderBundleSnapshotV2;
}

export interface CreateCompositionPlanV2Input {
  readonly timelineProject: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly compositionId?: string;
  readonly viewport?: ViewportV2;
  readonly outputPreset?: ExportPresetId | 'preview';
  readonly motionScenes?: Readonly<Record<string, MotionSceneDocument>>;
}

export interface CreateRenderBundleV2Input {
  readonly plan: CompositionPlanV2;
  readonly assets: Readonly<Record<string, AssetBindingV2>>;
  readonly projectRef: string;
  readonly revision?: number;
  readonly createdAt?: string;
}

const HASH = /^[a-f0-9]{64}$/;
/** Font identities accepted by the static title publisher. */
export const V2_PINNED_TEXT_FONT_IDS = ['falsafeh-light', 'modam-pro', 'system-ui'] as const;
const PINNED_TEXT_FONTS = new Set<string>(V2_PINNED_TEXT_FONT_IDS);

/** RFC-8785-style sorted-key JSON for the JSON subset used by render contracts. */
export function canonicalJsonV2(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are not canonicalizable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV2).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonV2(item)}`).join(',')}}`;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

/** Dependency-free SHA-256 over UTF-8 text; usable by the browser editor and Node Worker. */
export function sha256HexV2(text: string): string {
  const data = new TextEncoder().encode(text);
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = data.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (v: number, n: number) => ((v >>> n) | (v << (32 - n))) >>> 0;
  const w = new Array<number>(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] =
        (w[i - 16]! +
          (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          w[i - 7]! +
          (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let x = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (x + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [x, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + x) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function planDigestV2(
  plan: Omit<CompositionPlanV2, 'planSha256'> | CompositionPlanV2,
): string {
  return sha256HexV2(canonicalJsonV2(canonicalPlanForDigest(plan)));
}

export function bundleDigestV2(bundle: Omit<RenderBundleV2, 'snapshot'> | RenderBundleV2): string {
  const value = bundle as RenderBundleV2;
  const assets = Object.fromEntries(
    Object.entries(value.assets).map(([id, asset]) => [id, normalizedAssetBindingV2(asset)]),
  );
  const content = {
    version: value.version,
    plan: canonicalPlanForDigest(value.plan),
    assets,
    // createdAt is audit metadata, not content identity.
    ...(value.snapshot === undefined
      ? {}
      : {
          snapshot: {
            projectRef: value.snapshot.projectRef,
            revision: value.snapshot.revision,
            planSha256: value.snapshot.planSha256,
          },
        }),
  };
  return sha256HexV2(canonicalJsonV2(content));
}

export function createCompositionPlanV2(input: CreateCompositionPlanV2Input): CompositionPlanV2 {
  const visual =
    input.visualProject.compositions[input.compositionId ?? input.visualProject.rootCompositionId];
  const timeline = input.timelineProject.compositions[input.timelineProject.rootCompositionId];
  if (visual === undefined || timeline === undefined)
    throw new Error('render plan requires a root composition');
  const layers: CompositionLayerV2[] = [];
  for (const track of timeline.tracks
    .filter((item) => item.enabled)
    .sort((a, b) => a.order - b.order)) {
    for (const clip of track.clips) {
      if (clip.kind === 'video')
        layers.push({
          id: clip.id,
          kind: 'video',
          assetId: clip.assetId,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          sourceInUs: clip.sourceInUs,
          playbackRate: clip.playbackRate ?? 1,
          zIndex: track.order,
          trackId: track.id,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        });
    }
  }
  for (const object of Object.values(input.visualProject.visualObjects)) {
    if (
      object.kind !== 'image' &&
      object.kind !== 'text' &&
      object.kind !== 'html-scene' &&
      object.kind !== 'motion-scene'
    )
      throw new Error(`Unsupported layer class "${object.kind}" for verified delivery.`);
    if (object.transform.positionZ !== undefined && object.transform.positionZ !== 0)
      throw new Error(`Depth positionZ is not supported for verified delivery (${object.id}).`);
    const crop = object.transform.crop;
    const hasCrop = crop.left !== 0 || crop.top !== 0 || crop.right !== 0 || crop.bottom !== 0;
    if (hasCrop && object.kind !== 'image')
      throw new Error(`Crop is not supported for ${object.kind} layer ${object.id}.`);
    if (object.kind === 'image') validateImageCropV2(crop, object.id);
    const imageEffects =
      object.kind === 'image'
        ? normalizeStaticImageEffectsV2(object.effects, object.id)
        : undefined;
    if (object.kind !== 'image' && object.effects !== undefined && object.effects.length > 0)
      throw new Error('Effects are only supported for static image layers in verified delivery.');
    if (
      object.animations !== undefined ||
      object.expressions !== undefined ||
      object.spatialPath !== undefined ||
      object.motionBlur !== undefined
    )
      throw new Error(
        `Animated visual layer "${object.id}" is not supported for verified delivery.`,
      );
    const base = {
      id: object.id,
      startUs: 0,
      durationUs: visual.durationUs,
      zIndex: 1000,
      x: object.transform.x,
      y: object.transform.y,
      scaleX: object.transform.scaleX,
      scaleY: object.transform.scaleY,
      rotationDeg: object.transform.rotationDeg,
      opacity: object.transform.opacity,
    };
    if (
      (object.kind === 'image' || object.kind === 'html-scene') &&
      object.assetId === undefined &&
      object.kind === 'image'
    )
      throw new Error(`Image layer "${object.id}" is missing an asset for verified delivery.`);
    if (object.kind === 'image' && object.assetId !== undefined)
      layers.push({
        ...base,
        kind: 'image',
        assetId: object.assetId,
        ...(hasCrop ? { crop } : {}),
        ...(imageEffects === undefined ? {} : { effects: imageEffects }),
      });
    if (object.kind === 'html-scene' && object.scenePackageId !== undefined)
      layers.push({ ...base, kind: 'html-scene', assetId: `html-scene:${object.scenePackageId}` });
    if (object.kind === 'html-scene' && object.scenePackageId === undefined)
      throw new Error(`HTML scene layer "${object.id}" is missing a published scene package.`);
    if (object.kind === 'motion-scene') {
      if (object.motionSceneId === undefined)
        throw new Error(`Motion scene layer "${object.id}" is missing a published scene.`);
      if (input.motionScenes?.[object.motionSceneId] === undefined)
        throw new Error(
          `Motion scene layer "${object.id}" is missing a canonical published snapshot.`,
        );
      layers.push({
        ...base,
        kind: 'motion-scene',
        assetId: `motion-scene:${object.motionSceneId}`,
      });
    }
    if (object.kind === 'text') {
      const text = object as typeof object & {
        readonly bitmapAssetId?: unknown;
        readonly fontId?: unknown;
        readonly sourceSha256?: unknown;
      };
      if (
        typeof text.bitmapAssetId !== 'string' ||
        typeof text.fontId !== 'string' ||
        typeof text.sourceSha256 !== 'string'
      )
        throw new Error(
          `Text layer "${object.id}" requires a published pre-rasterized bitmap binding.`,
        );
      layers.push({
        ...base,
        kind: 'text',
        text: object.text ?? '',
        bitmapAssetId: text.bitmapAssetId,
        fontId: text.fontId,
        sourceSha256: text.sourceSha256,
      });
    }
  }
  const transitions = normalizeTransitionsFromProjectV2(
    input.visualProject.transitions,
    layers.filter((layer): layer is VideoLayerV2 => layer.kind === 'video'),
  );
  const captionBurnIn = normalizeCaptionBurnInFromProjectV2(input.visualProject, visual);
  const masterLimiter = normalizeMasterLimiterV2(input.visualProject.audio?.effects);
  const audioBuses = normalizeAudioBusesV2(input.visualProject.audio?.buses);
  const audioCandidates: Array<AudioLayerV2 & { readonly solo: boolean }> = [];
  for (const track of timeline.tracks.filter((item) => item.enabled))
    for (const clip of track.clips) {
      if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
      const config = input.visualProject.audio?.clips[clip.id];
      audioCandidates.push({
        id: `audio:${clip.id}`,
        sourceKind: clip.kind === 'audio' ? 'audio-asset' : 'video-native',
        assetId: clip.assetId,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs: clip.sourceInUs,
        ...(clip.playbackRate !== undefined ? { playbackRate: clip.playbackRate } : {}),
        gain: config?.gain ?? 1,
        pan: config?.pan ?? 0,
        mute: config?.mute ?? false,
        ...(config?.fadeInUs === undefined ? {} : { fadeInUs: config.fadeInUs }),
        ...(config?.fadeOutUs === undefined ? {} : { fadeOutUs: config.fadeOutUs }),
        ...(audioBuses?.some((bus) => bus.id !== 'master' && (bus.inputs ?? []).includes(clip.id))
          ? {
              busId: audioBuses.find(
                (bus) => bus.id !== 'master' && (bus.inputs ?? []).includes(clip.id),
              )!.id,
            }
          : {}),
        solo: config?.solo ?? false,
      });
    }
  const soloActive = audioCandidates.some((layer) => layer.solo);
  const audio = audioCandidates
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
    .map(({ solo: _solo, ...layer }) => ({
      ...layer,
      gain: soloActive && !_solo ? 0 : layer.gain,
      mute: layer.mute || (soloActive && !_solo),
    }));
  const colorGrade =
    input.visualProject.colorGrade === undefined
      ? undefined
      : normalizeColorGradeV2(input.visualProject.colorGrade);
  const raw = {
    version: 2 as const,
    composition: { id: visual.id, width: visual.width, height: visual.height },
    viewport: input.viewport ?? { width: visual.width, height: visual.height },
    frameRate: { num: visual.frameRate.num, den: visual.frameRate.den },
    durationUs: timeline.durationUs,
    background: visual.background,
    ...(colorGrade === undefined ? {} : { colorGrade }),
    layers,
    ...(transitions.length === 0 ? {} : { transitions }),
    audio,
    ...(audioBuses === undefined ? {} : { audioBuses }),
    ...(masterLimiter === undefined ? {} : { masterLimiter }),
    ...(captionBurnIn === undefined ? {} : { captionBurnIn }),
    outputPreset: input.outputPreset ?? input.visualProject.exportPreset ?? 'preview',
  };
  return deepFreeze({ ...raw, planSha256: planDigestV2(raw) });
}

function normalizeMasterLimiterV2(
  effects: readonly { readonly targetId: string; readonly effect: unknown }[] | undefined,
): MasterLimiterV2 | undefined {
  if (effects === undefined || effects.length === 0) return undefined;
  if (effects.length !== 1 || effects[0]!.targetId !== 'master')
    throw new Error('Verified delivery permits only one limiter on the master bus.');
  const effect = effects[0]!.effect;
  if (!isRecord(effect) || effect.kind !== 'limiter')
    throw new Error('Verified delivery permits only a limiter on the master bus.');
  assertExactKeys(effect, ['kind', 'ceiling', 'releaseUs'], 'master limiter');
  if (
    typeof effect.ceiling !== 'number' ||
    !Number.isFinite(effect.ceiling) ||
    effect.ceiling < -24 ||
    effect.ceiling > 0
  )
    throw new Error('Master limiter ceiling must be between -24 dB and 0 dB.');
  if (
    typeof effect.releaseUs !== 'number' ||
    !Number.isSafeInteger(effect.releaseUs) ||
    effect.releaseUs < 10_000 ||
    effect.releaseUs > 1_000_000
  )
    throw new Error('Master limiter release must be between 10000 and 1000000 microseconds.');
  return deepFreeze({ ceilingDb: effect.ceiling, releaseUs: effect.releaseUs });
}

function normalizeColorGradeV2(grade: unknown): ColorGradeV1 | undefined {
  if (!isRecord(grade)) throw new Error('colorGrade must be an object');
  const allowed = new Set(['lift', 'gamma', 'gain', 'saturation', 'lutId']);
  for (const key of Object.keys(grade)) {
    if (!allowed.has(key)) throw new Error(`colorGrade contains unknown field "${key}"`);
  }
  const lift = requireColorGradeNumber(grade, 'lift', -0.5, 0.5);
  const gamma = requireColorGradeNumber(grade, 'gamma', 0.5, 1.5);
  const gain = requireColorGradeNumber(grade, 'gain', 0.5, 1.5);
  const saturation = requireColorGradeNumber(grade, 'saturation', 0, 2);
  const lutId = grade.lutId;
  if (lutId !== undefined && lutId !== 'none' && lutId !== 'rec709' && lutId !== 'contrast')
    throw new Error('colorGrade lutId is unsupported');
  if (lift === 0 && gamma === 1 && gain === 1 && saturation === 1) {
    if (lutId === undefined || lutId === 'none') return undefined;
  }
  return {
    lift,
    gamma,
    gain,
    saturation,
    ...(lutId === undefined || lutId === 'none' ? {} : { lutId }),
  };
}

function requireColorGradeNumber(
  grade: Record<string, unknown>,
  field: 'lift' | 'gamma' | 'gain' | 'saturation',
  minimum: number,
  maximum: number,
): number {
  const value = grade[field];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`colorGrade ${field} must be a finite number`);
  if (value < minimum || value > maximum)
    throw new Error(`colorGrade ${field} must be between ${minimum} and ${maximum}`);
  return value;
}

function normalizeStaticImageEffectsV2(
  effects: readonly EffectInstanceV1[] | undefined,
  objectId: string,
): readonly EffectInstanceV1[] | undefined {
  if (effects === undefined || effects.length === 0) return undefined;
  return effects.map((effect) => {
    if (
      !isRecord(effect) ||
      typeof effect.id !== 'string' ||
      effect.id.length === 0 ||
      typeof effect.effectId !== 'string' ||
      typeof effect.enabled !== 'boolean' ||
      !isRecord(effect.params) ||
      effect.animations !== undefined ||
      effect.label !== undefined
    )
      throw new Error(`Static image effect on ${objectId} is malformed or animated.`);
    if (effect.effectId !== 'brightness-contrast')
      throw new Error(
        `Effect "${effect.effectId}" is not supported for static image layer ${objectId}.`,
      );
    assertExactKeys(
      effect.params,
      ['brightness', 'contrast'],
      `static image effect ${effect.id} params`,
    );
    const brightness = effect.params.brightness;
    const contrast = effect.params.contrast;
    if (
      typeof brightness !== 'number' ||
      !Number.isFinite(brightness) ||
      brightness < -1 ||
      brightness > 1 ||
      typeof contrast !== 'number' ||
      !Number.isFinite(contrast) ||
      contrast < -1 ||
      contrast > 1
    )
      throw new Error(`Brightness/contrast effect on ${objectId} has invalid parameters.`);
    return {
      id: effect.id,
      effectId: 'brightness-contrast',
      enabled: effect.enabled,
      params: { brightness, contrast },
    };
  });
}

function canonicalPlanForDigest(
  plan: Omit<CompositionPlanV2, 'planSha256'> | CompositionPlanV2,
): Record<string, unknown> {
  const withoutDigest = { ...(plan as CompositionPlanV2) } as Record<string, unknown>;
  delete withoutDigest.planSha256;
  if ('colorGrade' in withoutDigest) {
    const colorGrade = normalizeColorGradeV2(withoutDigest.colorGrade);
    if (colorGrade === undefined) delete withoutDigest.colorGrade;
    else withoutDigest.colorGrade = colorGrade;
  }
  if ('captionBurnIn' in withoutDigest) {
    const captionBurnIn = normalizeCaptionBurnInPayloadV2(withoutDigest.captionBurnIn);
    withoutDigest.captionBurnIn = captionBurnIn;
  }
  if (Array.isArray(withoutDigest.audio)) {
    withoutDigest.audio = withoutDigest.audio
      .map((item) => {
        if (!isRecord(item)) return item;
        const { sourceKind, ...layer } = item;
        delete layer.solo;
        return { ...layer, sourceKind: sourceKind ?? 'video-native' };
      })
      .sort((left, right) => {
        if (!isRecord(left) || !isRecord(right)) return 0;
        const leftStart = typeof left.startUs === 'number' ? left.startUs : 0;
        const rightStart = typeof right.startUs === 'number' ? right.startUs : 0;
        return leftStart - rightStart || String(left.id).localeCompare(String(right.id));
      });
  }
  return withoutDigest;
}

function assertCanonicalColorGradeV2(plan: CompositionPlanV2): void {
  if (!('colorGrade' in plan)) return;
  const raw = (plan as CompositionPlanV2 & { readonly colorGrade?: unknown }).colorGrade;
  const normalized = normalizeColorGradeV2(raw);
  if (normalized === undefined || canonicalJsonV2(raw) !== canonicalJsonV2(normalized))
    throw new Error('composition plan colorGrade must use canonical form');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createRenderBundleV2(input: CreateRenderBundleV2Input): RenderBundleV2 {
  assertPlanV2(input.plan);
  assertAssetBindingsV2(input.assets);
  assertLayerAssetCompatibilityV2(input.plan, input.assets);
  const planSha256 = planDigestV2(input.plan);
  if (input.plan.planSha256 !== planSha256) throw new Error('render plan digest mismatch');
  const snapshotBase = {
    projectRef: input.projectRef,
    revision: input.revision ?? 0,
    createdAt: input.createdAt ?? new Date().toISOString(),
    planSha256,
    bundleSha256: '',
  };
  const bundleBase = {
    version: 2 as const,
    plan: input.plan,
    assets: Object.fromEntries(
      Object.entries(input.assets).map(([id, asset]) => [id, normalizedAssetBindingV2(asset)]),
    ),
    snapshot: snapshotBase,
  };
  const bundleSha256 = bundleDigestV2(bundleBase);
  return deepFreeze({ ...bundleBase, snapshot: { ...snapshotBase, bundleSha256 } });
}

export function validateRenderBundleV2(value: unknown): asserts value is RenderBundleV2 {
  if (!value || typeof value !== 'object') throw new Error('render bundle must be an object');
  const bundle = value as RenderBundleV2;
  if (bundle.version !== 2) throw new Error('render bundle version must be 2');
  assertPlanV2(bundle.plan);
  assertAssetBindingsV2(bundle.assets);
  assertLayerAssetCompatibilityV2(bundle.plan, bundle.assets);
  for (const layer of bundle.plan.layers) {
    if ('assetId' in layer && bundle.assets[layer.assetId] === undefined)
      throw new Error(`missing required asset binding: ${layer.assetId}`);
  }
  for (const layer of bundle.plan.audio) {
    if (bundle.assets[layer.assetId] === undefined)
      throw new Error(`missing required audio asset binding: ${layer.assetId}`);
  }
  if (!bundle.snapshot || typeof bundle.snapshot !== 'object')
    throw new Error('render bundle snapshot metadata is required');
  if (
    typeof bundle.snapshot.projectRef !== 'string' ||
    looksLikePathOrUrl(bundle.snapshot.projectRef)
  )
    throw new Error('render bundle projectRef must be opaque, not a path or URL');
  if (!Number.isSafeInteger(bundle.snapshot.revision) || bundle.snapshot.revision < 0)
    throw new Error('render bundle snapshot revision is invalid');
  if (typeof bundle.snapshot.createdAt !== 'string' || bundle.snapshot.createdAt.length === 0)
    throw new Error('render bundle snapshot createdAt is required');
  if (bundle.snapshot.planSha256 !== planDigestV2(bundle.plan))
    throw new Error('render bundle plan digest mismatch');
  if (bundle.snapshot.bundleSha256 !== bundleDigestV2(bundle))
    throw new Error('render bundle canonical digest mismatch');
}

export function assertPlanV2(plan: CompositionPlanV2): void {
  if (plan.version !== 2) throw new Error('composition plan version must be 2');
  assertCanonicalColorGradeV2(plan);
  if (plan.captionBurnIn !== undefined) normalizeCaptionBurnInPayloadV2(plan.captionBurnIn);
  if (plan.planSha256 !== planDigestV2(plan))
    throw new Error('composition plan canonical digest mismatch');
  if (
    plan.layers.some(
      (layer) =>
        layer.kind !== 'video' &&
        layer.kind !== 'image' &&
        layer.kind !== 'html-scene' &&
        layer.kind !== 'motion-scene' &&
        layer.kind !== 'text',
    )
  )
    throw new Error('unsupported render layer class');
  for (const layer of plan.layers) {
    if (layer.kind !== 'image' && 'effects' in layer && layer.effects !== undefined)
      throw new Error(`Effects are only supported for static image layers in verified delivery.`);
    if (layer.kind === 'image' && layer.effects !== undefined)
      normalizeStaticImageEffectsV2(layer.effects, layer.id);
    if (layer.crop !== undefined) {
      if (layer.kind !== 'image')
        throw new Error(`Crop is not supported for ${layer.kind} layer ${layer.id}.`);
      validateImageCropV2(layer.crop, layer.id);
    }
    if (layer.kind !== 'text') continue;
    if (
      typeof layer.bitmapAssetId !== 'string' ||
      typeof layer.sourceSha256 !== 'string' ||
      !HASH.test(layer.sourceSha256)
    )
      throw new Error(`text layer ${layer.id} requires a valid pre-rasterized bitmap source hash`);
    if (typeof layer.fontId !== 'string' || !PINNED_TEXT_FONTS.has(layer.fontId))
      throw new Error(`text layer ${layer.id} uses an unsupported pinned font`);
  }
  assertTransitionsV2(plan.transitions, plan.layers, plan.durationUs);
  assertVideoLayerTimingV2(plan.layers, plan.durationUs);
  assertAudioLayersV2(plan.audio, plan.durationUs);
  if (plan.masterLimiter !== undefined) normalizeMasterLimiterPlanV2(plan.masterLimiter);
}

function validateImageCropV2(
  crop: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
  objectId: string,
): void {
  const values = [crop.left, crop.top, crop.right, crop.bottom];
  if (
    !values.every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 0.49,
    )
  )
    throw new Error(
      `Image crop for ${objectId} must be finite, non-negative fractions no greater than 0.49.`,
    );
  if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1)
    throw new Error(`Image crop for ${objectId} must leave a positive source region.`);
}

function normalizeMasterLimiterPlanV2(value: unknown): MasterLimiterV2 {
  if (!isRecord(value)) throw new Error('master limiter must be an object');
  assertExactKeys(value, ['ceilingDb', 'releaseUs'], 'master limiter');
  if (
    typeof value.ceilingDb !== 'number' ||
    !Number.isFinite(value.ceilingDb) ||
    value.ceilingDb < -24 ||
    value.ceilingDb > 0
  )
    throw new Error('Master limiter ceiling must be between -24 dB and 0 dB.');
  if (
    typeof value.releaseUs !== 'number' ||
    !Number.isSafeInteger(value.releaseUs) ||
    value.releaseUs < 10_000 ||
    value.releaseUs > 1_000_000
  )
    throw new Error('Master limiter release must be between 10000 and 1000000 microseconds.');
  return { ceilingDb: value.ceilingDb, releaseUs: value.releaseUs };
}

/** Video may have non-overlapping holes; overlaps are never composited implicitly. */
function assertVideoLayerTimingV2(layers: readonly CompositionLayerV2[], durationUs: number): void {
  const videos = layers
    .filter((layer): layer is VideoLayerV2 => layer.kind === 'video')
    .slice()
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  let endUs = 0;
  for (const layer of videos) {
    if (
      !Number.isSafeInteger(layer.startUs) ||
      layer.startUs < 0 ||
      !Number.isSafeInteger(layer.durationUs) ||
      layer.durationUs <= 0 ||
      layer.startUs + layer.durationUs > durationUs
    )
      throw new Error(`Video layer ${layer.id} timing is invalid for verified delivery.`);
    if (layer.startUs < endUs)
      throw new Error('Verified delivery does not support overlapping video clips.');
    endUs = layer.startUs + layer.durationUs;
  }
}

/** Hashes the normalized transition intent, excluding its self-digest. */
export function transitionDigestV2(
  transition: Omit<TransitionV2, 'transitionSha256'> | TransitionV2,
): string {
  const value = transition as TransitionV2;
  return sha256HexV2(
    canonicalJsonV2({
      id: value.id,
      trackId: value.trackId,
      leftClipId: value.leftClipId,
      rightClipId: value.rightClipId,
      type: value.type,
      durationUs: value.durationUs,
      startUs: value.startUs,
      endUs: value.endUs,
    }),
  );
}

/** Strictly validates and freezes one normalized transition record. */
export function normalizeTransitionV2(value: unknown): TransitionV2 {
  if (!isRecord(value)) throw new Error('transition metadata must be an object');
  assertExactKeys(
    value,
    [
      'id',
      'trackId',
      'leftClipId',
      'rightClipId',
      'type',
      'durationUs',
      'startUs',
      'endUs',
      'transitionSha256',
    ],
    'transition metadata',
  );
  for (const key of ['id', 'trackId', 'leftClipId', 'rightClipId'] as const)
    if (typeof value[key] !== 'string' || value[key].length === 0)
      throw new Error(`transition metadata ${key} is required`);
  const id = value.id as string;
  const trackId = value.trackId as string;
  const leftClipId = value.leftClipId as string;
  const rightClipId = value.rightClipId as string;
  if (value.type !== 'dissolve')
    throw new Error('only dissolve transitions are supported for verified delivery');
  for (const key of ['durationUs', 'startUs', 'endUs'] as const)
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0)
      throw new Error(`transition metadata ${key} is invalid`);
  const durationUs = value.durationUs as number;
  const startUs = value.startUs as number;
  const endUs = value.endUs as number;
  if (durationUs <= 0 || endUs <= startUs)
    throw new Error('transition metadata interval is invalid');
  if (endUs - startUs !== durationUs)
    throw new Error('transition metadata interval does not match duration');
  if (typeof value.transitionSha256 !== 'string' || !HASH.test(value.transitionSha256))
    throw new Error('transition metadata digest is invalid');
  const transitionSha256 = value.transitionSha256 as string;
  const normalized = {
    id,
    trackId,
    leftClipId,
    rightClipId,
    type: 'dissolve' as const,
    durationUs,
    startUs,
    endUs,
    transitionSha256,
  } satisfies TransitionV2;
  if (transitionDigestV2(normalized) !== normalized.transitionSha256)
    throw new Error('transition metadata digest mismatch');
  return deepFreeze(normalized);
}

function assertTransitionsV2(
  transitions: readonly TransitionV2[] | undefined,
  layers: readonly CompositionLayerV2[],
  durationUs: number,
): void {
  if (transitions === undefined) return;
  const videos = layers.filter((layer): layer is VideoLayerV2 => layer.kind === 'video');
  if (transitions.length > 1)
    throw new Error('verified delivery supports at most one dissolve transition');
  if (transitions.length === 1 && videos.length !== 2)
    throw new Error('verified dissolve delivery requires exactly two video clips');
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const [index, raw] of transitions.entries()) {
    const transition = normalizeTransitionV2(raw);
    if (ids.has(transition.id))
      throw new Error(`transition metadata id is duplicated: ${transition.id}`);
    ids.add(transition.id);
    const pair = `${transition.leftClipId}\u0000${transition.rightClipId}`;
    if (pairs.has(pair)) throw new Error('transition metadata junction is duplicated');
    pairs.add(pair);
    if (transition.endUs > durationUs)
      throw new Error(`transition metadata ${index} exceeds composition duration`);
    const left = videos.find((layer) => layer.id === transition.leftClipId);
    const right = videos.find((layer) => layer.id === transition.rightClipId);
    if (left === undefined || right === undefined)
      throw new Error('transition metadata references unknown video clip');
    if (
      left.id === right.id ||
      (left.trackId !== undefined && right.trackId !== undefined && left.trackId !== right.trackId)
    )
      throw new Error('transition metadata clips must share one video track');
    if (left.trackId !== undefined && left.trackId !== transition.trackId)
      throw new Error('transition metadata track identity is invalid');
    if (right.trackId !== undefined && right.trackId !== transition.trackId)
      throw new Error('transition metadata track identity is invalid');
    if (
      right.startUs !== transition.endUs ||
      transition.startUs !== right.startUs - transition.durationUs
    )
      throw new Error('transition metadata active junction is not right-timed');
    if (left.startUs + left.durationUs !== right.startUs)
      throw new Error('transition metadata requires contiguous video clips');
    if (left.playbackRate !== 1 || right.playbackRate !== 1)
      throw new Error('transition metadata requires 1x compatible video timing');
    if (transition.durationUs >= left.durationUs || transition.durationUs > right.durationUs)
      throw new Error('transition metadata duration exceeds the compatible clip range');
  }
}

function normalizeTransitionsFromProjectV2(
  transitions: readonly TransitionV1[] | undefined,
  videos: readonly VideoLayerV2[],
): readonly TransitionV2[] {
  if (transitions === undefined || transitions.length === 0) return [];
  const normalized = transitions.map((raw) => {
    if (raw.type !== 'dissolve')
      throw new Error('only dissolve transitions are supported for verified delivery');
    const base = {
      id: raw.id,
      trackId: raw.trackId,
      leftClipId: raw.leftClipId,
      rightClipId: raw.rightClipId,
      type: 'dissolve' as const,
      durationUs: raw.durationUs,
      startUs: (videos.find((clip) => clip.id === raw.rightClipId)?.startUs ?? -1) - raw.durationUs,
      endUs: videos.find((clip) => clip.id === raw.rightClipId)?.startUs ?? -1,
    };
    if (raw.params !== undefined && Object.keys(raw.params).length > 0)
      throw new Error('dissolve transition parameters are not supported for verified delivery');
    return { ...base, transitionSha256: transitionDigestV2(base) };
  });
  assertTransitionsV2(normalized, videos, Number.MAX_SAFE_INTEGER);
  return deepFreeze(normalized.map((transition) => deepFreeze(transition)));
}

/** Strict audio contract used at both planner and render-host boundaries. */
function assertAudioLayersV2(audio: readonly AudioLayerV2[], durationUs: number): void {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
    throw new Error('composition durationUs must be a positive safe integer');
  const ids = new Set<string>();
  for (const [index, layer] of audio.entries()) {
    const value = layer as AudioLayerV2 & { readonly [key: string]: unknown };
    assertExactKeys(
      value,
      [
        'id',
        'sourceKind',
        'assetId',
        'startUs',
        'durationUs',
        'sourceInUs',
        'playbackRate',
        'gain',
        'pan',
        'mute',
        'fadeInUs',
        'fadeOutUs',
        'role',
        'busId',
      ],
      `audio layer ${index}`,
    );
    if (typeof layer.id !== 'string' || layer.id.length === 0 || ids.has(layer.id))
      throw new Error(`audio layer ${index} id is missing or duplicated`);
    ids.add(layer.id);
    const sourceKind = layer.sourceKind ?? 'video-native';
    if (sourceKind !== 'video-native' && sourceKind !== 'audio-asset')
      throw new Error(`audio layer ${layer.id} sourceKind is unsupported`);
    if (typeof layer.assetId !== 'string' || layer.assetId.length === 0)
      throw new Error(`audio layer ${layer.id} assetId is required`);
    for (const [name, value] of [
      ['startUs', layer.startUs],
      ['durationUs', layer.durationUs],
      ['sourceInUs', layer.sourceInUs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || (name === 'durationUs' && value <= 0))
        throw new Error(`audio layer ${layer.id} ${name} is invalid`);
    }
    if (layer.startUs + layer.durationUs > durationUs)
      throw new Error(`audio layer ${layer.id} exceeds composition duration`);
    if (!Number.isFinite(layer.gain) || layer.gain < 0 || layer.gain > 8)
      throw new Error(`audio layer ${layer.id} gain must be between 0 and 8`);
    if (!Number.isFinite(layer.pan) || layer.pan < -1 || layer.pan > 1)
      throw new Error(`audio layer ${layer.id} pan must be between -1 and 1`);
    if (typeof layer.mute !== 'boolean') throw new Error(`audio layer ${layer.id} mute is invalid`);
    if (
      layer.playbackRate !== undefined &&
      (!Number.isFinite(layer.playbackRate) || layer.playbackRate < 0.1 || layer.playbackRate > 8)
    )
      throw new Error(`audio layer ${layer.id} playbackRate must be in [0.1, 8]`);
    for (const [name, fade] of [
      ['fadeInUs', layer.fadeInUs],
      ['fadeOutUs', layer.fadeOutUs],
    ] as const) {
      if (
        fade !== undefined &&
        (!Number.isSafeInteger(fade) || fade < 0 || fade > layer.durationUs)
      )
        throw new Error(`audio layer ${layer.id} ${name} is invalid`);
    }
    if (layer.role !== undefined && (typeof layer.role !== 'string' || layer.role.length === 0))
      throw new Error(`audio layer ${layer.id} role is invalid`);
    if (layer.busId !== undefined && (typeof layer.busId !== 'string' || layer.busId.length === 0))
      throw new Error(`audio layer ${layer.id} busId is invalid`);
  }
}

function normalizeAudioBusesV2(value: unknown): readonly AudioBusV2[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('audio buses must include a master bus');
  const buses = value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`audio bus ${index} is invalid`);
    const allowed = new Set(['id', 'name', 'gain', 'pan', 'mute', 'solo', 'inputs']);
    if (Object.keys(raw).some((key) => !allowed.has(key)))
      throw new Error(
        'Audio bus effects and advanced routing are not supported for verified delivery.',
      );
    if (
      typeof raw.id !== 'string' ||
      typeof raw.name !== 'string' ||
      (raw.inputs !== undefined && !Array.isArray(raw.inputs))
    )
      throw new Error(`audio bus ${index} is invalid`);
    if (raw.solo === true)
      throw new Error('Audio bus solo is not supported for verified delivery.');
    if (
      typeof raw.gain !== 'number' ||
      typeof raw.pan !== 'number' ||
      !Number.isFinite(raw.gain) ||
      raw.gain < 0 ||
      raw.gain > 8 ||
      !Number.isFinite(raw.pan) ||
      raw.pan < -1 ||
      raw.pan > 1 ||
      typeof raw.mute !== 'boolean'
    )
      throw new Error(`audio bus ${raw.id} mix settings are invalid`);
    if (raw.id !== 'master' && raw.id !== 'music')
      throw new Error(`Audio bus "${raw.id}" is not supported for verified delivery.`);
    const inputs = (raw.inputs ?? []) as unknown[];
    if (inputs.some((input) => typeof input !== 'string'))
      throw new Error(`audio bus ${raw.id} inputs are invalid`);
    return {
      id: raw.id,
      name: raw.name,
      gain: raw.gain,
      pan: raw.pan,
      mute: raw.mute,
      inputs: inputs as string[],
    };
  });
  if (!buses.some((bus) => bus.id === 'master'))
    throw new Error('audio buses must include a master bus');
  if (new Set(buses.map((bus) => bus.id)).size !== buses.length)
    throw new Error('audio bus ids must be unique');
  if (buses.length > 2)
    throw new Error('Only master and music audio buses are supported for verified delivery.');
  return deepFreeze(buses);
}

export interface V2DeliveryPreflightResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** The deliberately narrow first V2 delivery envelope. Reasons are safe to show to users. */
export function preflightCompositionPlanV2(plan: CompositionPlanV2): V2DeliveryPreflightResult {
  const candidate = plan as CompositionPlanV2 & { readonly [key: string]: unknown };
  const layers = candidate.layers as unknown as readonly Record<string, unknown>[];
  for (const layer of layers) {
    const kind = typeof layer.kind === 'string' ? layer.kind : 'unknown';
    if (
      kind !== 'video' &&
      kind !== 'image' &&
      kind !== 'html-scene' &&
      kind !== 'motion-scene' &&
      kind !== 'text'
    )
      return { allowed: false, reason: `Unsupported layer class "${kind}" for verified delivery.` };
    if (kind === 'video' && typeof layer.playbackRate === 'number' && layer.playbackRate <= 0)
      return {
        allowed: false,
        reason: 'Freeze (0×) video clips are not supported by verified delivery.',
      };
    if (
      layer.rotationDeg !== undefined &&
      (typeof layer.rotationDeg !== 'number' || !Number.isFinite(layer.rotationDeg))
    )
      return { allowed: false, reason: 'Rotation must be finite for verified delivery.' };
    if (layer.positionZ !== undefined && layer.positionZ !== 0)
      return { allowed: false, reason: 'Depth positionZ is not supported for verified delivery.' };
    if (layer.camera !== undefined)
      return { allowed: false, reason: 'Camera layers are not supported for verified delivery.' };
    if (layer.crop !== undefined && layer.kind !== 'image')
      return { allowed: false, reason: `Crop is not supported for ${kind} layers.` };
    if (layer.crop !== undefined) {
      try {
        validateImageCropV2(
          layer.crop as { left: number; top: number; right: number; bottom: number },
          String(layer.id),
        );
      } catch (error) {
        return {
          allowed: false,
          reason: error instanceof Error ? error.message : 'Image crop is invalid.',
        };
      }
    }
    if (layer.effect !== undefined)
      return { allowed: false, reason: 'Effects are not supported for verified delivery.' };
    if (layer.effects !== undefined) {
      if (!Array.isArray(layer.effects) || layer.effects.length === 0)
        return { allowed: false, reason: 'Effects are not supported for verified delivery.' };
      if (kind !== 'image')
        return {
          allowed: false,
          reason: 'Effects are only supported for static image layers in verified delivery.',
        };
      try {
        normalizeStaticImageEffectsV2(
          layer.effects as readonly EffectInstanceV1[],
          String(layer.id),
        );
      } catch (error) {
        return {
          allowed: false,
          reason: error instanceof Error ? error.message : 'Static image effect is unsupported.',
        };
      }
    }
    if (
      layer.animations !== undefined ||
      layer.expressions !== undefined ||
      layer.spatialPath !== undefined ||
      layer.motionBlur !== undefined
    )
      return {
        allowed: false,
        reason: 'Animated visual layers are not supported for verified delivery.',
      };
    if (layer.camera !== undefined)
      return { allowed: false, reason: 'Camera layers are not supported for verified delivery.' };
    if (layer.proxy === true || layer.proxyRef !== undefined)
      return { allowed: false, reason: 'Proxy media is not supported for verified delivery.' };
    if (kind === 'text') {
      if (typeof layer.bitmapAssetId !== 'string' || layer.bitmapAssetId.length === 0)
        return {
          allowed: false,
          reason: 'Text layer requires a published pre-rasterized bitmap binding.',
        };
      if (typeof layer.fontId !== 'string' || !PINNED_TEXT_FONTS.has(layer.fontId))
        return {
          allowed: false,
          reason: `Text layer font is not in the pinned allowlist: ${String(layer.fontId ?? '')}.`,
        };
      if (typeof layer.sourceSha256 !== 'string' || !HASH.test(layer.sourceSha256))
        return { allowed: false, reason: 'Text layer source integrity hash is invalid.' };
    }
  }
  try {
    assertVideoLayerTimingV2(plan.layers, plan.durationUs);
  } catch (error) {
    return {
      allowed: false,
      reason:
        error instanceof Error
          ? error.message
          : 'Video layer timing is invalid for verified delivery.',
    };
  }
  const planData = plan as CompositionPlanV2 & {
    readonly transitions?: unknown;
    readonly captionBurnIn?: unknown;
    readonly audioBuses?: unknown;
    readonly masterLimiter?: unknown;
  };
  if (planData.audioBuses !== undefined) {
    try {
      normalizeAudioBusesV2(planData.audioBuses);
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : 'Audio bus graph is unsupported.',
      };
    }
  }
  if (planData.transitions !== undefined) {
    try {
      assertTransitionsV2(
        planData.transitions as readonly TransitionV2[],
        plan.layers,
        plan.durationUs,
      );
    } catch (error) {
      return {
        allowed: false,
        reason:
          error instanceof Error
            ? error.message
            : 'Transition metadata is invalid for verified delivery.',
      };
    }
  }
  if ((planData as { readonly captionBurnIn?: unknown }).captionBurnIn === true)
    return {
      allowed: false,
      reason: 'Turn off burned-in captions before using verified delivery.',
    };
  if ((planData as { readonly captionBurnIn?: unknown }).captionBurnIn !== undefined) {
    try {
      normalizeCaptionBurnInPayloadV2(
        (planData as { readonly captionBurnIn?: unknown }).captionBurnIn,
      );
    } catch (error) {
      return {
        allowed: false,
        reason: `Burned-in caption payload is not renderer-valid: ${
          error instanceof Error ? error.message : 'invalid payload'
        }`,
      };
    }
  }
  if (plan.masterLimiter !== undefined) {
    try {
      normalizeMasterLimiterPlanV2(plan.masterLimiter);
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : 'Master limiter configuration is invalid.',
      };
    }
  }
  for (const audio of plan.audio as readonly (AudioLayerV2 & {
    readonly [key: string]: unknown;
  })[]) {
    const sourceKind = audio.sourceKind ?? 'video-native';
    if (sourceKind !== 'video-native' && sourceKind !== 'audio-asset')
      return { allowed: false, reason: 'Audio layer source kind is unsupported.' };
    if (typeof audio.assetId !== 'string' || audio.assetId.length === 0)
      return { allowed: false, reason: 'Audio layer asset is missing.' };
    if (
      !Number.isSafeInteger(audio.startUs) ||
      audio.startUs < 0 ||
      !Number.isSafeInteger(audio.durationUs) ||
      audio.durationUs <= 0 ||
      !Number.isSafeInteger(audio.sourceInUs) ||
      audio.sourceInUs < 0 ||
      audio.startUs + audio.durationUs > plan.durationUs
    )
      return { allowed: false, reason: 'Audio layer timing is invalid for verified delivery.' };
    if (!Number.isFinite(audio.gain) || audio.gain < 0 || audio.gain > 8)
      return { allowed: false, reason: 'Audio gain is outside the verified delivery range.' };
    if (!Number.isFinite(audio.pan) || audio.pan < -1 || audio.pan > 1)
      return { allowed: false, reason: 'Audio pan is outside the verified delivery range.' };
    if (
      audio.playbackRate !== undefined &&
      (!Number.isFinite(audio.playbackRate) || audio.playbackRate < 0.1 || audio.playbackRate > 8)
    )
      return { allowed: false, reason: 'Audio playback rate must be in [0.1, 8].' };
    if (
      (audio.fadeInUs !== undefined &&
        (!Number.isSafeInteger(audio.fadeInUs) ||
          audio.fadeInUs < 0 ||
          audio.fadeInUs > audio.durationUs)) ||
      (audio.fadeOutUs !== undefined &&
        (!Number.isSafeInteger(audio.fadeOutUs) ||
          audio.fadeOutUs < 0 ||
          audio.fadeOutUs > audio.durationUs))
    )
      return { allowed: false, reason: 'Audio fade timing is invalid for verified delivery.' };
    if (audio.busId !== undefined || audio.bus !== undefined)
      if (audio.busId !== undefined && planData.audioBuses === undefined)
        return {
          allowed: false,
          reason: 'Audio layer bus routing requires a normalized bus graph.',
        };
    if (audio.busId !== undefined && audio.busId !== 'master' && audio.busId !== 'music')
      return { allowed: false, reason: 'Audio layer bus routing is unsupported.' };
    if (audio.effects !== undefined)
      return { allowed: false, reason: 'Audio effects are not supported for verified delivery.' };
    if (audio.stretch !== undefined || audio.rate !== undefined)
      return {
        allowed: false,
        reason: 'Audio stretch and rate changes are not supported for verified delivery.',
      };
  }
  return { allowed: true };
}

/** Hashes only normalized caption intent (the self-hash is excluded). */
export function captionBurnInDigestV2(
  payload: Omit<CaptionBurnInV2, 'payloadSha256'> | CaptionBurnInV2,
): string {
  const value = payload as CaptionBurnInV2;
  return sha256HexV2(
    canonicalJsonV2({
      intent: value.intent,
      styleRef: value.styleRef,
      segments: value.segments,
    }),
  );
}

/** Strictly validates a caption payload received at the render boundary. */
export function normalizeCaptionBurnInPayloadV2(value: unknown): CaptionBurnInV2 {
  if (!isRecord(value)) throw new Error('caption burn-in payload must be an object');
  assertExactKeys(value, ['intent', 'styleRef', 'segments', 'payloadSha256'], 'caption payload');
  if (value.intent !== 'burn-in') throw new Error('caption payload intent must be burn-in');
  if (!isBuiltinCaptionStyleRefV2(value.styleRef))
    throw new Error(
      `caption styleRef is not a supported built-in style: ${String(value.styleRef)}`,
    );
  if (!Array.isArray(value.segments)) throw new Error('caption payload segments must be an array');
  const segments = value.segments.map((item, index) => normalizeCaptionSegmentV2(item, index));
  const ids = new Set<string>();
  for (const segment of segments) {
    if (ids.has(segment.id))
      throw new Error(`caption payload segment id is duplicated: ${segment.id}`);
    ids.add(segment.id);
  }
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1]!;
    const current = segments[index]!;
    if (
      current.startUs < previous.startUs ||
      (current.startUs === previous.startUs && current.id.localeCompare(previous.id) < 0)
    )
      throw new Error('caption payload segments must be in canonical time/id order');
  }
  if (typeof value.payloadSha256 !== 'string' || !HASH.test(value.payloadSha256))
    throw new Error('caption payload digest is invalid');
  const normalized = {
    intent: 'burn-in' as const,
    styleRef: value.styleRef,
    segments,
    payloadSha256: value.payloadSha256,
  } satisfies CaptionBurnInV2;
  if (captionBurnInDigestV2(normalized) !== normalized.payloadSha256)
    throw new Error('caption payload digest mismatch');
  return deepFreeze(normalized);
}

function normalizeCaptionBurnInFromProjectV2(
  project: JoyProjectV1,
  composition: CompositionV1,
): CaptionBurnInV2 | undefined {
  if (project.pluginData['joy.captions.burnIn'] !== true) return undefined;
  const segments: CaptionSegmentV2[] = [];
  let styleRef: BuiltinCaptionStyleRefV2 = DEFAULT_CAPTION_TEMPLATE_ID;
  let styleSeen = false;
  const tracks = composition.tracks
    .filter((track) => track.enabled && track.kind === 'caption')
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'caption') continue;
      const document = project.captionDocuments[clip.captionDocumentId];
      if (document === undefined)
        throw new Error(`caption clip ${clip.id} references a missing document`);
      if (document.animationRef !== undefined)
        throw new Error(`caption document ${document.id} uses unsupported animationRef`);
      const documentStyle = document.styleRef ?? DEFAULT_CAPTION_TEMPLATE_ID;
      if (!isBuiltinCaptionStyleRefV2(documentStyle))
        throw new Error(`caption styleRef is not a supported built-in style: ${documentStyle}`);
      if (!styleSeen) {
        styleRef = documentStyle;
        styleSeen = true;
      } else if (styleRef !== documentStyle) {
        throw new Error('verified delivery supports one caption styleRef per render');
      }
      for (const segment of document.segments) {
        const text = segmentDisplayText(document, segment);
        const startUs = clip.startUs + segment.startUs;
        const endUs = Math.min(clip.startUs + segment.endUs, clip.startUs + clip.durationUs);
        if (text.length === 0 || endUs <= startUs) continue;
        segments.push({
          id: `${clip.id}:${segment.id}`,
          startUs,
          endUs,
          text: text.replace(/\r\n?/g, '\n'),
          direction:
            document.direction === 'auto'
              ? resolveCaptionDirection({ ...document, segments: [segment] })
              : document.direction,
        });
      }
    }
  }
  segments.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  const payloadBase = { intent: 'burn-in' as const, styleRef, segments };
  return deepFreeze({ ...payloadBase, payloadSha256: captionBurnInDigestV2(payloadBase) });
}

function normalizeCaptionSegmentV2(value: unknown, index: number): CaptionSegmentV2 {
  if (!isRecord(value)) throw new Error(`caption segment ${index} must be an object`);
  assertExactKeys(
    value,
    ['id', 'startUs', 'endUs', 'text', 'direction'],
    `caption segment ${index}`,
  );
  const id = value.id;
  const startUs = value.startUs;
  const endUs = value.endUs;
  const text = value.text;
  const direction = value.direction;
  if (typeof id !== 'string' || id.length === 0)
    throw new Error(`caption segment ${index} id is required`);
  if (typeof startUs !== 'number' || !Number.isSafeInteger(startUs) || startUs < 0)
    throw new Error(`caption segment ${index} startUs is invalid`);
  if (typeof endUs !== 'number' || !Number.isSafeInteger(endUs) || endUs <= startUs)
    throw new Error(`caption segment ${index} endUs is invalid`);
  if (typeof text !== 'string' || text.length === 0)
    throw new Error(`caption segment ${index} text is required`);
  if (direction !== 'ltr' && direction !== 'rtl')
    throw new Error(`caption segment ${index} direction is invalid`);
  return {
    id,
    startUs,
    endUs,
    text: text.replace(/\r\n?/g, '\n'),
    direction,
  };
}

function isBuiltinCaptionStyleRefV2(value: unknown): value is BuiltinCaptionStyleRefV2 {
  return JOY_CAPTION_TEMPLATES.some((template) => template.id === value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value))
    if (!expected.has(key)) throw new Error(`${label} contains unsupported field "${key}"`);
}

export function assertAssetBindingsV2(assets: Readonly<Record<string, AssetBindingV2>>): void {
  for (const [key, asset] of Object.entries(assets ?? {})) {
    if (asset.assetId !== key || !asset.opaqueRef || looksLikePathOrUrl(asset.opaqueRef))
      throw new Error(`asset binding ${key} must use an opaque reference`);
    const sha256 = asset.integrity?.sha256 ?? asset.sha256;
    const bytes = asset.integrity?.bytes ?? asset.bytes;
    const mime = asset.integrity?.mime ?? asset.mimeType;
    if (sha256 === undefined || !HASH.test(sha256))
      throw new Error(`asset binding ${key} requires a sha256 digest`);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error(`asset binding ${key} requires a positive byte length`);
    if (typeof mime !== 'string' || !/^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/i.test(mime))
      throw new Error(`asset binding ${key} requires a valid mime type`);
    if (mime === 'text/html')
      throw new Error(`HTML scene asset ${key} must use a published scene package binding.`);
    if (asset.opaqueRef.startsWith('html-scene:')) {
      if (
        asset.htmlScene === undefined ||
        asset.htmlScene.packageId.length === 0 ||
        !HASH.test(asset.htmlScene.sourceSha256)
      )
        throw new Error(`HTML scene asset ${key} requires published package and source identity`);
      if (asset.htmlScene.packageId !== asset.opaqueRef.slice('html-scene:'.length))
        throw new Error(`HTML scene asset ${key} package identity does not match opaque reference`);
    }
    if (asset.opaqueRef.startsWith('motion-scene:')) assertMotionSceneBindingV2(key, asset);
    if (asset.textBitmap !== undefined) {
      const bitmap = asset.textBitmap;
      if (
        !HASH.test(bitmap.sourceSha256) ||
        !PINNED_TEXT_FONTS.has(bitmap.fontId) ||
        !Number.isSafeInteger(bitmap.width) ||
        bitmap.width < 1 ||
        !Number.isSafeInteger(bitmap.height) ||
        bitmap.height < 1
      )
        throw new Error(`text bitmap asset ${key} metadata is invalid`);
      if (!mime.toLowerCase().startsWith('image/'))
        throw new Error(`text bitmap asset ${key} requires an image binding`);
    }
    if (
      asset.integrity !== undefined &&
      asset.sha256 !== undefined &&
      asset.sha256 !== asset.integrity.sha256
    )
      throw new Error(`asset binding ${key} digest aliases disagree`);
    if (
      asset.integrity !== undefined &&
      asset.bytes !== undefined &&
      asset.bytes !== asset.integrity.bytes
    )
      throw new Error(`asset binding ${key} byte aliases disagree`);
    if (
      asset.integrity !== undefined &&
      asset.mimeType !== undefined &&
      asset.mimeType !== asset.integrity.mime
    )
      throw new Error(`asset binding ${key} mime aliases disagree`);
  }
}

function assertLayerAssetCompatibilityV2(
  plan: CompositionPlanV2,
  assets: Readonly<Record<string, AssetBindingV2>>,
): void {
  for (const layer of plan.layers) {
    if (layer.kind === 'text') {
      if (typeof layer.fontId !== 'string' || !PINNED_TEXT_FONTS.has(layer.fontId))
        throw new Error(`text layer ${layer.id} uses an unsupported pinned font`);
      if (typeof layer.sourceSha256 !== 'string' || !HASH.test(layer.sourceSha256))
        throw new Error(`text layer ${layer.id} source integrity hash is invalid`);
      if (typeof layer.bitmapAssetId !== 'string')
        throw new Error(`text layer ${layer.id} requires a published bitmap binding`);
      const binding = assets[layer.bitmapAssetId];
      if (binding === undefined || binding.textBitmap === undefined)
        throw new Error(`text layer ${layer.id} requires a published bitmap binding`);
      if (
        binding.textBitmap.fontId !== layer.fontId ||
        binding.textBitmap.sourceSha256 !== layer.sourceSha256
      )
        throw new Error(`text layer ${layer.id} bitmap binding metadata mismatch`);
      if (
        !Number.isSafeInteger(binding.textBitmap.width) ||
        binding.textBitmap.width < 1 ||
        !Number.isSafeInteger(binding.textBitmap.height) ||
        binding.textBitmap.height < 1
      )
        throw new Error(`text layer ${layer.id} bitmap dimensions are invalid`);
      continue;
    }
    if (layer.kind === 'html-scene') {
      const binding = assets[layer.assetId];
      if (binding === undefined) continue;
      if (!binding.opaqueRef.startsWith('html-scene:') || binding.htmlScene === undefined)
        throw new Error(`HTML scene layer ${layer.id} requires a published scene binding`);
      continue;
    }
    if (layer.kind === 'motion-scene') {
      const binding = assets[layer.assetId];
      if (
        binding === undefined ||
        !binding.opaqueRef.startsWith('motion-scene:') ||
        binding.motionScene === undefined
      )
        throw new Error(
          `Motion scene layer ${layer.id} requires a canonical published snapshot binding`,
        );
      continue;
    }
    if (layer.kind !== 'image') continue;
    const binding = assets[layer.assetId];
    if (binding === undefined) continue;
    const mime = binding.integrity?.mime ?? binding.mimeType;
    if (typeof mime !== 'string' || !mime.toLowerCase().startsWith('image/'))
      throw new Error(`image layer ${layer.id} requires an image asset binding`);
  }
}

function assertMotionSceneBindingV2(key: string, asset: AssetBindingV2): void {
  const motion = asset.motionScene;
  if (motion === undefined)
    throw new Error(`Motion scene asset ${key} requires a canonical snapshot`);
  if (!HASH.test(motion.snapshotSha256))
    throw new Error(`Motion scene asset ${key} snapshot digest is invalid`);
  if (sha256HexV2(canonicalJsonV2(motion.snapshot)) !== motion.snapshotSha256)
    throw new Error(`Motion scene asset ${key} snapshot integrity mismatch`);
  if (motion.snapshot.customCode !== undefined || motion.snapshot.components.length > 0)
    throw new Error(`Motion scene asset ${key} uses unsupported custom/component content`);
  for (const [layerId, layer] of Object.entries(motion.layers)) {
    if (!layerId || !layer.opaqueRef || looksLikePathOrUrl(layer.opaqueRef))
      throw new Error(
        `Motion scene asset ${key} layer ${layerId} requires an opaque Worker reference`,
      );
    if (
      !HASH.test(layer.integrity.sha256) ||
      !Number.isSafeInteger(layer.integrity.bytes) ||
      layer.integrity.bytes < 1
    )
      throw new Error(`Motion scene asset ${key} layer ${layerId} integrity is invalid`);
  }
  for (const layer of motion.snapshot.layers) {
    if (layer.animations.length > 0 || layer.type !== 'shape')
      throw new Error(
        `Motion scene asset ${key} layer ${layer.id} is outside the static placement slice`,
      );
  }
}

function normalizedAssetBindingV2(asset: AssetBindingV2): AssetBindingV2 {
  const sha256 = asset.integrity?.sha256 ?? asset.sha256;
  const bytes = asset.integrity?.bytes ?? asset.bytes;
  const mime = asset.integrity?.mime ?? asset.mimeType;
  if (sha256 === undefined || bytes === undefined || mime === undefined)
    throw new Error(`asset binding ${asset.assetId} integrity is incomplete`);
  return {
    assetId: asset.assetId,
    opaqueRef: asset.opaqueRef,
    integrity: { sha256, bytes, mime },
    ...(asset.htmlScene === undefined ? {} : { htmlScene: asset.htmlScene }),
    ...(asset.motionScene === undefined ? {} : { motionScene: asset.motionScene }),
    ...(asset.textBitmap === undefined ? {} : { textBitmap: asset.textBitmap }),
  };
}

function looksLikePathOrUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|file:|https?:|data:|blob:|\/|\\\\|[A-Za-z]:[\\/])/.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
