import type { AnimationCurveV1 } from '@joy-media/project-schema';

export type EffectParamValue =
  | number
  | string
  | boolean
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number];

export type EffectCategory = 'color' | 'blur' | 'distort' | 'artistic' | 'depth' | 'stylize';

export type EffectParamType = 'number' | 'boolean' | 'color' | 'vector2' | 'enum';

export interface EffectParamDescriptor {
  readonly key: string;
  readonly label: string;
  readonly type: EffectParamType;
  readonly defaultValue: EffectParamValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: readonly {
    readonly label: string;
    readonly value: string | number;
  }[];
  readonly animatable: boolean;
}

export interface EffectBackendSupport {
  readonly pixiPreview: boolean;
  readonly headless: boolean;
  readonly ffmpeg: boolean;
  readonly deterministic: boolean;
  readonly notes?: string;
}

export interface EffectDescriptor {
  readonly id: string;
  readonly label: string;
  readonly category: EffectCategory;
  readonly description?: string;
  readonly params: readonly EffectParamDescriptor[];
  readonly tags: readonly string[];
  readonly backend: EffectBackendSupport;
  readonly cost: 'low' | 'medium' | 'high';
  readonly createPixiFilter?: (
    params: Readonly<Record<string, EffectParamValue>>,
  ) => Promise<unknown> | unknown;
}

export interface EffectInstanceV1 {
  readonly id: string;
  readonly effectId: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, EffectParamValue>>;
  readonly animations?: Readonly<Partial<Record<string, AnimationCurveV1>>>;
  readonly label?: string;
}

export interface EffectRenderSpec {
  readonly instanceId: string;
  readonly effectId: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, EffectParamValue>>;
}

export interface EffectRegistryEntry {
  readonly descriptor: EffectDescriptor;
  readonly factory?: (
    params: Readonly<Record<string, EffectParamValue>>,
  ) => Promise<unknown> | unknown;
}

export interface EffectRegistry {
  registerEffect(descriptor: EffectDescriptor, factory?: EffectRegistryEntry['factory']): void;
  getEffect(id: string): EffectDescriptor | undefined;
  hasEffect(id: string): boolean;
  listEffects(): readonly EffectDescriptor[];
  getByCategory(category: EffectCategory): readonly EffectDescriptor[];
  searchEffects(query: string): readonly EffectDescriptor[];
}

export interface EffectDragPayload {
  readonly kind: 'joy/effect';
  readonly effectId: string;
  readonly source: 'effects-panel';
}

export interface TransitionDragPayload {
  readonly kind: 'joy/transition';
  readonly transitionId: string;
  readonly source: 'transitions-panel';
}
