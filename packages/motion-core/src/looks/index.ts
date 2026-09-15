/** Living Look definitions, validation, and the pure compiler (R2). */

export {
  LOOK_DEFINITION_SCHEMA_VERSION,
  LOOK_OPERATION_KINDS,
  type LookOperationKind,
  type LookControlKind,
  type LookBindingChannel,
  type LookBindingTarget,
  type LookBooleanDrive,
  type LookScalarControl,
  type LookScalarDrive,
  type LookEnumControl,
  type LookColorControl,
  type LookFontControl,
  type LookBooleanControl,
  type LookTemplateDrive,
  type LookControl,
  type LookSlot,
  type LookFormatConstraints,
  type LookConstraints,
  type LookProvenance,
  type LookVerificationPredicate,
  type LookDefinition,
  type LookOperation,
  type LookSetKeyframeOperation,
  type LookSetTextContentOperation,
  type LookSetTextTemplateOperation,
  type LookSetCaptionTemplateOperation,
  type LookAddTransitionOperation,
  type LookCompilerDiagnostic,
  type LookAudioBakeInput,
  type LookCompileInput,
  type LookCompileResult,
} from './types.js';
export { validateLookDefinition, type LookDefinitionDiagnostic } from './validate.js';
export { compileLook, mapLookControl } from './compile.js';
export {
  LOOK_AUDIO_REACTIVE_VERSION,
  LOOK_AUDIO_MIN_CONFIDENCE,
  bakeAudioReactive,
  type LookAudioEnvelopeSample,
  type LookAudioEnvelope,
  type BakeAudioReactiveInput,
  type BakedKey,
  type BakeAudioReactiveResult,
} from './audio-reactive.js';
export { resolveLookAudioBakeTargets, type LookAudioBakeTarget } from './audio-bake-targets.js';
export {
  BUILT_IN_LOOK_PACKS,
  editorialClean,
  productPrecision,
  kineticType,
  quietDocumentary,
  musicPulse,
} from './packs/index.js';
