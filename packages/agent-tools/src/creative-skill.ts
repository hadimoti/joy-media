import { JOY_CODE_OPERATION_KINDS, type JoyCodeOperationKind } from './joy-code-plan.js';
import {
  canAdvertiseOperation,
  type JoyEditorOperationDefinition,
} from './editor-operation-definition.js';

/**
 * A recipe is a product-owned procedure, not a prompt, plugin, or authority.
 * It can describe the evidence and canonical operations it needs, but it can
 * never grant a model an operation, media egress approval, or commit right.
 */
export const CREATIVE_SKILL_IDS = [
  'creative-brief',
  'watch-and-map',
  'find-moment',
  'build-rough-cut',
  'title-and-caption-polish',
  'motion-and-transition-polish',
  'audio-balance',
  'verify-deliverable',
] as const;

export type CreativeSkillId = (typeof CREATIVE_SKILL_IDS)[number];

/** Runtime adapters that must be evidenced before a recipe can be advertised. */
export const CREATIVE_SKILL_CAPABILITIES = [
  'project-context',
  'canonical-prepare',
  'preview',
  'approval',
  'source-observation',
  'evidence-coverage',
  'bounded-source-moment',
  'transcript-evidence',
  'audio-analysis',
  'audio-mix',
  'rtl-text',
  'composition-capture',
  'encoded-output-verification',
] as const;
export type CreativeSkillCapability = (typeof CREATIVE_SKILL_CAPABILITIES)[number];

export const CREATIVE_EVIDENCE_REQUIREMENTS = [
  'none',
  'source-sampled',
  'source-exhaustive',
  'transcript',
  'audio-measured',
  'composition-rendered',
  'encoded-output',
] as const;
export type CreativeEvidenceRequirement = (typeof CREATIVE_EVIDENCE_REQUIREMENTS)[number];

export type CreativeSkillPrivacyRequirement = 'local-only' | 'explicit-media-consent';

export interface CreativeSkillProcedureCheckpoint {
  /** Stable, non-user-provided checkpoint identifier for activity/UI events. */
  readonly id: string;
  readonly title: string;
  readonly phase: 'inspect' | 'observe' | 'propose' | 'preview' | 'verify';
}

export interface CreativeSkillBudget {
  readonly maxObservationRequests: number;
  readonly maxEvidenceItems: number;
  readonly maxRepairProposals: number;
}

export interface CreativeSkillManifest {
  readonly id: CreativeSkillId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  /** Named host selectors rather than arbitrary project paths. */
  readonly contextSelectors: readonly string[];
  /** Only existing canonical plan operation kinds are allowed here. */
  readonly requiredOperationKinds: readonly JoyCodeOperationKind[];
  /** Verified runtime seams required before the recipe is selectable. */
  readonly requiredCapabilities: readonly CreativeSkillCapability[];
  readonly evidenceRequirements: readonly CreativeEvidenceRequirement[];
  readonly privacyRequirement: CreativeSkillPrivacyRequirement;
  readonly budget: CreativeSkillBudget;
  readonly procedure: readonly CreativeSkillProcedureCheckpoint[];
  readonly postconditions: readonly string[];
  /** Deterministic fixture IDs used for the owning skill regression. */
  readonly fixtureIds: readonly string[];
}

export interface CreativeSkillValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface CreativeSkillRuntime {
  readonly capabilities: readonly CreativeSkillCapability[];
  readonly operationDefinitions: readonly JoyEditorOperationDefinition[];
}

