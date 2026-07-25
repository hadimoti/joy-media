export { EffectRegistryImpl, effectRegistry, registerEffect, getEffect, hasEffect, listEffects, getByCategory, searchEffects } from "./EffectRegistry.js";
export type {
  EffectParamValue,
  EffectCategory,
  EffectParamType,
  EffectParamDescriptor,
  EffectBackendSupport,
  EffectDescriptor,
  EffectInstanceV1,
  EffectRenderSpec,
  EffectRegistryEntry,
  EffectRegistry,
  EffectDragPayload,
  TransitionDragPayload,
} from "./types.js";

export {
  createBrightnessContrastFilter,
  normalizeBrightnessContrastParams,
  updateBrightnessContrastFilter,
} from "./factories/pixi/BrightnessContrastFilter.js";
export type { BrightnessContrastParams } from "./factories/pixi/BrightnessContrastFilter.js";

export { registerBuiltins } from "./builtin/metadata.js";

export {
  BUILTIN_PRESETS,
  JoyEffectPresetV1,
  findPreset,
  listPresets,
} from "./presets/types.js";

export {
  effectToFfmpegFilter,
  effectStackToFfmpegFiltergraph,
} from "./ffmpeg-backend.js";