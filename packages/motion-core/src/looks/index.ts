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
  type LookCompileInput,
  type LookCompileResult,
} from './types.js';
export { validateLookDefinition, type LookDefinitionDiagnostic } from './validate.js';
export { compileLook, mapLookControl } from './compile.js';
export {
  BUILT_IN_LOOK_PACKS,
  editorialClean,
  productPrecision,
  kineticType,
  quietDocumentary,
  musicPulse,
  persianEditorial,
} from './packs/index.js';
