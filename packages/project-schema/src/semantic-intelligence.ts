/**
 * Semantic Intelligence V1 - Deterministic Scene and Brand Intelligence
 * WP-37 S2: Deterministic Scene and Brand Intelligence
 *
 * Pure, deterministic derivation of readiness and coverage from SemanticProjectSnapshotV1.
 * No LLM calls, no network, no persistence, no secrets.
 */

import type { TimeUs } from './time.js';
import type {
  SemanticProjectSnapshotV1,
  SceneSummaryV1,
  EvidenceRefV1,
} from './semantic-snapshot.js';

// ==========================================================================
// S2 Types
// ==========================================================================

/** Severity levels for rules and readiness issues */
export type IntelligenceSeverity = 'info' | 'suggestion' | 'warning' | 'error';

/** Stable rule identifier - deterministic and versioned */
export type RuleId = string;

/**
 * Evidence reference for S2 rules - references snapshot evidence or
 * derives new evidence from snapshot analysis
 */
export interface IntelligenceEvidenceRefV1 extends EvidenceRefV1 {
  /** Optional detail about what this evidence represents */
  readonly detail?: string;
}

/**
 * Rule categories for organizing rules
 */
export type RuleCategory =
  | 'brand'
  | 'visual-coverage'
  | 'audio-coverage'
  | 'caption-coverage'
  | 'destination'
  | 'capability';

/**
 * A deterministic rule that identifies a project/scenes condition.
 * Rules are factual, explainable, and never contain subjective creative judgments.
 */
export interface IntelligenceRuleV1 {
  /** Stable, deterministic rule identifier */
  readonly ruleId: RuleId;
  /** Severity of this rule's finding */
  readonly severity: IntelligenceSeverity;
  /** Category for organizing rules */
  readonly category: RuleCategory;
  /** Scope: which project or scene this applies to */
  readonly projectId: string;
  /** Optional scene ID if rule is scene-scoped */
  readonly sceneId?: string;
  /** Evidence supporting this rule's activation */
  readonly evidence: readonly IntelligenceEvidenceRefV1[];
  /** User-facing explanation of what was found */
  readonly message: string;
  /**
   * Optional non-executable suggested intent.
   * This is a hint for what action might address the finding,
   * but it is never a command payload or executable instruction.
   */
  readonly suggestedIntent?: string;
}

/**
 * All known rule IDs - deterministic catalog
 */
export const KNOWN_RULE_IDS = {
  // Brand rules
  BRAND_MISSING_COLORS: 'brand.missing.colors' as const,
  BRAND_MISSING_FONTS: 'brand.missing.fonts' as const,
  BRAND_MISSING_LOGO: 'brand.missing.logo' as const,
  BRAND_MISSING_VOICE_INSTRUCTIONS: 'brand.missing.voice-instructions' as const,
  BRAND_MISSING_TONE_INSTRUCTIONS: 'brand.missing.tone-instructions' as const,
  BRAND_MISSING_COMPONENTS: 'brand.missing.components' as const,
  BRAND_NO_KIT: 'brand.no-kit' as const,

  // Visual coverage rules
  VISUAL_COVERAGE_SPARSE_DURING_NARRATION: 'scene.visual-coverage.sparse-during-narration' as const,
  VISUAL_COVERAGE_NONE: 'scene.visual-coverage.none' as const,
  VISUAL_CHANGE_SIGNAL_MISSING: 'scene.visual-change.signal-missing' as const,

  // Caption coverage rules
  CAPTION_MISSING_WHERE_NARRATION_EXISTS: 'scene.caption.missing-where-narration-exists' as const,
  CAPTION_COVERAGE_GAP: 'scene.caption.coverage-gap' as const,
  CAPTION_MISSING: 'scene.caption.missing' as const,

  // Audio coverage rules
  AUDIO_MISSING_WHERE_VISUAL_EXISTS: 'scene.audio.missing-where-visual-exists' as const,
  AUDIO_GAP: 'scene.audio.gap' as const,

  // Destination/aspect rules
  DESTINATION_MISMATCH: 'project.destination.mismatch' as const,
  ASPECT_RATIO_MISMATCH: 'project.aspect-ratio.mismatch' as const,
  DURATION_MISMATCH: 'project.duration.mismatch' as const,

  // Capability rules
  CAPABILITY_SETUP_REQUIRED: 'project.capability.setup-required' as const,
  CAPABILITY_UNAVAILABLE: 'project.capability.unavailable' as const,
} as const;

/** All known rule IDs as a type */
export type KnownRuleId = (typeof KNOWN_RULE_IDS)[keyof typeof KNOWN_RULE_IDS];

/**
 * Brand readiness describes which canonical brand fields are available
 * in the project snapshot. It reports truthfully on missing/unavailable data.
 */
export interface BrandReadinessV1 {
  readonly projectId: string;
  readonly revisionId: string;

