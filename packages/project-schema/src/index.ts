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
  TimelineTrackFamily,
  TimelineTrackLabelColor,
  SpikeProject,
  Composition,
  Track,
  Clip,
  VideoClip,
  TimeRemapV2,
  TimeRemapKeyframe,
  CompositionClip,
  ProjectDiagnostic,
} from './model.js';
export {
  validateSpikeProject,
  normalizePlaybackRate,
  isValidPlaybackRate,
  sourceTimeAtVideoClipTime,
  validateTimeRemap,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  TIMELINE_TRACK_LABEL_COLORS,
  isTimelineTrackLabelColor,
} from './model.js';

export type { TimelineTrackDeckRow, TimelineTrackDeckDocument } from './timeline-track-deck.js';
export { validateTimelineTrackDeckDocument } from './timeline-track-deck.js';

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
  AssetDescriptorV1,
  AnimationDescriptorV1,
  GenerationProvenanceV1,
  MarkerV1,
  ProjectAudioClipV1,
  ProjectAudioBusV1,
  ProjectAudioEffectV1,
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
export type { CaptionClipStyleV2, CaptionClipStylePropertyId } from './caption-style.js';
export {
  IDENTITY_CAPTION_CLIP_STYLE,
  captionClipStylePropertyBinding,
  isCaptionClipStyleV2,
  normalizeCaptionClipStyle,
} from './caption-style.js';
export type {
  TextDirectionV1,
  TextAlignV1,
  TextBlendModeV1,
  TextGradientStopV1,
  TextFillV1,
  TextStrokeV1,
  TextShadowV1,
  TextGlowV1,
  TextStyleV1,
  TextRunStyleV1,
  TextRunV1,
  TextBlockV1,
  TextDocumentV1,
} from './text-style.js';
export {
  DEFAULT_TEXT_STYLE_V1,
  textDocumentFromString,
  textDocumentToString,
} from './text-style.js';
export type {
  ColorAdjustments,
  ColorWheel,
  ColorWheels,
  ColorCurveChannel,
  ColorCurvePoint,
  ColorCurves,
  HslBandId,
  HslBand,
  ColorLutReference,
  EncodedColorLutReference,
  OutputSafety,
  ColorGradeV2,
  ColorGrade,
  ColorPropertyScopeV2,
  ColorPropertyValueKindV2,
  ColorPropertyDescriptorV2,
} from './color.js';
export {
  IDENTITY_COLOR_ADJUSTMENTS,
  IDENTITY_COLOR_WHEEL,
  IDENTITY_COLOR_WHEELS,
  IDENTITY_COLOR_CURVES,
  COLOR_CURVE_SNAPSHOT_SAMPLES,
  HSL_BAND_IDS,
  IDENTITY_HSL_BANDS,
  COLOR_PROPERTY_DESCRIPTORS,
  createIdentityColorGrade,
  isColorGradeV2,
  findColorPropertyDescriptor,
  colorPropertyBinding,
  assertColorPropertyDescriptorCoverage,
  colorCurveToSnapshot,
  colorCurveFromSnapshot,
  normalizeColorCurvePoints,
  colorLutReferenceIdentity,
  encodeColorLutReference,
  decodeColorLutReference,
  isColorLutReferenceAvailable,
} from './color.js';
export type {
  AudioAutomationDescriptor,
  AudioBusPropertyId,
  AudioClipPropertyId,
} from './audio.js';
export {
  AUDIO_AUTOMATION_DESCRIPTORS,
  audioAutomationDescriptor,
  audioBusPropertyBinding,
  audioClipPropertyBinding,
  audioEffectPropertyBinding,
} from './audio.js';
export { validateJoyProjectV1, validateAnimationCurve, ANIMATABLE_PROPERTIES } from './v1.js';
export type {
  PropertyOwnerKindV2,
  AnimationTimeDomainV2,
  PropertyBindingV2,
  DiscreteKeyV2,
  CurveSnapshotKeyV2,
  AnimationValueV2,
  PropertyAnimationV2,
} from './property-animation.js';
export {
  PROPERTY_OWNER_KINDS,
  PROPERTY_TIME_DOMAINS,
  canonicalBindingKey,
  normalizePropertyAnimations,
  validatePropertyAnimations,
} from './property-animation.js';
export type {
  NormalizedPropertyAnimationsV2,
  NormalizePropertyAnimationsResult,
  PropertyOwnerResolverV2,
} from './property-animation.js';
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
  WorkflowGroupV2,
  WorkflowGraphV2,
  AgentAssignmentV2,
  NodeExecutionPolicyV2,
} from './creative.js';
export {
  ANY_PORT_TYPE,
  arePortsCompatible,
  CREATIVE_CAPABILITIES,
  ESCALATED_CAPABILITIES,
  CREATIVE_ARTIFACT_KINDS,
  RENDERABLE_ARTIFACT_KINDS,
  WORKFLOW_NODE_STATUSES,
  CREATIVE_ARTIFACT_SCHEMA_VERSION,
  WORKFLOW_GRAPH_SCHEMA_VERSION,
  EMPTY_WORKFLOW_GRAPH,
  isRenderableArtifactKind,
  selectRenderableArtifacts,
  validateTemporalBinding,
  validateArtifactContentRef,
  validateArtifactProvenance,
  validateCreativeArtifact,
  validateWorkflowGraph,
} from './creative.js';

export type { JoyProjectV2, AnyJoyProject } from './v2.js';
export { LATEST_PROJECT_SCHEMA_VERSION, isJoyProjectV2, validateJoyProjectV2 } from './v2.js';

export type {
  TimelineElementKind,
  TimelinePlacementKind,
  UniversalTimelineSource,
  UniversalTimelineItem,
  UniversalTimelineDocument,
  NormalizedUniversalTimelineItem,
  NormalizedUniversalTimeline,
} from './universal-timeline.js';
export {
  UNIVERSAL_TIMELINE_SCHEMA_VERSION,
  UNIVERSAL_TIMELINE_LATEST_SCHEMA_VERSION,
  TIMELINE_ELEMENT_KINDS,
  validateUniversalTimelineDocument,
  normalizeUniversalTimeline,
  universalTimelineForProject,
} from './universal-timeline.js';
export { mixedElementTimelineFixture } from './universal-timeline-fixture.js';

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