export interface CreativeSkillAvailability {
  readonly skill: CreativeSkillManifest;
  readonly available: boolean;
  readonly missingCapabilities: readonly CreativeSkillCapability[];
  readonly missingOperations: readonly JoyCodeOperationKind[];
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_CONTEXT_SELECTOR = /^[a-z][a-z0-9-]{1,63}$/;
const UNSAFE_MANIFEST_TEXT =
  /(?:https?:\/\/|(?:^|[^a-z])(?:file|blob|data):|\b(?:api[ _-]?key|authorization|bearer|password|secret|credential)\b|\b[A-Za-z]:[\\/])/i;
const OPERATION_KINDS = new Set<string>(JOY_CODE_OPERATION_KINDS);
const SKILL_IDS = new Set<string>(CREATIVE_SKILL_IDS);
const SKILL_CAPABILITIES = new Set<string>(CREATIVE_SKILL_CAPABILITIES);
const EVIDENCE_REQUIREMENTS = new Set<string>(CREATIVE_EVIDENCE_REQUIREMENTS);

const checkpoint = (
  id: string,
  title: string,
  phase: CreativeSkillProcedureCheckpoint['phase'],
): CreativeSkillProcedureCheckpoint => Object.freeze({ id, title, phase });

const skill = (input: CreativeSkillManifest): CreativeSkillManifest => Object.freeze(input);

/**
 * The eight R1 procedures. These manifests intentionally do not contain
 * natural-language provider instructions; the trusted skill runner supplies
 * bounded input and invokes the existing host/transaction boundary.
 */
export const CREATIVE_SKILLS: readonly CreativeSkillManifest[] = Object.freeze([
  skill({
    id: 'creative-brief',
    version: 1,
    title: 'Creative Brief',
    description: 'Turn the project goal and bounded context into a structured, reviewable brief.',
    contextSelectors: ['overview', 'brief', 'titles'],
    requiredOperationKinds: [],
    requiredCapabilities: ['project-context'],
    evidenceRequirements: ['none'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 0, maxEvidenceItems: 0, maxRepairProposals: 0 },
    procedure: [
      checkpoint('inspect-goal', 'Inspect the project goal and existing brief.', 'inspect'),
      checkpoint('structure-brief', 'Create a bounded structured brief artifact.', 'propose'),
    ],
    postconditions: ['produces-structured-brief', 'creates-no-editor-change'],
    fixtureIds: ['creative-brief-basic'],
  }),
  skill({
    id: 'watch-and-map',
    version: 1,
    title: 'Watch and Map',
    description: 'Build an evidence map from bounded source observations with explicit coverage.',
    contextSelectors: ['overview', 'assets', 'clips'],
    requiredOperationKinds: [],
    requiredCapabilities: ['project-context', 'source-observation', 'evidence-coverage'],
    evidenceRequirements: ['source-sampled'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 2, maxEvidenceItems: 128, maxRepairProposals: 0 },
    procedure: [
      checkpoint('inspect-sources', 'Identify source assets and requested ranges.', 'inspect'),
      checkpoint('observe-samples', 'Read bounded source samples.', 'observe'),
      checkpoint('record-coverage', 'Record evidence coverage and uncertainty.', 'verify'),
    ],
    postconditions: [
      'produces-evidence-map',
      'labels-sampled-coverage',
      'creates-no-editor-change',
    ],
    fixtureIds: ['single-frame-flash-vfr'],
  }),
  skill({
    id: 'find-moment',
    version: 1,
    title: 'Find Moment',
    description: 'Find a cited source interval without claiming unsupported media understanding.',
    contextSelectors: ['overview', 'assets', 'clips'],
    requiredOperationKinds: [],
    requiredCapabilities: [
      'project-context',
      'source-observation',
      'evidence-coverage',
      'bounded-source-moment',
    ],
    evidenceRequirements: ['source-exhaustive'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 2, maxEvidenceItems: 512, maxRepairProposals: 0 },
    procedure: [
      checkpoint('inspect-query', 'Resolve the requested source and search interval.', 'inspect'),
      checkpoint('observe-range', 'Inspect the bounded exact source interval.', 'observe'),
      checkpoint('cite-moment', 'Return a cited time range and coverage status.', 'verify'),
    ],
    postconditions: ['returns-cited-source-interval', 'creates-no-editor-change'],
    fixtureIds: ['single-frame-flash-vfr'],
  }),
  skill({
    id: 'build-rough-cut',
    version: 1,
    title: 'Build Rough Cut',
    description: 'Prepare a reversible rough-cut proposal from selected source ranges.',
    contextSelectors: ['overview', 'tracks', 'clips', 'assets'],
    requiredOperationKinds: [
      'timeline.insertExistingAsset',
      'timeline.trimClip',
      'timeline.moveClip',
    ],
    requiredCapabilities: [
      'project-context',
      'source-observation',
      'canonical-prepare',
      'preview',
      'approval',
    ],
    evidenceRequirements: ['source-sampled'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 2, maxEvidenceItems: 128, maxRepairProposals: 2 },
    procedure: [
      checkpoint('inspect-targets', 'Resolve selected source ranges and target tracks.', 'inspect'),
      checkpoint('observe-sources', 'Read requested source evidence.', 'observe'),
      checkpoint('prepare-rough-cut', 'Prepare typed timeline operations.', 'propose'),
      checkpoint('preview-rough-cut', 'Preview the immutable proposed edit.', 'preview'),
    ],
    postconditions: ['creates-prepared-change-only', 'requires-human-approval'],
    fixtureIds: ['rough-cut-source-range'],
  }),
  skill({
    id: 'title-and-caption-polish',
    version: 1,
    title: 'Title and Caption Polish',
    description: 'Prepare readable title and caption edits, including bounded RTL/keyframe work.',
    contextSelectors: ['overview', 'titles', 'clips', 'visual-objects'],
    requiredOperationKinds: [
      'text.setContent',
      'text.setTemplate',
      'caption.setSegmentText',
      'caption.setSegmentTiming',
      'caption.setTemplate',
      'motion.setKeyframe',
    ],
    requiredCapabilities: [
      'project-context',
      'transcript-evidence',
      'rtl-text',
      'canonical-prepare',
      'preview',
      'approval',
    ],
    evidenceRequirements: ['transcript', 'composition-rendered'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 1, maxEvidenceItems: 64, maxRepairProposals: 2 },
    procedure: [
      checkpoint('inspect-text', 'Inspect bounded title and caption context.', 'inspect'),
      checkpoint('prepare-readable-text', 'Prepare typed text and timing edits.', 'propose'),
      checkpoint(
        'preview-readable-text',
        'Preview text/keyframe changes before approval.',
        'preview',
      ),
    ],
    postconditions: [
      'creates-prepared-change-only',
      'preserves-rtl-text',
      'requires-human-approval',
    ],
    fixtureIds: ['persian-title-caption'],
  }),
  skill({
    id: 'motion-and-transition-polish',
    version: 1,
    title: 'Motion and Transition Polish',
    description:
      'Prepare precise motion and transition edits at existing property and junction targets.',
    contextSelectors: ['overview', 'clips', 'visual-objects'],
    requiredOperationKinds: [
      'motion.setKeyframe',
      'motion.removeKeyframe',
      'transition.addAtJunction',
      'transition.remove',
    ],
    requiredCapabilities: [
      'project-context',
      'composition-capture',
      'canonical-prepare',
      'preview',
      'approval',
    ],
    evidenceRequirements: ['composition-rendered'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 1, maxEvidenceItems: 32, maxRepairProposals: 2 },
    procedure: [
      checkpoint(
        'inspect-junctions',
        'Resolve existing properties and timeline junctions.',
        'inspect',
      ),
      checkpoint('prepare-motion', 'Prepare typed property and transition operations.', 'propose'),
      checkpoint('preview-motion', 'Inspect a frozen composed preview.', 'preview'),
    ],
    postconditions: ['creates-prepared-change-only', 'requires-human-approval'],
    fixtureIds: ['transition-boundary'],
  }),
  skill({
    id: 'audio-balance',
    version: 1,
    title: 'Audio Balance',
    description:
      'Measure bounded audio evidence and prepare an audio mix only through a verified adapter.',
    contextSelectors: ['overview', 'clips', 'assets'],
    requiredOperationKinds: [],
    requiredCapabilities: [
      'project-context',
      'audio-analysis',
      'audio-mix',
      'canonical-prepare',
      'preview',
      'approval',
    ],
    evidenceRequirements: ['audio-measured'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 1, maxEvidenceItems: 64, maxRepairProposals: 2 },
    procedure: [
      checkpoint('measure-audio', 'Measure bounded audio evidence and uncertainty.', 'observe'),
      checkpoint('prepare-mix', 'Prepare a mix proposal through the verified adapter.', 'propose'),
      checkpoint('preview-mix', 'Preview the prepared mix before approval.', 'preview'),
    ],
    postconditions: ['creates-prepared-change-only', 'requires-human-approval'],
    fixtureIds: ['audio-impulse-sync'],
  }),
  skill({
    id: 'verify-deliverable',
    version: 1,
    title: 'Verify Deliverable',
    description:
      'Check composed and encoded output against explicit render, audio, and export predicates.',
    contextSelectors: ['overview', 'clips', 'titles'],
    requiredOperationKinds: [],
    requiredCapabilities: ['project-context', 'composition-capture', 'encoded-output-verification'],
    evidenceRequirements: ['composition-rendered', 'encoded-output'],
    privacyRequirement: 'local-only',
    budget: { maxObservationRequests: 1, maxEvidenceItems: 64, maxRepairProposals: 0 },
    procedure: [
      checkpoint('capture-composition', 'Capture the frozen composed output.', 'observe'),
      checkpoint('verify-encoding', 'Verify final encoded media timing and tracks.', 'verify'),
    ],
    postconditions: ['returns-verification-status', 'creates-no-editor-change'],
    fixtureIds: ['encoded-output-title-audio'],
  }),
]);

export function getCreativeSkill(id: string): CreativeSkillManifest | undefined {
  return CREATIVE_SKILLS.find((skill) => skill.id === id);
}

/**
 * Validate static recipe data independently of host availability. This catches
 * accidental unsafe instructions or a renamed canonical operation before a
 * skill can appear in the agent UI.
 */
export function validateCreativeSkillManifest(value: unknown): CreativeSkillValidationResult {
  const errors: string[] = [];
  if (!isManifest(value)) return { valid: false, errors: ['invalid-manifest-shape'] };
  if (!SKILL_IDS.has(value.id)) errors.push('unknown-skill-id');
  if (value.version !== 1) errors.push('unsupported-skill-version');
  if (!isSafeText(value.title, 96) || !isSafeText(value.description, 512))
    errors.push('unsafe-skill-text');
  if (!isUniqueSafeIdentifiers(value.contextSelectors, SAFE_CONTEXT_SELECTOR, 12))
    errors.push('invalid-context-selectors');
  if (!isUniqueOperationKinds(value.requiredOperationKinds))
    errors.push('invalid-required-operations');
  if (!isUniqueCapabilities(value.requiredCapabilities))
    errors.push('invalid-required-capabilities');
  if (!isUniqueEvidenceRequirements(value.evidenceRequirements))
    errors.push('invalid-evidence-requirements');
  if (
    value.privacyRequirement !== 'local-only' &&
    value.privacyRequirement !== 'explicit-media-consent'
  )
    errors.push('invalid-privacy-requirement');
  if (!isValidBudget(value.budget)) errors.push('invalid-skill-budget');
  if (!isProcedure(value.procedure)) errors.push('invalid-skill-procedure');
  if (!isUniqueSafeIdentifiers(value.postconditions, SAFE_IDENTIFIER, 12))
    errors.push('invalid-postconditions');
  if (!isUniqueSafeIdentifiers(value.fixtureIds, SAFE_IDENTIFIER, 12))
    errors.push('invalid-fixtures');
  return { valid: errors.length === 0, errors: Object.freeze(errors) };
}

/**
 * Computes availability from verified seams only. A manifest is not runnable
 * merely because its title is present, and unsupported audio/encoder paths
 * therefore stay visible-but-unavailable instead of being a false promise.
 */
export function resolveCreativeSkillAvailability(
  runtime: CreativeSkillRuntime,
  skills: readonly CreativeSkillManifest[] = CREATIVE_SKILLS,
): readonly CreativeSkillAvailability[] {
  const capabilities = new Set<string>(runtime.capabilities);
  const operationDefinitions = new Map(
    runtime.operationDefinitions.map((definition) => [definition.kind, definition]),
  );
  return Object.freeze(
    skills.map((candidate) => {
      const validation = validateCreativeSkillManifest(candidate);
      const missingCapabilities = candidate.requiredCapabilities.filter(
        (capability) => !capabilities.has(capability),
      );
      const missingOperations = candidate.requiredOperationKinds.filter((kind) => {
        const definition = operationDefinitions.get(kind);
        return definition === undefined || !canAdvertiseOperation(definition.evidence);
      });
      return Object.freeze({
        skill: candidate,
        available:
          validation.valid && missingCapabilities.length === 0 && missingOperations.length === 0,
        missingCapabilities: Object.freeze([...missingCapabilities]),
        missingOperations: Object.freeze([...missingOperations]),
      });
    }),
  );
}

function isManifest(value: unknown): value is CreativeSkillManifest {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !UNSAFE_MANIFEST_TEXT.test(value)
  );
}

