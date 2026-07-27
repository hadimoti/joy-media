/**
 * @joy-media/project-schema — versioned creative document schema and migrations.
 *
 * WP-00.1 state: durable time primitives (ADR-0002) and the P00 spike subset of
 * the project model. Schema v1 + migrations land in P01 (WP-01.1).
 */
export const PACKAGE_NAME = '@joy-media/project-schema' as const;

export type { TimeUs, Rational, TimeRange } from './time.js';
export {
  rational,
  normalizeRational,
  rationalsEqual,
  compareRationals,
  frameStartUs,
  frameIndexAtUs,
  snapUsToFrame,
  timeRange,
  clipTimeRange,
  rangeEndUs,
  rangeContainsUs,
  intersectRanges,
} from './time.js';

export type {
  ProjectId,
  CompositionId,
  TrackId,
  ClipId,
  AssetId,
  SpikeProject,
  Composition,
  Track,
  Clip,
  VideoClip,
  CompositionClip,
  ProjectDiagnostic,
} from './model.js';
export {
  validateSpikeProject,
  normalizePlaybackRate,
  isValidPlaybackRate,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
} from './model.js';

export type {
  JoyProjectV1,
  CompositionV1,
  TrackV1,
  ClipV1,
  VideoClipV1,
  CompositionClipV1,
  CaptionClipV1,
  CaptionWordV1,
  CaptionSegmentV1,
  CaptionSpeakerV1,
  CaptionDocumentV1,
  AssetRecordV1,
  GenerationProvenanceV1,
  MarkerV1,
  ProjectAudioV1,
  ColorGradeV1,
  TransitionV1,
  ExportPresetId,
  VisualObjectV1,
  VisualObjectTransformV1,
  CameraParamsV1,
  AnimatablePropertyV1,
  KeyframeInterpolationV1,
  BezierHandlesV1,
  KeyframeV1,
  AnimationCurveV1,
  SpatialKeyframe,
  SpatialPathV1,
  Vec2,
  MotionBlurV1,
  JsonValue,
  EffectParamValue,
  EffectInstanceV1,
} from './v1.js';
export { validateJoyProjectV1, validateAnimationCurve, ANIMATABLE_PROPERTIES } from './v1.js';
export type {
  CreativeCapability,
  CreativeArtifactKind,
  CreativeArtifactV2,
  ArtifactVersionV2,
  ArtifactContentRef,
  ArtifactProvenance,
  CreativeActorRef,
  TemporalBinding,
  WorkflowNodeStatus,
  WorkflowPortV2,
  WorkflowNodeV2,
  WorkflowEdgeV2,
  WorkflowGraphV2,
  AgentAssignmentV2,
  NodeExecutionPolicyV2,
} from './creative.js';
export {
  CREATIVE_CAPABILITIES,
  ESCALATED_CAPABILITIES,
  CREATIVE_ARTIFACT_KINDS,
  RENDERABLE_ARTIFACT_KINDS,
  WORKFLOW_NODE_STATUSES,
  CREATIVE_ARTIFACT_SCHEMA_VERSION,
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  EMPTY_WORKFLOW_GRAPH,
  isRenderableArtifactKind,
  validateTemporalBinding,
  validateArtifactContentRef,
  validateArtifactProvenance,
  validateCreativeArtifact,
  validateWorkflowGraph,
} from './creative.js';

export type { JoyProjectV2, AnyJoyProject } from './v2.js';
export { LATEST_PROJECT_SCHEMA_VERSION, isJoyProjectV2, validateJoyProjectV2 } from './v2.js';

export type { DualLensFlags, FlagSource } from './dual-lens-flag.js';
export {
  DUAL_LENS_FLAG_KEY,
  DUAL_LENS_FLAGS_OFF,
  readDualLensFlags,
  projectWithoutDualLens,
  applyDualLensFlags,
} from './dual-lens-flag.js';

export type {
  MigrationReport,
  MigrationResult,
  V2MigrationReport,
  V2MigrationResult,
} from './migration.js';
export { migrateV0ToV1, migrateV1ToV2, migrateToLatest } from './migration.js';

export type {
  VoiceIdentity,
  ConsentRecord,
  ConsentCheckResult,
  VoiceStatus,
  ProviderVoiceRef,
} from './voice-identity.js';