  // Core brand kit availability
  readonly colorsAvailable: boolean;
  readonly fontsAvailable: boolean;
  readonly logoAvailable: boolean;

  // Voice/tone guidance
  readonly voiceInstructionsAvailable: boolean;
  readonly toneInstructionsAvailable: boolean;

  // Constraints/guidelines
  readonly prohibitedClaims: readonly string[];
  readonly prohibitedEffects: readonly string[];

  // Overall state
  readonly hasBrandKit: boolean;
  readonly brandCompleteness: 'none' | 'partial' | 'complete';

  /** Missing brand components that should be present for full brand support */
  readonly missingComponents: readonly (
    | 'colors'
    | 'fonts'
    | 'logo'
    | 'voice-instructions'
    | 'tone-instructions'
    | 'prohibited-claims'
    | 'prohibited-effects'
  )[];

  /** Warnings about brand data issues */
  readonly warnings: readonly IntelligenceRuleV1[];

  /** Evidence references for brand readiness claims */
  readonly evidence: readonly IntelligenceEvidenceRefV1[];
}

/**
 * Scene coverage describes the visual, audio, and caption characteristics
 * of a single scene, derived deterministically from the snapshot.
 */
export interface SceneCoverageV1 {
  readonly sceneId: string;
  readonly projectId: string;

  // Temporal characteristics
  readonly startUs: TimeUs;
  readonly endUs: TimeUs;
  readonly durationUs: TimeUs;

  // Visual characteristics
  readonly visualElementCount: number;
  readonly visualDensity: 'none' | 'sparse' | 'adequate' | 'dense';
  readonly hasVisualElements: boolean;

  // Audio characteristics
  readonly hasAudio: boolean;
  readonly hasNarration: boolean;
  readonly audioDurationUs: TimeUs;
  readonly narrationDurationUs: TimeUs;

  // Caption characteristics
  readonly hasCaptions: boolean;
  readonly captionWordCount: number;
  readonly captionLocale: string | undefined;
  readonly captionCoverageRatio: number; // 0.0 to 1.0

  // Coverage signals
  readonly visualChangeSignals: readonly TimeUs[];
  readonly audioGaps: readonly { startUs: TimeUs; endUs: TimeUs; durationUs: TimeUs }[];
  readonly captionGaps: readonly { startUs: TimeUs; endUs: TimeUs; durationUs: TimeUs }[];

  // Evidence for coverage claims
  readonly evidence: readonly IntelligenceEvidenceRefV1[];

  /** Rules triggered for this specific scene */
  readonly rules: readonly IntelligenceRuleV1[];
}

/**
 * Project readiness describes the overall state of the project for
 * creative workflows, based on destination, aspect ratio, duration,
 * and capability alignment.
 */
export interface ProjectReadinessV1 {
  readonly projectId: string;
  readonly revisionId: string;

  // Destination alignment (from snapshot.goal)
  readonly destination: string | undefined;
  readonly destinationAligned: boolean;
  readonly destinationMismatch: { expected: string; actual: string } | undefined;

  // Duration alignment
  readonly durationTargetUs: TimeUs | undefined;
  readonly compositionDurationUs: TimeUs;
  readonly durationAligned: boolean;
  readonly durationGapUs: TimeUs | undefined; // positive = too short, negative = too long

  // Aspect ratio alignment
  readonly aspectRatio: string;
  readonly aspectRatioAligned: boolean;
  readonly aspectRatioMismatch: { expected: string; actual: string } | undefined;

  // Capability state
  readonly captionAvailable: boolean;
  readonly audioAvailable: boolean;
  readonly generatedAssetsAvailable: boolean;

  // Overall readiness
  readonly readinessLevel: 'unknown' | 'setup-required' | 'partial' | 'ready';
  readonly blockers: readonly IntelligenceRuleV1[];
  readonly warnings: readonly IntelligenceRuleV1[];

  // Aggregated coverage
  readonly sceneCount: number;
  readonly scenesWithVisuals: number;
  readonly scenesWithAudio: number;
  readonly scenesWithCaptions: number;

  // Evidence for readiness claims
  readonly evidence: readonly IntelligenceEvidenceRefV1[];
}

/**
 * Rule definition template for creating rules.
 * All rules must have deterministic activation based on snapshot data.
 */
interface RuleDefinition {
  readonly ruleId: KnownRuleId;
  readonly category: RuleCategory;
  readonly severity: IntelligenceSeverity;
  /**
   * Deterministic check function - returns true if rule should be triggered
   * for the given snapshot/scene combination
   */
  readonly check: (snapshot: SemanticProjectSnapshotV1, scene?: SceneSummaryV1) => boolean;
  /**
   * Create the rule instance with evidence from the snapshot
   */
  readonly createRule: (
    snapshot: SemanticProjectSnapshotV1,
    scene?: SceneSummaryV1,
  ) => IntelligenceRuleV1 | null;
}