function isUniqueSafeIdentifiers(
  value: unknown,
  expression: RegExp,
  maximum: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.every((item) => typeof item === 'string' && expression.test(item)) &&
    new Set(value).size === value.length
  );
}

function isUniqueOperationKinds(value: unknown): value is readonly JoyCodeOperationKind[] {
  return (
    Array.isArray(value) &&
    value.length <= JOY_CODE_OPERATION_KINDS.length &&
    value.every((item) => typeof item === 'string' && OPERATION_KINDS.has(item)) &&
    new Set(value).size === value.length
  );
}

function isUniqueCapabilities(value: unknown): value is readonly CreativeSkillCapability[] {
  return (
    Array.isArray(value) &&
    value.length <= CREATIVE_SKILL_CAPABILITIES.length &&
    value.every((item) => typeof item === 'string' && SKILL_CAPABILITIES.has(item)) &&
    new Set(value).size === value.length
  );
}

function isUniqueEvidenceRequirements(
  value: unknown,
): value is readonly CreativeEvidenceRequirement[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CREATIVE_EVIDENCE_REQUIREMENTS.length &&
    value.every((item) => typeof item === 'string' && EVIDENCE_REQUIREMENTS.has(item)) &&
    new Set(value).size === value.length
  );
}

function isValidBudget(value: unknown): value is CreativeSkillBudget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    isBoundedInteger(record.maxObservationRequests, 0, 8) &&
    isBoundedInteger(record.maxEvidenceItems, 0, 512) &&
    isBoundedInteger(record.maxRepairProposals, 0, 2)
  );
}

function isProcedure(value: unknown): value is readonly CreativeSkillProcedureCheckpoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false;
  const ids = new Set<string>();
  for (const checkpoint of value) {
    if (
      checkpoint === null ||
      typeof checkpoint !== 'object' ||
      Array.isArray(checkpoint) ||
      !isSafeIdentifier((checkpoint as Record<string, unknown>).id) ||
      !isSafeText((checkpoint as Record<string, unknown>).title, 128) ||
      !['inspect', 'observe', 'propose', 'preview', 'verify'].includes(
        (checkpoint as Record<string, unknown>).phase as string,
      )
    )
      return false;
    ids.add((checkpoint as CreativeSkillProcedureCheckpoint).id);
  }
  return ids.size === value.length;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
