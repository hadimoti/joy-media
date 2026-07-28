/**
 * @joy-media/motion-core — universal keyframe motion (WP-04.1).
 *
 * Pure keyframes, curves, easing, spatial paths, and value scaling on top of the
 * durable 20.3 animation schema in `@joy-media/project-schema`. This package
 * owns interpolation and curve editing; it holds no renderer, no expressions
 * (deferred, 20.3), and no wall-clock dependence. Dependency points inward
 * (9.1): motion-core -> project-schema only.
 *
 * Extended with Motion Studio: MotionSceneDocument, registry, descriptors.
 */

export const PACKAGE_NAME = '@joy-media/motion-core' as const;

export type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  BezierHandlesV1,
  KeyframeInterpolationV1,
  KeyframeV1,
  SpatialKeyframe,
  SpatialPathV1,
  Vec2,
} from '@joy-media/project-schema';
export { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';

export {
  cubicBezierEase,
  EASED_HANDLES,
  interpolateSegment,
  segmentEaseFraction,
} from './interpolation.js';

export type { KeyframeClipboard } from './curve.js';
export {
  copyKeyframes,
  pasteKeyframes,
  removeKeyframe,
  sampleCurve,
  scaleCurveValues,
  setKeyframe,
} from './curve.js';

export { sampleSpatialPath } from './spatial.js';

export type { ObjectAnimations } from './transform.js';
export { isAnimated, resolveAnimatedTransform, resolveObjectTransform } from './transform.js';

export { composeTransforms, parentChain, resolveWorldTransform } from './parenting.js';

export type { MotionPreset, MotionPresetOptions, PresetChannels } from './presets.js';
export { buildPresetChannels, JOY_MOTION_PRESETS, resolveMotionPreset } from './presets.js';

export type { TextAnimationScope, TextStaggerOptions } from './text.js';
export { splitTextUnits, staggerOffsets } from './text.js';

export type { MotionBlurV1 } from '@joy-media/project-schema';
export { motionBlurSampleOffsetsUs } from './blur.js';

export type {
  MotionApplyResult,
  MotionCommand,
  MotionCommandError,
  ReplaceAnimationCommand,
  SetParentCommand,
  SetExpressionCommand,
  SetSpatialPathCommand,
  AddEffectCommand,
  RemoveEffectCommand,
  ReorderEffectCommand,
  ToggleEffectCommand,
  SetEffectParamCommand,
  ClearEffectsCommand,
  ReplaceEffectCommand,
} from './commands.js';
export { applyMotionProjectCommand } from './commands.js';

export type {
  ExpressionChannelDiagnostic,
  ObjectExpressionResolution,
  WorldExpressionResolution,
} from './expression.js';
export {
  buildExpressionReferenceGraph,
  expressionNodeKey,
  resolveObjectTransformWithExpressions,
  resolveWorldTransformWithExpressions,
} from './expression.js';

/* ─── Motion Studio types ─── */

export type {
  MotionLayerId,
  MotionComponentId,
  MotionVariableId,
  TimeMs,
  MotionLayerType,
  UnitValue,
  MotionFill,
  GradientFill,
  GradientStop,
  GradientType,
  MotionStroke,
  MotionShadow,
  MotionFilter,
  BlendMode,
  MotionTransform,
  FlexLayout,
  GridLayout,
  LayoutMode,
  MaskType,
  MotionMask,
  MotionTypography,
  MotionEasing,
  MotionEasingName,
  CubicBezierEasing,
  MotionKeyframe,
  MotionKeyframeCurve,
  AnimatableMotionProperty,
  MotionAnimation,
  MotionLayer,
  SceneBackground,
  MotionVariable,
  MotionVariableType,
  MotionComponent,
  MotionComponentVariant,
  ComponentProperty,
  MotionMarker,
  SandboxedCodeBundle,
  MotionSceneDocument,
} from './scene.js';
export {
  DEFAULT_TRANSFORM,
  DEFAULT_TYPOGRAPHY,
  CURRENT_SCENE_SCHEMA_VERSION,
  createBlankScene,
} from './scene.js';

export type {
  MotionDescriptor,
  MotionSource,
  MotionCategory,
  AspectSupport,
  MotionCapability,
  MotionPreviewDescriptor,
} from './descriptor.js';

export { MotionRegistry, convertPresetToScene } from './registry.js';
export { validateMotionSceneDocument, migrateSceneDocument } from './schema.js';
export { registerBuiltinMotions, BUILTIN_MOTIONS } from './builtins.js';

/* ─── Motion Studio evaluator ─── */

export {
  evaluateMotionScene,
  resolvedLayerOpacity,
  resolvedLayerTransform,
  setKeyframeAt,
  removeKeyframeAt,
  hasKeyframeAt,
} from './evaluator.js';
export type {
  LayerEvaluation,
  EvaluatedTransform,
  SceneEvaluation,
} from './evaluator.js';