// ==========================================================================
// Rule Catalog
// ==========================================================================

/** The complete deterministic rule catalog for S2 */
const ruleCatalog: readonly RuleDefinition[] = [
  // Brand Rules
  {
    ruleId: KNOWN_RULE_IDS.BRAND_NO_KIT,
    category: 'brand',
    severity: 'warning',
    check: (snapshot) => !snapshot.brand.hasBrandKit,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_NO_KIT,
      severity: 'warning',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [{ id: snapshot.projectId, kind: 'composition' }],
      message: 'No brand kit data found in project',
      suggestedIntent: 'add-brand-kit',
    }),
  },
  {
    ruleId: KNOWN_RULE_IDS.BRAND_MISSING_COLORS,
    category: 'brand',
    severity: 'suggestion',
    check: (snapshot) => snapshot.brand.hasBrandKit && !snapshot.brand.colorsAvailable,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_MISSING_COLORS,
      severity: 'suggestion',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [{ id: snapshot.projectId, kind: 'composition', detail: 'brand.colors' }],
      message: 'Brand kit is missing color definitions',
      suggestedIntent: 'add-brand-colors',
    }),
  },
  {
    ruleId: KNOWN_RULE_IDS.BRAND_MISSING_FONTS,
    category: 'brand',
    severity: 'suggestion',
    check: (snapshot) => snapshot.brand.hasBrandKit && !snapshot.brand.fontsAvailable,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_MISSING_FONTS,
      severity: 'suggestion',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [{ id: snapshot.projectId, kind: 'composition', detail: 'brand.fonts' }],
      message: 'Brand kit is missing font definitions',
      suggestedIntent: 'add-brand-fonts',
    }),
  },
  {
    ruleId: KNOWN_RULE_IDS.BRAND_MISSING_LOGO,
    category: 'brand',
    severity: 'suggestion',
    check: (snapshot) => snapshot.brand.hasBrandKit && !snapshot.brand.logoAvailable,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_MISSING_LOGO,
      severity: 'suggestion',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [{ id: snapshot.projectId, kind: 'composition', detail: 'brand.logo' }],
      message: 'Brand kit is missing logo asset',
      suggestedIntent: 'add-brand-logo',
    }),
  },
  {
    ruleId: KNOWN_RULE_IDS.BRAND_MISSING_VOICE_INSTRUCTIONS,
    category: 'brand',
    severity: 'suggestion',
    check: (snapshot) => snapshot.brand.hasBrandKit && !snapshot.brand.voiceInstructionsAvailable,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_MISSING_VOICE_INSTRUCTIONS,
      severity: 'suggestion',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [
        { id: snapshot.projectId, kind: 'composition', detail: 'brand.voice-instructions' },
      ],
      message: 'Brand kit is missing voice/tone instructions',
      suggestedIntent: 'add-brand-voice-instructions',
    }),
  },
  {
    ruleId: KNOWN_RULE_IDS.BRAND_MISSING_TONE_INSTRUCTIONS,
    category: 'brand',
    severity: 'suggestion',
    check: (snapshot) => snapshot.brand.hasBrandKit && !snapshot.brand.toneInstructionsAvailable,
    createRule: (snapshot) => ({
      ruleId: KNOWN_RULE_IDS.BRAND_MISSING_TONE_INSTRUCTIONS,
      severity: 'suggestion',
      category: 'brand',
      projectId: snapshot.projectId,
      evidence: [
        { id: snapshot.projectId, kind: 'composition', detail: 'brand.tone-instructions' },
      ],
      message: 'Brand kit is missing tone/style instructions',
      suggestedIntent: 'add-brand-tone-instructions',
    }),
  },

  // Scene Visual Coverage Rules
  {
    ruleId: KNOWN_RULE_IDS.VISUAL_COVERAGE_NONE,
    category: 'visual-coverage',
    severity: 'warning',
    check: (snapshot, scene) => scene !== undefined && scene.visualCoverage === 'none',
    createRule: (snapshot, scene) => {
      if (!scene) return null;
      return {
        ruleId: KNOWN_RULE_IDS.VISUAL_COVERAGE_NONE,
        severity: 'warning',
        category: 'visual-coverage',
        projectId: snapshot.projectId,
        sceneId: scene.id,
        evidence: scene.evidence,
        message: `Scene "${scene.id}" has no visual elements`,
        suggestedIntent: 'add-visual-content',
      };
    },
  },
  {
    ruleId: KNOWN_RULE_IDS.VISUAL_COVERAGE_SPARSE_DURING_NARRATION,
    category: 'visual-coverage',
    severity: 'suggestion',
    check: (snapshot, scene) => {
      if (!scene) return false;
      const hasNarration = scene.narration?.hasNarration ?? false;
      const isSparseVisual = scene.visualCoverage === 'sparse' || scene.visualCoverage === 'none';
      return hasNarration && isSparseVisual && scene.endUs - scene.startUs > 0;
    },
    createRule: (snapshot, scene) => {
      if (!scene) return null;
      const narrationDuration = scene.narration?.durationUs ?? 0;
      if (narrationDuration === 0) return null;

      return {
        ruleId: KNOWN_RULE_IDS.VISUAL_COVERAGE_SPARSE_DURING_NARRATION,
        severity: 'suggestion',
        category: 'visual-coverage',
        projectId: snapshot.projectId,
        sceneId: scene.id,
        evidence: scene.evidence,
        message: `Narration runs for ${formatDurationUs(narrationDuration)} without adequate visual coverage in scene "${scene.id}"`,
        suggestedIntent: 'consider-broll-or-motion',
      };
    },
  },

  // Caption Coverage Rules
  {
    ruleId: KNOWN_RULE_IDS.CAPTION_MISSING_WHERE_NARRATION_EXISTS,
    category: 'caption-coverage',
    severity: 'suggestion',
    check: (snapshot, scene) => {
      if (!scene) return false;
      const hasNarration = scene.narration?.hasNarration ?? false;
      const hasCaptions = scene.captionCoverage?.hasCaptions ?? false;
      return hasNarration && !hasCaptions;
    },
    createRule: (snapshot, scene) => {
      if (!scene) return null;
      const narrationDuration = scene.narration?.durationUs ?? 0;
      if (narrationDuration === 0) return null;

      return {
        ruleId: KNOWN_RULE_IDS.CAPTION_MISSING_WHERE_NARRATION_EXISTS,
        severity: 'suggestion',
        category: 'caption-coverage',
        projectId: snapshot.projectId,
        sceneId: scene.id,
        evidence: scene.evidence,
        message: `Narration present but no captions in scene "${scene.id}" (${formatDurationUs(narrationDuration)})`,
        suggestedIntent: 'add-captions',
      };
    },
  },
  {
    ruleId: KNOWN_RULE_IDS.CAPTION_MISSING,
    category: 'caption-coverage',
    severity: 'suggestion',
    check: (snapshot, scene) => {
      if (!scene) return false;
      const hasVisualOrAudio = scene.elements.some((e) => e.hasVisual || e.hasAudio);
      const hasCaptions = scene.captionCoverage?.hasCaptions ?? false;
      return hasVisualOrAudio && !hasCaptions;
    },
    createRule: (snapshot, scene) => {
      if (!scene) return null;
      return {
        ruleId: KNOWN_RULE_IDS.CAPTION_MISSING,
        severity: 'suggestion',
        category: 'caption-coverage',
        projectId: snapshot.projectId,
        sceneId: scene.id,
        evidence: scene.evidence,
        message: `Scene "${scene.id}" has visual/audio content but no captions`,
        suggestedIntent: 'add-captions',
      };
    },
  },

  // Project Alignment Rules
  {
    ruleId: KNOWN_RULE_IDS.DESTINATION_MISMATCH,
    category: 'destination',
    severity: 'warning',
    check: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.destination) return false;
      const expectedAspect = destinationToAspectRatio(goal.destination);
      if (!expectedAspect) return false;
      return snapshot.composition.aspectRatio !== expectedAspect;
    },
    createRule: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.destination) return null;
      const expectedAspect = destinationToAspectRatio(goal.destination);
      if (!expectedAspect) return null;

      return {
        ruleId: KNOWN_RULE_IDS.DESTINATION_MISMATCH,
        severity: 'warning',
        category: 'destination',
        projectId: snapshot.projectId,
        evidence: [
          { id: snapshot.composition.aspectRatio, kind: 'composition', detail: 'aspect-ratio' },
        ],
        message: `Composition aspect ratio "${snapshot.composition.aspectRatio}" does not match expected "${expectedAspect}" for destination "${goal.destination}"`,
        suggestedIntent: 'adjust-aspect-ratio',
      };
    },
  },
  {
    ruleId: KNOWN_RULE_IDS.DURATION_MISMATCH,
    category: 'destination',
    severity: 'warning',
    check: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.durationTargetUs) return false;
      return snapshot.composition.durationUs !== goal.durationTargetUs;
    },
    createRule: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.durationTargetUs) return null;

      const gapUs = goal.durationTargetUs - snapshot.composition.durationUs;
      const gapMs = gapUs / 1000;
      const isShort = gapUs > 0;

      return {
        ruleId: KNOWN_RULE_IDS.DURATION_MISMATCH,
        severity: 'warning',
        category: 'destination',
        projectId: snapshot.projectId,
        evidence: [
          {
            id: snapshot.composition.durationUs.toString(),
            kind: 'composition',
            detail: 'duration',
          },
        ],
        message: `Composition duration ${formatDurationUs(snapshot.composition.durationUs)} is ${isShort ? 'shorter' : 'longer'} than target ${formatDurationUs(goal.durationTargetUs)} by ${Math.abs(gapMs).toFixed(0)}ms`,
        suggestedIntent: 'adjust-duration',
      };
    },
  },
  {
    ruleId: KNOWN_RULE_IDS.ASPECT_RATIO_MISMATCH,
    category: 'destination',
    severity: 'warning',
    check: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.destination) return false;
      const expectedAspect = destinationToAspectRatio(goal.destination);
      if (!expectedAspect) return false;
      return snapshot.composition.aspectRatio !== expectedAspect;
    },
    createRule: (snapshot) => {
      const goal = snapshot.goal;
      if (!goal?.destination) return null;
      const expectedAspect = destinationToAspectRatio(goal.destination);
      if (!expectedAspect) return null;

      return {
        ruleId: KNOWN_RULE_IDS.ASPECT_RATIO_MISMATCH,
        severity: 'warning',
        category: 'destination',
        projectId: snapshot.projectId,
        evidence: [
          { id: snapshot.composition.aspectRatio, kind: 'composition', detail: 'aspect-ratio' },
        ],
        message: `Aspect ratio "${snapshot.composition.aspectRatio}" does not match expected "${expectedAspect}" for destination "${goal.destination}"`,
        suggestedIntent: 'adjust-composition-aspect',
      };
    },
  },

  // Capability Rules
  {
    ruleId: KNOWN_RULE_IDS.CAPABILITY_SETUP_REQUIRED,
    category: 'capability',
    severity: 'info',
    check: (snapshot) => {
      return Object.values(snapshot.capabilities).some((c) => c === 'setup-required');
    },
    createRule: (snapshot) => {
      const setupRequired = Object.entries(snapshot.capabilities)
        .filter(([_, status]) => status === 'setup-required')
        .map(([cap, _]) => cap);

      return {
        ruleId: KNOWN_RULE_IDS.CAPABILITY_SETUP_REQUIRED,
        severity: 'info',
        category: 'capability',
        projectId: snapshot.projectId,
        evidence: [{ id: 'capabilities', kind: 'composition', detail: 'setup-required' }],
        message: `Project requires setup for: ${setupRequired.join(', ')}`,
        suggestedIntent: 'configure-capabilities',
      };
    },
  },
  {
    ruleId: KNOWN_RULE_IDS.CAPABILITY_UNAVAILABLE,
    category: 'capability',
    severity: 'info',
    check: (snapshot) => {
      return Object.values(snapshot.capabilities).some((c) => c === 'unavailable');
    },
    createRule: (snapshot) => {
      const unavailable = Object.entries(snapshot.capabilities)
        .filter(([_, status]) => status === 'unavailable')
        .map(([cap, _]) => cap);

      return {
        ruleId: KNOWN_RULE_IDS.CAPABILITY_UNAVAILABLE,
        severity: 'info',
        category: 'capability',
        projectId: snapshot.projectId,
        evidence: [{ id: 'capabilities', kind: 'composition', detail: 'unavailable' }],
        message: `Project has unavailable capabilities: ${unavailable.join(', ')}`,
        suggestedIntent: 'check-capability-availability',
      };
    },
  },
];

// ==========================================================================
// Helper Functions
// ==========================================================================

/** Map known destination names to expected aspect ratios */
function destinationToAspectRatio(destination: string): string | null {
  const destinationAspects: Record<string, string> = {
    'instagram-reel': '9:16',
    'instagram-story': '9:16',
    'instagram-feed': '4:5',
    'instagram-square': '1:1',
    tiktok: '9:16',
    'youtube-short': '9:16',
    youtube: '16:9',
    twitter: '16:9',
    'facebook-feed': '16:9',
    'facebook-story': '9:16',
    linkedin: '16:9',
    snapchat: '9:16',
    pinterest: '2:3',
    '16:9': '16:9',
    '9:16': '9:16',
    '4:5': '4:5',
    '1:1': '1:1',
    '2:3': '2:3',
  };
  return destinationAspects[destination.toLowerCase()] ?? null;
}

/** Format duration in microseconds to a human-readable string */
export function formatDurationUs(durationUs: TimeUs): string {
  const durationMs = durationUs / 1000;
  if (durationMs < 1000) {
    return `${durationMs.toFixed(0)}ms`;
  }
  const durationSec = durationMs / 1000;
  if (durationSec < 60) {
    return `${durationSec.toFixed(1)}s`;
  }
  const minutes = Math.floor(durationSec / 60);
  const seconds = (durationSec % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

/**
 * Apply rules from the catalog to the snapshot and scenes.
 * Returns all triggered rules organized by category.
 */
function applyRules(
  snapshot: SemanticProjectSnapshotV1,
  scenes?: readonly SceneSummaryV1[],
): readonly IntelligenceRuleV1[] {
  const triggeredRules: IntelligenceRuleV1[] = [];
  const sceneList = scenes ?? snapshot.scenes;

  // Apply global rules (no scene context)
  for (const ruleDef of ruleCatalog) {
    if (ruleDef.check(snapshot, undefined)) {
      const rule = ruleDef.createRule(snapshot, undefined);
      if (rule) {
        triggeredRules.push(rule);
      }
    }
  }

  // Apply per-scene rules
  for (const scene of sceneList) {
    for (const ruleDef of ruleCatalog) {
      if (ruleDef.check(snapshot, scene)) {
        const rule = ruleDef.createRule(snapshot, scene);
        if (rule) {
          triggeredRules.push(rule);
        }
      }
    }
  }

  // Sort deterministically by ruleId, then projectId, then sceneId
  return triggeredRules.sort((a, b) => {
    const ruleCmp = a.ruleId.localeCompare(b.ruleId);
    if (ruleCmp !== 0) return ruleCmp;
    const projectCmp = a.projectId.localeCompare(b.projectId);
    if (projectCmp !== 0) return projectCmp;
    return (a.sceneId ?? '').localeCompare(b.sceneId ?? '');
  });
}

// ==========================================================================
// Brand Readiness
// ==========================================================================

/**
 * Compute brand readiness from a semantic snapshot.
 * This is a pure function that reports truthfully on available/missing brand data.
 */
export function computeBrandReadiness(snapshot: SemanticProjectSnapshotV1): BrandReadinessV1 {
  const brand = snapshot.brand;
  const projectId = snapshot.projectId;
  const revisionId = snapshot.revisionId;

  // Determine which components are available
  const colorsAvailable = brand.colorsAvailable;
  const fontsAvailable = brand.fontsAvailable;
  const logoAvailable = brand.logoAvailable;
  const voiceInstructionsAvailable = brand.voiceInstructionsAvailable;
  const toneInstructionsAvailable = brand.toneInstructionsAvailable;
  const hasBrandKit = brand.hasBrandKit;

  // Determine completeness
  const allComponents = [
    'colors',
    'fonts',
    'logo',
    'voice-instructions',
    'tone-instructions',
    'prohibited-claims',
    'prohibited-effects',
  ] as const;
  const availableCount = [
    colorsAvailable ? 1 : 0,
    fontsAvailable ? 1 : 0,
    logoAvailable ? 1 : 0,
    voiceInstructionsAvailable ? 1 : 0,
    toneInstructionsAvailable ? 1 : 0,
    brand.prohibitedClaims.length > 0 ? 1 : 0,
    brand.prohibitedEffects.length > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  let brandCompleteness: 'none' | 'partial' | 'complete';
  if (availableCount === 0 || !hasBrandKit) {
    brandCompleteness = 'none';
  } else if (availableCount < allComponents.length) {
    brandCompleteness = 'partial';
  } else {
    brandCompleteness = 'complete';
  }

  // Determine missing components
  const missingComponents: (typeof allComponents)[number][] = [];
  if (!colorsAvailable) missingComponents.push('colors');
  if (!fontsAvailable) missingComponents.push('fonts');
  if (!logoAvailable) missingComponents.push('logo');
  if (!voiceInstructionsAvailable) missingComponents.push('voice-instructions');
  if (!toneInstructionsAvailable) missingComponents.push('tone-instructions');
  if (brand.prohibitedClaims.length === 0) missingComponents.push('prohibited-claims');
  if (brand.prohibitedEffects.length === 0) missingComponents.push('prohibited-effects');

  // Generate warnings/rules for missing brand components
  const warnings = applyRules(snapshot).filter(
    (rule) => rule.category === 'brand' && rule.projectId === projectId,
  );

  // Build evidence
  const evidence: IntelligenceEvidenceRefV1[] = [
    { id: projectId, kind: 'composition', detail: 'brand-summary' },
    ...brand.warnings.map(
      (w) =>
        ({
          ...(w.evidence?.[0] ?? { id: projectId, kind: 'composition' }),
          detail: 'brand-warning',
        }) as IntelligenceEvidenceRefV1,
    ),
  ];

  return {
    projectId,
    revisionId,
    colorsAvailable,
    fontsAvailable,
    logoAvailable,
    voiceInstructionsAvailable,
    toneInstructionsAvailable,
    prohibitedClaims: brand.prohibitedClaims,
    prohibitedEffects: brand.prohibitedEffects,
    hasBrandKit,
    brandCompleteness,
    missingComponents,
    warnings,
    evidence,
  };
}

// ==========================================================================
// Scene Coverage
// ==========================================================================

/**
 * Compute scene coverage for all scenes in a snapshot.
 * Pure function that derives visual, audio, and caption characteristics.
 */
export function computeSceneCoverages(
  snapshot: SemanticProjectSnapshotV1,
): readonly SceneCoverageV1[] {
  const projectId = snapshot.projectId;
  const scenes = snapshot.scenes;

  return scenes.map((scene) => {
    const durationUs = scene.endUs - scene.startUs;

    // Visual characteristics
    const visualElements = scene.elements.filter((e) => e.hasVisual);
    const visualElementCount = visualElements.length;
    const hasVisualElements = visualElementCount > 0;

    // Determine visual density (match S1 logic for consistency)
    const visualDensity: 'none' | 'sparse' | 'adequate' | 'dense' = hasVisualElements
      ? visualElementCount < 3
        ? 'sparse'
        : visualElementCount >= 10
          ? 'dense'
          : 'adequate'
      : 'none';

    // Audio characteristics
    const audioElements = scene.elements.filter((e) => e.hasAudio);
    const hasAudio = audioElements.length > 0;
    const audioDurationUs = audioElements.reduce((sum, e) => sum + e.durationUs, 0);

    // Narration from scene data
    const hasNarration = scene.narration?.hasNarration ?? false;
    const narrationDurationUs = scene.narration?.durationUs ?? 0;

    // Caption characteristics
    const captionCoverage = scene.captionCoverage;
    const hasCaptions = captionCoverage?.hasCaptions ?? false;
    const captionWordCount = captionCoverage?.wordCount ?? 0;
    const captionLocale = captionCoverage?.locale;

    // Calculate caption coverage ratio (simplified - assume captions cover their scene)
    const captionCoverageRatio = hasCaptions ? 1.0 : 0.0;

    // Visual change signals - use element start times as change points
    const visualChangeSignals: TimeUs[] = visualElements
      .map((e) => e.startUs)
      .filter((t, i, arr) => i === 0 || t !== arr[i - 1]);

    // Audio gaps - simplified detection
    const audioGaps: { startUs: TimeUs; endUs: TimeUs; durationUs: TimeUs }[] = [];
    if (hasAudio && durationUs > 0) {
      // Simple gap detection: if audio doesn't cover full scene
      const audioCoverageStart = Math.min(...audioElements.map((e) => e.startUs));
      const audioCoverageEnd = Math.max(...audioElements.map((e) => e.startUs + e.durationUs));

      if (audioCoverageStart > scene.startUs) {
        audioGaps.push({
          startUs: scene.startUs,
          endUs: audioCoverageStart,
          durationUs: audioCoverageStart - scene.startUs,
        });
      }
      if (audioCoverageEnd < scene.endUs) {
        audioGaps.push({
          startUs: audioCoverageEnd,
          endUs: scene.endUs,
          durationUs: scene.endUs - audioCoverageEnd,
        });
      }
    }

    // Caption gaps - simplified
    const captionGaps: { startUs: TimeUs; endUs: TimeUs; durationUs: TimeUs }[] = [];

    // Apply scene-level rules
    const rules = applyRules(snapshot, [scene]).filter((rule) => rule.sceneId === scene.id);

    // Build evidence
    const evidence: IntelligenceEvidenceRefV1[] = [
      {
        id: scene.id,
        kind: 'marker',
        startUs: scene.startUs,
        endUs: scene.endUs,
        detail: 'scene-coverage',
      },
      ...scene.evidence.map(
        (e) => ({ ...e, detail: 'scene-evidence' }) as IntelligenceEvidenceRefV1,
      ),
    ];

    return {
      sceneId: scene.id,
      projectId,
      startUs: scene.startUs,
      endUs: scene.endUs,
      durationUs,
      visualElementCount,
      visualDensity,
      hasVisualElements,
      hasAudio,
      hasNarration,
      audioDurationUs,
      narrationDurationUs,
      hasCaptions,
      captionWordCount,
      captionLocale,
      captionCoverageRatio,
      visualChangeSignals,
      audioGaps,
      captionGaps,
      evidence,
      rules,
    };
  });
}

// ==========================================================================
// Project Readiness
// ==========================================================================

/**
 * Compute project readiness from a semantic snapshot.
 * Reports factual readiness based on destination, aspect ratio, duration alignment,
 * and capability state. Missing data becomes unknown/warning state, never fabricated.
 */
export function computeProjectReadiness(snapshot: SemanticProjectSnapshotV1): ProjectReadinessV1 {
  const projectId = snapshot.projectId;
  const revisionId = snapshot.revisionId;
  const composition = snapshot.composition;
  const goal = snapshot.goal;
  const scenes = snapshot.scenes;
  const capabilities = snapshot.capabilities;

  // Destination alignment
  const destination = goal?.destination;
  const expectedAspectRatio = destination ? destinationToAspectRatio(destination) : null;
  const destinationAligned =
    !destination || !expectedAspectRatio || composition.aspectRatio === expectedAspectRatio;
  const destinationMismatch =
    destination && expectedAspectRatio && composition.aspectRatio !== expectedAspectRatio
      ? { expected: expectedAspectRatio, actual: composition.aspectRatio }
      : undefined;

  // Duration alignment
  const durationTargetUs = goal?.durationTargetUs;
  const compositionDurationUs = composition.durationUs;
  const durationAligned = !durationTargetUs || compositionDurationUs === durationTargetUs;
  const durationGapUs = durationTargetUs ? compositionDurationUs - durationTargetUs : undefined;

  // Aspect ratio alignment
  const aspectRatio = composition.aspectRatio;
  const aspectRatioAligned =
    !expectedAspectRatio || composition.aspectRatio === expectedAspectRatio;
  const aspectRatioMismatch =
    expectedAspectRatio && composition.aspectRatio !== expectedAspectRatio
      ? { expected: expectedAspectRatio, actual: composition.aspectRatio }
      : undefined;

  // Capability state
  const captionAvailable = capabilities['caption-detection'] === 'ready';
  const audioAvailable = capabilities['audio-analysis'] === 'ready';
  const generatedAssetsAvailable = capabilities['generated-assets'] === 'ready';

  // Scene coverage aggregates
  const sceneCount = scenes.length;
  const scenesWithVisuals = scenes.filter((s) => s.visualCoverage !== 'none').length;
  const scenesWithAudio = scenes.filter((s) => s.elements.some((e) => e.hasAudio)).length;
  const scenesWithCaptions = scenes.filter((s) => s.captionCoverage?.hasCaptions).length;

  // Determine readiness level
  let readinessLevel: 'unknown' | 'setup-required' | 'partial' | 'ready';

  // Check for blockers and warnings
  const allRules = applyRules(snapshot);
  const blockers: IntelligenceRuleV1[] = [];
  const ruleWarnings: IntelligenceRuleV1[] = [];

  for (const rule of allRules) {
    if (rule.projectId === projectId) {
      if (rule.severity === 'error') {
        blockers.push(rule);
      } else if (rule.severity === 'warning') {
        ruleWarnings.push(rule);
      }
    }
  }

  // If we have setup-required capabilities, readiness can't be 'ready'
  if (Object.values(capabilities).includes('setup-required')) {
    readinessLevel = 'setup-required';
  } else if (blockers.length > 0) {
    readinessLevel = 'partial';
  } else if (!destinationAligned || !durationAligned || !aspectRatioAligned) {
    readinessLevel = 'partial';
  } else if (scenesWithVisuals === 0 || sceneCount === 0) {
    readinessLevel = 'partial';
  } else {
    readinessLevel = 'ready';
  }

  // If no goal is specified, we can't determine alignment
  if (!goal?.destination && !goal?.durationTargetUs) {
    readinessLevel = 'unknown';
  }

  // Build evidence
  const evidence: IntelligenceEvidenceRefV1[] = [
    { id: projectId, kind: 'composition', detail: 'project-readiness' },
  ];

  if (goal) {
    evidence.push({ id: 'goal', kind: 'composition', detail: 'project-goal' });
  }

  return {
    projectId,
    revisionId,
    destination,
    destinationAligned,
    destinationMismatch,
    durationTargetUs,
    compositionDurationUs,
    durationAligned,
    durationGapUs,
    aspectRatio,
    aspectRatioAligned,
    aspectRatioMismatch,
    captionAvailable,
    audioAvailable,
    generatedAssetsAvailable,
    readinessLevel,
    blockers,
    warnings: ruleWarnings,
    sceneCount,
    scenesWithVisuals,
    scenesWithAudio,
    scenesWithCaptions,
    evidence,
  };
}

// ==========================================================================
// Main API
// ==========================================================================

/**
 * Compute all S2 intelligence from a semantic snapshot.
 * Returns brand readiness, scene coverages, project readiness, and all triggered rules.
 */
export function computeSemanticIntelligence(snapshot: SemanticProjectSnapshotV1): {
  readonly brandReadiness: BrandReadinessV1;
  readonly sceneCoverages: readonly SceneCoverageV1[];
  readonly projectReadiness: ProjectReadinessV1;
  readonly allRules: readonly IntelligenceRuleV1[];
} {
  const allRules = applyRules(snapshot);

  return {
    brandReadiness: computeBrandReadiness(snapshot),
    sceneCoverages: computeSceneCoverages(snapshot),
    projectReadiness: computeProjectReadiness(snapshot),
    allRules,
  };
}

// ==========================================================================
// Rule Catalog Access
// ==========================================================================

/** Get all known rule IDs */
export function getKnownRuleIds(): readonly KnownRuleId[] {
  return Object.values(KNOWN_RULE_IDS);
}

/** Get rule definitions for inspection */
export function getRuleDefinitions(): readonly RuleDefinition[] {
  return [...ruleCatalog];
}

/** Get a specific rule definition by ID */
export function getRuleDefinition(ruleId: KnownRuleId): RuleDefinition | null {
  return ruleCatalog.find((r) => r.ruleId === ruleId) ?? null;
}
