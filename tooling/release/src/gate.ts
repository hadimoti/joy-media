import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_BUILD_IDS = ['editor', 'api', 'worker'] as const;
export const REQUIRED_JOURNEY_ID = 'authenticated-editor-1.0' as const;
export const RELEASE_STATUS_MAX_AGE_DAYS = 45;
export const RELEASE_EVIDENCE_MAX_AGE_HOURS = 24;
export const FEATURE_STATUS_PATH = 'docs/product/FEATURE-STATUS.md' as const;
export const REQUIRED_EDITOR_STATIC_ASSETS = [
  'assets/transition-preview-frame-a.svg',
  'assets/transition-preview-frame-b.svg',
] as const;
export const MINIMUM_EFFECT_PREVIEW_COUNT = 33;
export const REQUIRED_EFFECT_MOTION_PREVIEW_COUNT = 19;

const PUBLIC_STATIC_ROOT = 'apps/editor-web/public' as const;
const EDITOR_DIST_ROOT = 'apps/editor-web/dist' as const;
const STATIC_ASSET_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.webm',
  '.woff',
  '.woff2',
]);

export type ReleaseCheckStatus = 'passed' | 'failed' | 'waived';

export interface ReleaseCheck {
  readonly id: string;
  readonly status: ReleaseCheckStatus;
  readonly message: string;
  readonly critical: boolean;
}

export interface ReleaseWaiver {
  readonly checkId: string;
  readonly owner: string;
  readonly reason: string;
  readonly expiresAt: string;
}

export interface ReleaseGateInput {
  readonly testSummary: { readonly collected: number; readonly failed: number };
  readonly dirtyGeneratedArtifacts: readonly string[];
  readonly fixtureHandlers: readonly string[];
  readonly deploymentManifests: readonly string[];
  readonly builds: Readonly<Record<string, boolean>>;
  /** Source-to-dist static asset checks from the clean editor build. */
  readonly staticAssetPackaging: readonly string[];
  readonly staticAssetInventory?: ReleaseStaticAssetInventory;
  readonly manifestGenerated: boolean;
  readonly sbomGenerated: boolean;
  readonly browserJourneys: readonly ReleaseBrowserJourney[];
  readonly featureStatus: {
    readonly auditedOn: string;
    readonly statuses: readonly string[];
    readonly sourcePath?: string;
    readonly present?: boolean;
  };
  readonly waivers?: readonly ReleaseWaiver[];
  readonly commandResults?: readonly ReleaseCommandResult[];
  /** Quantitative, provenance-bound desktop performance/integrity evidence. */
  readonly performanceEvidence?: ReleasePerformanceEvidence;
  /** Real-service delivery, Worker lifecycle, and restore evidence. */
  readonly operationalEvidence?: ReleaseOperationalEvidence | null;
  /** Present for real workspace evidence; omitted by the pure evaluator. */
  readonly sourceProvenance?: ReleaseSourceProvenance;
}

export interface ReleaseOperationalEvidence {
  readonly delivery: Readonly<Record<string, unknown>>;
  readonly windows: Readonly<Record<string, unknown>>;
  readonly restore: Readonly<Record<string, unknown>>;
}

export interface ReleasePerformanceEvidence {
  readonly runId: string;
  readonly generatedAt: string;
  readonly generator: 'joy-media-release-observer';
  readonly phase: 'staging' | 'production';
  readonly sourceProvenance: ReleaseSourceProvenance;
  readonly polling: {
    readonly artifactPath: string;
    readonly warmupMs: number;
    readonly durationMs: number;
    readonly visibleRequestsPerMinute: number;
    readonly hiddenRequestsPerMinute: number;
    readonly duplicateInFlightRequests: number;
    readonly queryRatePerMinute: number;
  };
  readonly effectsSoak: {
    readonly artifactPath: string;
    readonly durationMs: number;
    readonly categoriesVisited: number;
    readonly searchIterations: number;
    readonly favoriteIterations: number;
    readonly uncaughtExceptions: number;
    readonly navigationFailures: number;
    readonly maxMountedPreviews: number;
    readonly maxPlayingPreviews: number;
    readonly heapGrowthPercent: number;
  };
  readonly timelineIntegrity: {
    readonly artifactPath: string;
    readonly operations: number;
    readonly countSequence: readonly number[];
    readonly uniqueIds: boolean;
    readonly orphanReferences: number;
    readonly canonicalModelEqualAfterReload: boolean;
  };
  readonly editor: {
    readonly artifactPath: string;
    readonly measuredWallTimeMs: number;
    readonly longTaskPercent: number;
    readonly initialEditorJsBytes: number;
  };
}

export interface ReleaseSourceProvenance {
  readonly commitSha: string;
  readonly treeHash: string;
  readonly lockfileSha256: string;
  readonly worktreeClean: boolean;
}

/** Release evidence that is safe to evaluate without reading the evidence file. */
export interface ReleaseBrowserJourney {
  readonly id: string;
  readonly status: 'verified' | 'failed' | 'unverified';
  readonly verifiedAt?: string;
  readonly evidencePath?: string;
  readonly execution?: 'real-services' | 'mocked' | 'unknown';
  readonly deliveryChannel?: 'verified-delivery' | 'quick-browser-export' | 'unknown';
  readonly inspectionState?: 'passed' | 'failed' | 'not-requested' | 'unknown';
  readonly postMotionPlacement?: boolean;
  readonly sourceProvenance?: ReleaseSourceProvenance;
}

export interface ReleaseGateResult {
  readonly passed: boolean;
  readonly generatedAt: string;
  readonly checks: readonly ReleaseCheck[];
}

export interface ReleaseStaticAssetInventory {
  readonly assets: readonly ReleaseStaticAssetRecord[];
  readonly htmlEntryPoints: readonly string[];
  readonly htmlReferences: readonly string[];
  readonly summary: {
    readonly publicAssetCount: number;
    readonly copiedSourceAssetCount: number;
    readonly builtAssetCount: number;
    readonly requiredTransitionFrameCount: number;
    readonly effectPreviewCount: number;
    readonly effectMotionPreviewCount: number;
  };
}

export interface ReleaseStaticAssetRecord {
  readonly path: string;
  readonly kind:
    | 'copied-public-asset'
    | 'built-asset'
    | 'required-transition-frame'
    | 'effect-preview'
    | 'effect-motion-preview';
  readonly mimeType: string;
  readonly signature: string;
  readonly size: number;
  readonly sha256: string;
  readonly sourcePath?: string;
  readonly sourceSha256?: string;
}

export function evaluateReleaseGate(input: ReleaseGateInput, now = new Date()): ReleaseGateResult {
  const requiredCommands = [
    'typecheck',
    'lint',
    'format',
    'tests',
    'editor-build',
    'api-build',
    'worker-build',
    'goldens',
  ];
  const commandHealth =
    input.commandResults === undefined ||
    requiredCommands.every((id) =>
      input.commandResults?.some((result) => result.id === id && result.exitCode === 0),
    );
  const checks: ReleaseCheck[] = [
    check(
      'command-health',
      commandHealth,
      input.commandResults === undefined
        ? 'command evidence not supplied to pure evaluator'
        : commandHealth
          ? 'typecheck, lint, format, tests, builds, and goldens passed'
          : commandHealthMessage(requiredCommands, input.commandResults),
    ),
    check(
      'source-provenance',
      sourceProvenanceReady(input, now),
      sourceProvenanceMessage(input, now),
    ),
    check(
      'tests',
      input.testSummary.collected > 0 && input.testSummary.failed === 0,
      input.testSummary.collected > 0
        ? `${input.testSummary.collected} tests collected; ${input.testSummary.failed} failed`
        : 'no tests were collected',
    ),
    check(
      'generated-artifacts',
      input.dirtyGeneratedArtifacts.length === 0,
      input.dirtyGeneratedArtifacts.length === 0
        ? 'generated artifacts are clean'
        : `dirty generated artifacts: ${input.dirtyGeneratedArtifacts.join(', ')}`,
    ),
    check(
      'fixture-registries',
      input.fixtureHandlers.length === 0,
      input.fixtureHandlers.length === 0
        ? 'no fixture handlers are registered in production surfaces'
        : `fixture handlers found: ${input.fixtureHandlers.join(', ')}`,
    ),
    check(
      'deployment-manifests',
      input.deploymentManifests.length === 0,
      input.deploymentManifests.length === 0
        ? 'deployment manifests and rollback contract are present'
        : `deployment manifest errors: ${input.deploymentManifests.join(', ')}`,
    ),
    check(
      'builds',
      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true),
      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true)
        ? 'editor, API, and Worker builds passed'
        : `missing or failed builds: ${REQUIRED_BUILD_IDS.filter((id) => input.builds[id] !== true).join(', ')}`,
    ),
    check(
      'static-assets',
      staticAssetInventoryReady(input) && input.staticAssetPackaging.length === 0,
      staticAssetMessage(input),
    ),
    check(
      'manifest',
      input.manifestGenerated,
      input.manifestGenerated ? 'release manifest generated' : 'release manifest is missing',
    ),
    check('sbom', input.sbomGenerated, input.sbomGenerated ? 'SBOM generated' : 'SBOM is missing'),
    check(
      'browser-journey',
      input.browserJourneys.some(
        (journey) =>
          journey.id === REQUIRED_JOURNEY_ID &&
          browserJourneyReleaseReady(journey, input.sourceProvenance, now),
      ),
      browserJourneyMessage(input.browserJourneys, input.sourceProvenance, now),
    ),
    check(
      'performance-evidence',
      performanceEvidenceReady(input.performanceEvidence, input.sourceProvenance, now),
      performanceEvidenceMessage(input.performanceEvidence, input.sourceProvenance, now),
    ),
    check(
      'operational-evidence',
      input.operationalEvidence === undefined ||
        (input.operationalEvidence !== null &&
          operationalEvidenceReady(input.operationalEvidence, input.sourceProvenance)),
      operationalEvidenceMessage(input.operationalEvidence, input.sourceProvenance),
    ),
    check(
      'feature-status',
      featureStatusReady(input.featureStatus, now) &&
        input.featureStatus.statuses.every((status) =>
          ['production', 'demo-only', 'experimental', 'hidden'].includes(status),
        ),
      featureStatusMessage(input.featureStatus, now),
      false,
    ),
  ];

  const waivers = input.waivers ?? [];
  const byId = new Map(waivers.map((waiver) => [waiver.checkId, waiver]));
  const resolved = checks.map((item) => {
    const waiver = byId.get(item.id);
    if (item.status !== 'failed' || waiver === undefined) return item;
    if (item.critical || !validWaiver(waiver, now)) return item;
    return {
      ...item,
      status: 'waived' as const,
      message: `${item.message}; waived by ${waiver.owner} until ${waiver.expiresAt}: ${waiver.reason}`,
    };
  });
  return {
    passed: resolved.every((item) => item.status !== 'failed'),
    generatedAt: now.toISOString(),
    checks: resolved,
  };
}

function check(id: string, passed: boolean, message: string, critical = true): ReleaseCheck {
  return { id, status: passed ? 'passed' : 'failed', message, critical };
}

function validWaiver(waiver: ReleaseWaiver, now: Date): boolean {
  return (
    waiver.owner.trim().length > 0 &&
    waiver.reason.trim().length > 0 &&
    Number.isFinite(Date.parse(waiver.expiresAt)) &&
    Date.parse(waiver.expiresAt) > now.getTime()
  );
}

function commandHealthMessage(
  requiredCommands: readonly string[],
  commandResults: readonly ReleaseCommandResult[],
): string {
  const failing = requiredCommands.filter((id) => {
    const result = commandResults.find((candidate) => candidate.id === id);
    return result === undefined || result.exitCode !== 0;
  });
  if (failing.length === 0) return 'typecheck, lint, format, tests, builds, and goldens passed';
  return `one or more required release commands failed: ${failing.join(', ')}`;
}

function featureStatusFresh(auditedOn: string, now: Date): boolean {
  const timestamp = Date.parse(auditedOn);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  const futureToleranceMs = 24 * 60 * 60 * 1000;
  return age >= -futureToleranceMs && age <= RELEASE_STATUS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function featureStatusReady(featureStatus: ReleaseGateInput['featureStatus'], now: Date): boolean {
  return featureStatus.present !== false && featureStatusFresh(featureStatus.auditedOn, now);
}

function featureStatusMessage(featureStatus: ReleaseGateInput['featureStatus'], now: Date): string {
  const label = featureStatus.sourcePath ?? FEATURE_STATUS_PATH;
  if (featureStatus.present === false) return `${label} is missing`;
  if (!featureStatusFresh(featureStatus.auditedOn, now))
    return `feature status audit is older than ${RELEASE_STATUS_MAX_AGE_DAYS} days`;
  return 'feature status audit is current';
}

export interface ReleaseEvidence extends ReleaseGateInput {
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly sbom: Readonly<Record<string, unknown>>;
}

export interface ReleaseCommandResult {
  readonly id: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output?: string;
}

function browserJourneyReleaseReady(
  journey: ReleaseBrowserJourney,
  expectedSource?: ReleaseSourceProvenance,
  now = new Date(),
): boolean {
  return (
    journey.status === 'verified' &&
    journey.evidencePath !== undefined &&
    journey.execution === 'real-services' &&
    journey.deliveryChannel === 'verified-delivery' &&
    journey.inspectionState === 'passed' &&
    journey.postMotionPlacement === true &&
    (expectedSource === undefined ||
      (sameSource(journey.sourceProvenance, expectedSource) && browserJourneyFresh(journey, now)))
  );
}

function browserJourneyMessage(
  journeys: readonly ReleaseBrowserJourney[],
  expectedSource?: ReleaseSourceProvenance,
  now = new Date(),
): string {
  const journey = journeys.find((candidate) => candidate.id === REQUIRED_JOURNEY_ID);
  if (journey === undefined)
    return `required journey ${REQUIRED_JOURNEY_ID} is missing; supply test-output/browser/journeys.json or JOY_RELEASE_EVIDENCE.browserJourneys`;
  if (browserJourneyReleaseReady(journey, expectedSource, now))
    return 'authenticated editor 1.0 journey verified against real services and inspected delivery';
  const reasons: string[] = [];
  if (journey.status !== 'verified') reasons.push(`status=${journey.status}`);
  if (journey.evidencePath === undefined) reasons.push('evidence path missing');
  if (journey.execution !== 'real-services') reasons.push('real-service evidence missing');
  if (journey.deliveryChannel !== 'verified-delivery')
    reasons.push('verified delivery channel missing');
  if (journey.inspectionState !== 'passed') reasons.push('passed inspection missing');
  if (journey.postMotionPlacement !== true) reasons.push('post-Motion placement missing');
  if (expectedSource !== undefined && !sameSource(journey.sourceProvenance, expectedSource))
    reasons.push('journey source does not match the current clean checkout');
  if (expectedSource !== undefined && !browserJourneyFresh(journey, now))
    reasons.push(`journey evidence is older than ${RELEASE_EVIDENCE_MAX_AGE_HOURS} hours`);
  return `required journey ${REQUIRED_JOURNEY_ID} is not release-ready: ${reasons.join(', ')}`;
}

function sourceProvenanceReady(input: ReleaseGateInput, now: Date): boolean {
  const source = input.sourceProvenance;
  if (source === undefined) return true;
  const journey = input.browserJourneys.find((candidate) => candidate.id === REQUIRED_JOURNEY_ID);
  return (
    validSource(source) &&
    source.worktreeClean &&
    sameSource(journey?.sourceProvenance, source) &&
    journey !== undefined &&
    browserJourneyFresh(journey, now)
  );
}

function sourceProvenanceMessage(input: ReleaseGateInput, now: Date): string {
  const source = input.sourceProvenance;
  if (source === undefined) return 'source provenance not supplied to pure evaluator';
  if (!validSource(source)) return 'workspace source provenance is malformed or incomplete';
  if (!source.worktreeClean) return 'workspace contains tracked or untracked source changes';
  const journey = input.browserJourneys.find((candidate) => candidate.id === REQUIRED_JOURNEY_ID);
  if (journey?.sourceProvenance === undefined)
    return 'authenticated browser evidence is not bound to a source revision; the journey evidence JSON must contain sourceProvenance';
  if (!sameSource(journey.sourceProvenance, source))
    return 'authenticated browser evidence was produced from a different source revision';
  if (!browserJourneyFresh(journey, now))
    return `authenticated browser evidence is older than ${RELEASE_EVIDENCE_MAX_AGE_HOURS} hours`;
  return `clean source and browser evidence match commit ${source.commitSha}`;
}

function performanceEvidenceReady(
  evidence: ReleasePerformanceEvidence | undefined,
  expectedSource: ReleaseSourceProvenance | undefined,
  now: Date,
): boolean {
  if (evidence === undefined) return false;
  if (evidence.generator !== 'joy-media-release-observer' || evidence.runId.trim() === '')
    return false;
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) return false;
  const age = now.getTime() - Date.parse(evidence.generatedAt);
  // Pure unit callers may omit source provenance and use a fixed historical clock.
  // Workspace evidence always carries source provenance and is freshness-bound.
  if (
    expectedSource !== undefined &&
    (age < 0 || age > RELEASE_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000)
  )
    return false;
  if (expectedSource !== undefined && !sameSource(evidence.sourceProvenance, expectedSource))
    return false;
  if (!performanceMetricBlocksPresent(evidence)) return false;
  const polling = evidence.polling;
  const effects = evidence.effectsSoak;
  const timeline = evidence.timelineIntegrity;
  const editor = evidence.editor;
  if (!Array.isArray(timeline.countSequence)) return false;
  return (
    (evidence.phase === 'staging' || evidence.phase === 'production') &&
    validSource(evidence.sourceProvenance) &&
    evidence.sourceProvenance.worktreeClean &&
    [
      polling.warmupMs >= 60_000,
      polling.durationMs >= 60_000,
      polling.visibleRequestsPerMinute >= 0 && polling.visibleRequestsPerMinute <= 6,
      polling.hiddenRequestsPerMinute >= 0 && polling.hiddenRequestsPerMinute <= 1,
      polling.duplicateInFlightRequests === 0,
      polling.queryRatePerMinute >= 0,
      effects.durationMs >= 30 * 60_000,
      effects.categoriesVisited >= 9,
      effects.searchIterations > 0,
      effects.favoriteIterations > 0,
      effects.uncaughtExceptions === 0,
      effects.navigationFailures === 0,
      effects.maxMountedPreviews <= 12,
      effects.maxPlayingPreviews <= 6,
      effects.heapGrowthPercent >= 0 && effects.heapGrowthPercent <= 20,
      timeline.operations >= 100,
      timeline.countSequence.length === 4 &&
        timeline.countSequence.every((count, index) => count === [2, 4, 3, 4][index]),
      timeline.uniqueIds === true,
      timeline.orphanReferences === 0,
      timeline.canonicalModelEqualAfterReload === true,
      editor.measuredWallTimeMs > 0,
      editor.longTaskPercent >= 0 && editor.longTaskPercent < 5,
      editor.initialEditorJsBytes >= 0 && editor.initialEditorJsBytes <= 500_000,
      Number.isFinite(polling.warmupMs),
      Number.isFinite(polling.durationMs),
      Number.isFinite(polling.visibleRequestsPerMinute),
      Number.isFinite(polling.hiddenRequestsPerMinute),
      Number.isFinite(polling.duplicateInFlightRequests),
      Number.isFinite(polling.queryRatePerMinute),
      Number.isFinite(effects.durationMs),
      Number.isFinite(effects.categoriesVisited),
      Number.isFinite(effects.searchIterations),
      Number.isFinite(effects.favoriteIterations),
      Number.isFinite(effects.uncaughtExceptions),
      Number.isFinite(effects.navigationFailures),
      Number.isFinite(effects.maxMountedPreviews),
      Number.isFinite(effects.maxPlayingPreviews),
      Number.isFinite(effects.heapGrowthPercent),
      Number.isFinite(timeline.operations),
      Number.isFinite(timeline.orphanReferences),
      Number.isFinite(editor.measuredWallTimeMs),
      Number.isFinite(editor.longTaskPercent),
      Number.isFinite(editor.initialEditorJsBytes),
    ].every(Boolean) &&
    [polling, effects, timeline, editor].every((artifact) => artifact.artifactPath.trim() !== '')
  );
}

function performanceMetricBlocksPresent(evidence: ReleasePerformanceEvidence): boolean {
  return [
    evidence.polling,
    evidence.effectsSoak,
    evidence.timelineIntegrity,
    evidence.editor,
  ].every(
    (metric) =>
      metric !== null && typeof metric === 'object' && typeof metric.artifactPath === 'string',
  );
}

function performanceEvidenceMessage(
  evidence: ReleasePerformanceEvidence | undefined,
  expectedSource: ReleaseSourceProvenance | undefined,
  now: Date,
): string {
  if (evidence === undefined) return 'quantitative performance evidence is missing';
  if (evidence.generator !== 'joy-media-release-observer')
    return 'performance evidence generator identity is invalid';
  if (!validSource(evidence.sourceProvenance) || !evidence.sourceProvenance.worktreeClean)
    return 'performance evidence source provenance is invalid or dirty';
  if (expectedSource !== undefined && !sameSource(evidence.sourceProvenance, expectedSource))
    return 'performance evidence was produced from a different source revision';
  const age = now.getTime() - Date.parse(evidence.generatedAt);
  if (
    expectedSource !== undefined &&
    (!Number.isFinite(age) || age < 0 || age > RELEASE_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000)
  )
    return `performance evidence is older than ${RELEASE_EVIDENCE_MAX_AGE_HOURS} hours or from the future`;
  if (!performanceMetricBlocksPresent(evidence))
    return 'performance evidence metric blocks are malformed';
  if (!performanceEvidenceReady(evidence, expectedSource, now))
    return 'performance evidence is incomplete or exceeds a required numeric budget';
  return `staging/production performance evidence ${evidence.runId} passed required budgets`;
}

function operationalEvidenceReady(
  evidence: ReleaseOperationalEvidence,
  expectedSource: ReleaseSourceProvenance | undefined,
): boolean {
  const blocks = [evidence.delivery, evidence.windows, evidence.restore];
  if (
    blocks.some(
      (block) =>
        block === null ||
        typeof block !== 'object' ||
        block.schemaVersion !== 1 ||
        block.status !== 'verified' ||
        (block.execution !== 'real-services' && block.execution !== 'windows-clean-worker'),
    )
  )
    return false;
  if (
    expectedSource !== undefined &&
    blocks.some(
      (block) => !sameSource(parseSourceProvenance(block.sourceProvenance), expectedSource),
    )
  )
    return false;
  const delivery = evidence.delivery.delivery;
  const mixed = record(delivery).mixedSourceExport;
  const downloaded = record(delivery).downloaded;
  const ffprobe = record(delivery).ffprobe;
  const reimport = record(delivery).reimport;
  const cancelRetry = record(delivery).cancelRetry;
  const missingSource = record(delivery).missingSource;
  if (
    record(mixed).status !== 'passed' ||
    !positiveNumber(record(mixed).bytes) ||
    !sha256(record(mixed).sha256) ||
    record(downloaded).status !== 200 ||
    !positiveNumber(record(downloaded).bytes) ||
    !sha256(record(downloaded).sha256) ||
    record(ffprobe).status !== 'passed' ||
    !Array.isArray(record(ffprobe).streamTypes) ||
    !record(ffprobe).streamTypes.includes('video') ||
    !record(ffprobe).streamTypes.includes('audio') ||
    record(reimport).status !== 201 ||
    record(reimport).uploadStatus !== 201 ||
    record(reimport).downloadStatus !== 200 ||
    !positiveNumber(record(reimport).bytes) ||
    !sha256(record(reimport).sha256) ||
    record(downloaded).bytes !== record(mixed).bytes ||
    record(downloaded).sha256 !== record(mixed).sha256 ||
    record(reimport).bytes !== record(mixed).bytes ||
    record(reimport).sha256 !== record(mixed).sha256 ||
    record(cancelRetry).canceledState !== 'canceled' ||
    record(cancelRetry).retriedState !== 'queued' ||
    (record(missingSource).status !== 404 && record(missingSource).status !== 409)
  )
    return false;
  const lifecycle = record(evidence.windows.lifecycle);
  if (
    [
      'install',
      'startup',
      'session',
      'renewal',
      'recovery',
      'repair',
      'update',
      'rollback',
      'uninstall',
    ].some((key) => record(lifecycle[key]).status !== 'passed')
  )
    return false;
  const startup = record(lifecycle.startup);
  const daemon = record(startup.daemon);
  if (daemon.started !== true || daemon.terminated !== true) return false;
  const session = record(lifecycle.session);
  if (
    session.stateIsolated !== true ||
    session.ownerSessionUsed !== false ||
    session.persistedSession !== false
  )
    return false;
  const renewal = record(lifecycle.renewal);
  if (renewal.restarted !== true) return false;
  const repair = record(lifecycle.repair);
  if (repair.restored !== true) return false;
  const update = record(lifecycle.update);
  if (update.atomicReplacement !== true || update.distinctPackageBytes !== true) return false;
  const signing = record(evidence.windows.signing);
  if (signing.status !== 'signed' && signing.status !== 'unsigned') return false;
  const restore = record(evidence.restore.restore);
  return (
    restore.status === 'passed' &&
    restore.schemaIsolation === true &&
    record(restore.nVersion).status === 'passed' &&
    record(restore.nMinusOneVersion).status === 'passed' &&
    record(restore.cleanup).status === 'passed'
  );
}

function operationalEvidenceMessage(
  evidence: ReleaseOperationalEvidence | null | undefined,
  expectedSource: ReleaseSourceProvenance | undefined,
): string {
  if (evidence === undefined) return 'operational evidence not supplied to pure evaluator';
  if (evidence === null) return 'delivery, Windows, and restore evidence is missing';
  return operationalEvidenceReady(evidence, expectedSource)
    ? 'delivery, Worker lifecycle, and N/N-1 restore evidence passed'
    : 'delivery, Worker lifecycle, or N/N-1 restore evidence is incomplete or unbound';
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function browserJourneyFresh(journey: ReleaseBrowserJourney, now: Date): boolean {
  const verifiedAt = Date.parse(journey.verifiedAt ?? '');
  const age = now.getTime() - verifiedAt;
  return (
    Number.isFinite(verifiedAt) &&
    age >= 0 &&
    age <= RELEASE_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000
  );
}

function validSource(source: ReleaseSourceProvenance | null | undefined): boolean {
  if (source === null || source === undefined || typeof source !== 'object') return false;
  return (
    /^[0-9a-f]{40,64}$/u.test(source.commitSha) &&
    /^[0-9a-f]{40,64}$/u.test(source.treeHash) &&
    /^[0-9a-f]{64}$/u.test(source.lockfileSha256)
  );
}

function sameSource(
  actual: ReleaseSourceProvenance | undefined,
  expected: ReleaseSourceProvenance,
): boolean {
  return (
    actual !== undefined &&
    validSource(actual) &&
    validSource(expected) &&
    actual.commitSha === expected.commitSha &&
    actual.treeHash === expected.treeHash &&
    actual.lockfileSha256 === expected.lockfileSha256 &&
    actual.worktreeClean === expected.worktreeClean
  );
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeReleaseEvidence(
  root: string,
  outputDirectory: string,
  evidence: ReleaseEvidence,
  now = new Date(),
): ReleaseGateResult {
  mkdirSync(outputDirectory, { recursive: true });
  verifyArtifactHashes(root, evidence.artifactHashes, evidence.manifest);
  verifyReleaseDocuments(evidence.manifest, evidence.sbom, evidence.sourceProvenance);
  const result = evaluateReleaseGate(evidence, now);
  const manifestText = JSON.stringify(evidence.manifest, null, 2);
  writeFileSync(
    join(outputDirectory, 'report.json'),
    JSON.stringify({ result, evidence }, null, 2),
  );
  writeFileSync(join(outputDirectory, 'manifest.json'), manifestText);
  writeFileSync(join(outputDirectory, 'sbom.json'), JSON.stringify(evidence.sbom, null, 2));
  writeFileSync(
    join(outputDirectory, 'artifact-hashes.json'),
    JSON.stringify(evidence.artifactHashes, null, 2),
  );
  if (evidence.staticAssetInventory !== undefined) {
    writeFileSync(
      join(outputDirectory, 'static-assets.json'),
      JSON.stringify(evidence.staticAssetInventory, null, 2),
    );
  }
  writeFileSync(
    join(outputDirectory, 'release-manifest.sha256'),
    `${sha256Text(manifestText)}  manifest.json\n`,
  );
  void root;
  return result;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function collectFiles(root: string, directory: string): readonly string[] {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    return entry.isDirectory() ? collectFiles(root, relative(root, path)) : [path];
  });
}

function normalizeRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function collectAssetLikeFiles(root: string, directory: string): readonly string[] {
  return collectFiles(root, directory).filter((path) =>
    STATIC_ASSET_EXTENSIONS.has(extname(path).toLowerCase()),
  );
}

function collectHtmlFiles(root: string, directory: string): readonly string[] {
  return collectFiles(root, directory).filter((path) => extname(path).toLowerCase() === '.html');
}

function classifyStaticAsset(path: string): ReleaseStaticAssetRecord['kind'] {
  if (
    REQUIRED_EDITOR_STATIC_ASSETS.includes(path as (typeof REQUIRED_EDITOR_STATIC_ASSETS)[number])
  )
    return 'required-transition-frame';
  if (path.startsWith('effects/preview-motion/')) return 'effect-motion-preview';
  if (path.startsWith('effects/preview/')) return 'effect-preview';
  return 'copied-public-asset';
}

function mimeTypeForAsset(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.json':
    case '.map':
      return 'application/json';
    case '.otf':
      return 'font/otf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ttf':
      return 'font/ttf';
    case '.webm':
      return 'video/webm';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function signatureForAsset(path: string, value: Buffer): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case '.png':
      return value.subarray(0, 8).toString('hex');
    case '.webm':
      return value.subarray(0, 4).toString('hex');
    case '.woff':
    case '.woff2':
    case '.svg':
      return value.subarray(0, 4).toString('utf8');
    case '.otf':
      return value.subarray(0, 4).toString('hex');
    case '.ttf':
    case '.ico':
      return value.subarray(0, 4).toString('hex');
    default:
      return value.subarray(0, 16).toString('utf8').trim();
  }
}

function validAssetSignature(path: string, value: Buffer): boolean {
  if (value.length === 0) return false;
  switch (extname(path).toLowerCase()) {
    case '.css':
    case '.js':
    case '.json':
    case '.map':
    case '.mjs':
      return !isHtmlFallback(value);
    case '.ico':
      return value.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]));
    case '.otf':
      return (
        value.subarray(0, 4).toString('utf8') === 'OTTO' ||
        value.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]))
      );
    case '.png':
      return value
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case '.svg':
      return isSvgDocument(value.toString('utf8'));
    case '.ttf':
      return value.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]));
    case '.webm':
      return value.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case '.woff':
      return value.subarray(0, 4).toString('utf8') === 'wOFF';
    case '.woff2':
      return value.subarray(0, 4).toString('utf8') === 'wOF2';
    default:
      return true;
  }
}

function parseHtmlAssetReferences(htmlPath: string, content: string): readonly string[] {
  const htmlDirectory = posix.dirname(htmlPath);
  const references = new Set<string>();
  for (const match of content.matchAll(
    /\b(?:src|href|poster|data-worker|data-worklet)=["']([^"'#?]+(?:\?[^"']*)?(?:#[^"']*)?)["']/gu,
  )) {
    const raw = match[1];
    if (raw === undefined || raw.startsWith('data:') || /^[a-z]+:/iu.test(raw)) continue;
    const [withoutHash] = raw.split('#', 1);
    const [withoutQuery] = (withoutHash ?? raw).split('?', 1);
    if (withoutQuery.length === 0) continue;
    const normalized = withoutQuery.startsWith('/')
      ? withoutQuery.slice(1)
      : posix.normalize(posix.join(htmlDirectory === '.' ? '' : htmlDirectory, withoutQuery));
    if (
      normalized.length === 0 ||
      normalized.startsWith('../') ||
      normalized === '..' ||
      !STATIC_ASSET_EXTENSIONS.has(extname(normalized).toLowerCase())
    )
      continue;
    references.add(normalized);
  }
  return [...references].sort();
}

export function buildStaticAssetInventory(root: string): {
  readonly inventory: ReleaseStaticAssetInventory;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const publicAssets = [
    ...new Set([
      ...REQUIRED_EDITOR_STATIC_ASSETS,
      ...collectAssetLikeFiles(root, PUBLIC_STATIC_ROOT).map((path) =>
        normalizeRelativePath(resolve(root, PUBLIC_STATIC_ROOT), path),
      ),
    ]),
  ].sort();
  const distAssets = collectAssetLikeFiles(root, EDITOR_DIST_ROOT)
    .map((path) => normalizeRelativePath(resolve(root, EDITOR_DIST_ROOT), path))
    .sort();
  const distAssetSet = new Set(distAssets);
  const records: ReleaseStaticAssetRecord[] = [];

  for (const assetPath of publicAssets) {
    const sourcePath = join(root, PUBLIC_STATIC_ROOT, assetPath);
    const distPath = join(root, EDITOR_DIST_ROOT, assetPath);
    if (!existsSync(sourcePath)) {
      errors.push(`source missing: ${assetPath}`);
      continue;
    }
    const source = readFileSync(sourcePath);
    if (source.length === 0) {
      errors.push(`source is empty: ${assetPath}`);
      continue;
    }
    if (!validAssetSignature(assetPath, source)) {
      errors.push(`source has invalid signature: ${assetPath}`);
      continue;
    }
    if (!existsSync(distPath)) {
      errors.push(`build output missing: ${assetPath}`);
      continue;
    }
    const output = readFileSync(distPath);
    if (output.length === 0) {
      errors.push(`build output is empty: ${assetPath}`);
      continue;
    }
    if (!validAssetSignature(assetPath, output)) {
      errors.push(`build output has invalid signature: ${assetPath}`);
      continue;
    }
    if (!output.equals(source)) {
      errors.push(`build output differs from source: ${assetPath}`);
      continue;
    }
    records.push({
      path: assetPath,
      kind: classifyStaticAsset(assetPath),
      mimeType: mimeTypeForAsset(assetPath),
      signature: signatureForAsset(assetPath, output),
      size: output.length,
      sha256: sha256File(distPath),
      sourcePath: `${PUBLIC_STATIC_ROOT}/${assetPath}`,
      sourceSha256: sha256File(sourcePath),
    });
  }

  for (const assetPath of distAssets) {
    if (publicAssets.includes(assetPath)) continue;
    const distPath = join(root, EDITOR_DIST_ROOT, assetPath);
    const output = readFileSync(distPath);
    if (output.length === 0) {
      errors.push(`build output is empty: ${assetPath}`);
      continue;
    }
    if (!validAssetSignature(assetPath, output)) {
      errors.push(`build output has invalid signature: ${assetPath}`);
      continue;
    }
    records.push({
      path: assetPath,
      kind: 'built-asset',
      mimeType: mimeTypeForAsset(assetPath),
      signature: signatureForAsset(assetPath, output),
      size: output.length,
      sha256: sha256File(distPath),
    });
  }

  const htmlEntryPoints = collectHtmlFiles(root, EDITOR_DIST_ROOT)
    .map((path) => normalizeRelativePath(resolve(root, EDITOR_DIST_ROOT), path))
    .sort();
  const htmlReferences = new Set<string>();
  for (const htmlPath of htmlEntryPoints) {
    const absolute = join(root, EDITOR_DIST_ROOT, htmlPath);
    for (const reference of parseHtmlAssetReferences(htmlPath, readFileSync(absolute, 'utf8'))) {
      htmlReferences.add(reference);
      if (!distAssetSet.has(reference))
        errors.push(`html reference missing from dist: ${reference}`);
    }
  }
  const inventoryPaths = new Set(records.map((record) => record.path));
  for (const reference of htmlReferences) {
    if (!inventoryPaths.has(reference))
      errors.push(`html reference missing from inventory: ${reference}`);
  }

  const inventory: ReleaseStaticAssetInventory = {
    assets: records.sort((left, right) => left.path.localeCompare(right.path)),
    htmlEntryPoints,
    htmlReferences: [...htmlReferences].sort(),
    summary: {
      publicAssetCount: publicAssets.length,
      copiedSourceAssetCount: records.filter((record) => record.sourcePath !== undefined).length,
      builtAssetCount: records.filter((record) => record.kind === 'built-asset').length,
      requiredTransitionFrameCount: records.filter(
        (record) => record.kind === 'required-transition-frame',
      ).length,
      effectPreviewCount: records.filter((record) => record.kind === 'effect-preview').length,
      effectMotionPreviewCount: records.filter((record) => record.kind === 'effect-motion-preview')
        .length,
    },
  };
  return { inventory, errors };
}

function staticAssetInventoryReady(input: ReleaseGateInput): boolean {
  const inventory = input.staticAssetInventory;
  if (inventory === undefined) return false;
  return (
    inventory.assets.length > 0 &&
    inventory.htmlEntryPoints.length > 0 &&
    inventory.summary.requiredTransitionFrameCount === REQUIRED_EDITOR_STATIC_ASSETS.length &&
    inventory.summary.effectPreviewCount >= MINIMUM_EFFECT_PREVIEW_COUNT &&
    inventory.summary.effectMotionPreviewCount === REQUIRED_EFFECT_MOTION_PREVIEW_COUNT
  );
}

function staticAssetMessage(input: ReleaseGateInput): string {
  if (input.staticAssetInventory === undefined) return 'static asset inventory is missing';
  if (input.staticAssetPackaging.length > 0)
    return `static asset packaging errors: ${input.staticAssetPackaging.join(', ')}`;
  if (
    input.staticAssetInventory.summary.requiredTransitionFrameCount !==
    REQUIRED_EDITOR_STATIC_ASSETS.length
  )
    return `expected ${REQUIRED_EDITOR_STATIC_ASSETS.length} transition frames in inventory`;
  if (input.staticAssetInventory.summary.effectPreviewCount < MINIMUM_EFFECT_PREVIEW_COUNT)
    return `expected at least ${MINIMUM_EFFECT_PREVIEW_COUNT} effect preview PNGs in inventory`;
  if (
    input.staticAssetInventory.summary.effectMotionPreviewCount !==
    REQUIRED_EFFECT_MOTION_PREVIEW_COUNT
  )
    return `expected ${REQUIRED_EFFECT_MOTION_PREVIEW_COUNT} effect motion previews in inventory`;
  if (input.staticAssetInventory.htmlEntryPoints.length === 0)
    return 'editor build HTML entry points are missing from the static asset inventory';
  const summary = input.staticAssetInventory.summary;
  return `static asset inventory recorded ${summary.copiedSourceAssetCount} copied public assets, ${summary.builtAssetCount} built assets, ${summary.effectPreviewCount} effect preview PNGs, and ${summary.effectMotionPreviewCount} motion previews`;
}

export function buildEvidenceFromWorkspace(root: string): ReleaseEvidence {
  const commandResults = runReleaseCommands(root);
  const sourceProvenance = workspaceSourceProvenance(root);
  const performanceEvidence = readPerformanceEvidence(root);
  const staticAssets = buildStaticAssetInventory(root);
  const artifacts = [
    'apps/editor-web/dist',
    'apps/api/dist',
    'apps/worker/dist',
    'test-output/release-performance',
    // Operational acceptance records are release artifacts too. Hash them in
    // the manifest so delivery, Worker lifecycle, and restore evidence cannot
    // be swapped after the candidate was evaluated.
    'test-output/delivery',
    'test-output/windows',
    'test-output/operations',
  ];
  const buildSuccess = Object.fromEntries(
    REQUIRED_BUILD_IDS.map((id) => {
      const commandId = `${id}-build`;
      return [
        id,
        commandResults.some((result) => result.id === commandId && result.exitCode === 0) &&
          collectFiles(root, `apps/${id === 'editor' ? 'editor-web' : id}/dist`).length > 0,
      ];
    }),
  );
  const artifactHashes: Record<string, string> = {};
  for (const directory of artifacts) {
    for (const path of collectFiles(root, directory))
      artifactHashes[normalizeRelativePath(root, path)] = sha256File(path);
  }
  const tests = commandResults.find((result) => result.id === 'tests');
  const featureStatusPath = join(root, FEATURE_STATUS_PATH);
  const featureStatusPresent = existsSync(featureStatusPath);
  const featureStatusText = featureStatusPresent ? readFileSync(featureStatusPath, 'utf8') : '';
  const auditedOn =
    featureStatusText.match(/Audited against current source on (\d{4}-\d{2}-\d{2})/u)?.[1] ??
    '1970-01-01';
  const statuses = [
    ...featureStatusText.matchAll(/\|\s+(production|demo-only|experimental|hidden)\s+\|/gu),
  ].map((match) => match[1]!);
  const browserJourneys = readBrowserJourneys(root);
  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceProvenance,
    artifacts: artifactHashes,
    staticAssets: staticAssets.inventory.summary,
    commands: commandResults,
  };
  const sbom = buildSbom(root);
  const testSummary = parseTestSummary(tests?.output ?? '', tests?.exitCode ?? 1);
  return {
    testSummary,
    dirtyGeneratedArtifacts: dirtyGeneratedArtifacts(root),
    fixtureHandlers: findProductionFixtureRegistrations(root),
    deploymentManifests: verifyDeploymentManifests(root),
    builds: buildSuccess,
    staticAssetPackaging: staticAssets.errors,
    staticAssetInventory: staticAssets.inventory,
    manifestGenerated: true,
    sbomGenerated: true,
    browserJourneys,
    operationalEvidence: readOperationalEvidence(root),
    featureStatus: {
      auditedOn,
      statuses,
      sourcePath: FEATURE_STATUS_PATH,
      present: featureStatusPresent,
    },
    artifactHashes,
    manifest,
    sbom,
    commandResults,
    performanceEvidence,
    sourceProvenance,
  };
}

function readOperationalEvidence(root: string): ReleaseOperationalEvidence | null {
  const read = (relativePath: string): Record<string, unknown> | undefined => {
    const path = join(root, relativePath);
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const delivery = read('test-output/delivery/result.json');
  const windows = read('test-output/windows/acceptance.json');
  const restore = read('test-output/operations/restore.json');
  if (delivery === undefined || windows === undefined || restore === undefined) return null;
  return { delivery, windows, restore };
}

function readPerformanceEvidence(root: string): ReleasePerformanceEvidence | undefined {
  const directory = join(root, 'test-output/release-performance');
  const read = (name: string): Record<string, unknown> | undefined => {
    const path = join(directory, name);
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const polling = read('polling.json');
  const effectsSoak = read('effects-soak.json');
  const timelineIntegrity = read('timeline-integrity.json');
  const editor = read('editor.json');
  if (
    polling === undefined ||
    effectsSoak === undefined ||
    timelineIntegrity === undefined ||
    editor === undefined
  )
    return undefined;
  const metricBlocks = [
    polling.metrics,
    effectsSoak.metrics,
    timelineIntegrity.metrics,
    editor.metrics,
  ];
  if (
    metricBlocks.some(
      (metrics) => metrics === null || typeof metrics !== 'object' || Array.isArray(metrics),
    )
  )
    return undefined;
  const metadata = [polling, effectsSoak, timelineIntegrity, editor];
  const runId = metadata[0]?.runId;
  const generatedAt = metadata[0]?.generatedAt;
  const generator = metadata[0]?.generator;
  const phase = metadata[0]?.phase;
  const source = metadata[0]?.sourceProvenance;
  if (
    typeof runId !== 'string' ||
    typeof generatedAt !== 'string' ||
    generator !== 'joy-media-release-observer' ||
    (phase !== 'staging' && phase !== 'production') ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source)
  )
    return undefined;
  if (
    !metadata.every(
      (item) =>
        item.runId === runId &&
        item.generatedAt === generatedAt &&
        item.generator === generator &&
        item.phase === phase &&
        JSON.stringify(item.sourceProvenance) === JSON.stringify(source),
    )
  )
    return undefined;
  return {
    runId,
    generatedAt,
    generator,
    phase,
    sourceProvenance: source as ReleaseSourceProvenance,
    polling: polling.metrics as ReleasePerformanceEvidence['polling'],
    effectsSoak: effectsSoak.metrics as ReleasePerformanceEvidence['effectsSoak'],
    timelineIntegrity: timelineIntegrity.metrics as ReleasePerformanceEvidence['timelineIntegrity'],
    editor: editor.metrics as ReleasePerformanceEvidence['editor'],
  };
}

/**
 * The public transition frames have previously been shadowed by SPA fallbacks
 * in production. Verify a clean Vite build copied the source-controlled SVGs
 * byte-for-byte, and fail closed if either side resembles an HTML response.
 *
 * This is packaging evidence only. It deliberately does not claim that a live
 * host served these files with the correct MIME type; that remains an origin
 * and authenticated-browser release requirement.
 */
export function verifyRequiredEditorStaticAssets(root: string): readonly string[] {
  return buildStaticAssetInventory(root).errors;
}

function isHtmlFallback(value: Buffer): boolean {
  const normalized = value.toString('utf8').trimStart().toLowerCase();
  return normalized.startsWith('<!doctype html') || normalized.startsWith('<html');
}

export function verifyDeploymentManifests(root: string): readonly string[] {
  const errors: string[] = [];
  const nginxPath = join(root, 'deploy/joy-media.nginx.conf');
  const overridePath = join(root, 'deploy/joy-media-api.override.conf');
  const readmePath = join(root, 'deploy/README.md');
  const rollbackPath = join(root, 'deploy/joy-media-rollback.sh');
  const releaseIdentityPath = join(root, 'deploy/joy-media-release-identity.sh');

  const nginx = requiredFileText(nginxPath, 'deploy/joy-media.nginx.conf', errors);
  if (nginx !== undefined) {
    for (const marker of [
      'location = /live {',
      'proxy_pass http://127.0.0.1:8790/live;',
      'location = /ready {',
      'proxy_pass http://127.0.0.1:8790/ready;',
      'location = /health/ready {',
      'proxy_pass http://127.0.0.1:8790/health/ready;',
      'try_files $uri =404;',
    ]) {
      if (!nginx.includes(marker)) errors.push(`deploy/joy-media.nginx.conf missing: ${marker}`);
    }
  }

  const override = requiredFileText(overridePath, 'deploy/joy-media-api.override.conf', errors);
  if (override !== undefined) {
    for (const marker of [
      'WorkingDirectory=/opt/joy-media/releases/current-api',
      'EnvironmentFile=/etc/joy-media/api.env',
    ]) {
      if (!override.includes(marker))
        errors.push(`deploy/joy-media-api.override.conf missing: ${marker}`);
    }
  }

  const readme = requiredFileText(readmePath, 'deploy/README.md', errors);
  if (readme !== undefined) {
    for (const marker of [
      'current-api',
      'web',
      '/opt/joy-media/web-releases/',
      'release-identity.env',
      'joy-media-release-identity.sh write',
      'systemctl restart joy-media@api',
      'Back up the database',
    ]) {
      if (!readme.includes(marker)) errors.push(`deploy/README.md missing: ${marker}`);
    }
  }

  const releaseIdentity = requiredFileText(
    releaseIdentityPath,
    'deploy/joy-media-release-identity.sh',
    errors,
  );
  if (releaseIdentity !== undefined) {
    for (const marker of [
      'JOY_MEDIA_RELEASE_COMMIT_SHA',
      'JOY_MEDIA_RELEASE_TREE_HASH',
      'JOY_MEDIA_RELEASE_LOCKFILE_SHA256',
      'JOY_MEDIA_RELEASE_SCHEMA_VERSION',
      'write_release_identity_file',
      'merge_release_identity_into_env',
    ]) {
      if (!releaseIdentity.includes(marker))
        errors.push(`deploy/joy-media-release-identity.sh missing: ${marker}`);
    }
  }

  const rollback = requiredFileText(rollbackPath, 'deploy/joy-media-rollback.sh', errors);
  if (rollback !== undefined) {
    for (const marker of [
      'set -euo pipefail',
      '<api-release> <web-release>',
      'JOY_MEDIA_API_RELEASE_ROOT',
      'JOY_MEDIA_WEB_RELEASE_ROOT',
      'release-identity.env',
      'merge_release_identity_into_env',
      'ROLLBACK_SWITCHED=1',
      'readlink -f',
      'mv -Tf',
      'systemctl restart joy-media@api',
      'nginx -t',
      'curl --fail',
      'index.html',
    ]) {
      if (!rollback.includes(marker))
        errors.push(`deploy/joy-media-rollback.sh missing: ${marker}`);
    }
  }

  return errors;
}

function isSvgDocument(value: string): boolean {
  const normalized = value.trimStart().toLowerCase();
  return (
    normalized.startsWith('<svg') &&
    !normalized.includes('<html') &&
    !normalized.includes('<!doctype html')
  );
}

export const RELEASE_COMMANDS: readonly [string, readonly string[]][] = [
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['format', ['format:check']],
  ['editor-build', ['--filter', '@joy-media/editor-web', 'build']],
  ['api-build', ['--filter', '@joy-media/api', 'build']],
  ['worker-build', ['--filter', '@joy-media/worker', 'build']],
  ['tests', ['test']],
  ['goldens', ['exec', 'vitest', 'run', 'tooling/golden-render/src']],
];

function runReleaseCommands(root: string): readonly ReleaseCommandResult[] {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return RELEASE_COMMANDS.map(([id, args]) => {
    const started = Date.now();
    // On Windows, pnpm is exposed as a .cmd shim and Node cannot spawn that
    // file directly with shell:false (it returns EINVAL before the command
    // starts). Use the platform shell only for this package-manager shim so
    // release evidence reflects the real command results on every platform.
    const result = spawnSync(pnpm, args, {
      cwd: root,
      stdio: id === 'tests' ? 'pipe' : 'ignore',
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    return {
      id,
      command: [pnpm, ...args].join(' '),
      exitCode: result.status ?? 1,
      durationMs: Date.now() - started,
      ...(id === 'tests'
        ? {
            output: `${typeof result.stdout === 'string' ? result.stdout : ''}${typeof result.stderr === 'string' ? result.stderr : ''}`,
          }
        : {}),
    };
  });
}

function parseTestSummary(output: string, exitCode: number): { collected: number; failed: number } {
  let collected = 0;
  let failed = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (!/\bTests\b/u.test(line)) continue;
    const passed = Number(line.match(/(\d+)\s+passed\b/u)?.[1] ?? 0);
    const skipped = Number(line.match(/(\d+)\s+skipped\b/u)?.[1] ?? 0);
    const lineFailed = Number(line.match(/(\d+)\s+failed\b/u)?.[1] ?? 0);
    if (passed + skipped + lineFailed === 0) continue;
    collected += passed + skipped + lineFailed;
    failed += lineFailed;
  }
  if (collected === 0 && exitCode !== 0) return { collected: 0, failed: 1 };
  return { collected, failed };
}

function buildSbom(root: string): Readonly<Record<string, unknown>> {
  const lockfile = join(root, 'pnpm-lock.yaml');
  const components: { type: 'library'; name: string; version: string; purl: string }[] = [];
  if (existsSync(lockfile)) {
    const packagesSection = readFileSync(lockfile, 'utf8').split(/^packages:\s*$/mu)[1] ?? '';
    const seen = new Set<string>();
    for (const line of packagesSection.split(/\r?\n/u)) {
      const match = line.match(/^\s{2}(?:'([^']+)'|([^:]+)):\s*$/u);
      const key = (match?.[1] ?? match?.[2])?.replace(/\([^)]*\)$/u, '');
      if (key === undefined) continue;
      const separator = key.lastIndexOf('@');
      if (separator <= 0) continue;
      const name = key.slice(0, separator);
      const version = key.slice(separator + 1);
      const identity = `${name}@${version}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      components.push({
        type: 'library',
        name,
        version,
        purl: `pkg:npm/${name.startsWith('@') ? name.slice(1).replace('/', '%2F') : name}@${version}`,
      });
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${sha256Text(JSON.stringify(components)).slice(0, 32)}`,
    components,
  };
}

function dirtyGeneratedArtifacts(root: string): readonly string[] {
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(
    git,
    ['status', '--porcelain', '--', 'apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    },
  );
  const dirtyBuildOutput = (result.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const tracked = spawnSync(git, ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  const trackedArtifacts =
    tracked.status === 0 && typeof tracked.stdout === 'string'
      ? findTrackedArtifactViolations(tracked.stdout.split('\0').filter(Boolean))
      : ['git ls-files failed while checking repository artifact hygiene'];
  return [...new Set([...dirtyBuildOutput, ...trackedArtifacts])];
}

export function findTrackedArtifactViolations(trackedFiles: readonly string[]): readonly string[] {
  const files = new Set(trackedFiles.map((path) => path.replaceAll('\\', '/')));
  return [...files]
    .filter(
      (path) =>
        /(?:^|\/)(?:test-output|test-results)\//u.test(path) ||
        /(?:^|\/)\.tmp-[^/]+$/u.test(path) ||
        isCompiledSourceSibling(path, files),
    )
    .sort();
}

function isCompiledSourceSibling(path: string, trackedFiles: ReadonlySet<string>): boolean {
  if (!path.includes('/src/')) return false;
  const emittedSuffix = ['.js.map', '.d.ts', '.js'].find((suffix) => path.endsWith(suffix));
  if (emittedSuffix === undefined) return false;
  const stem = path.slice(0, -emittedSuffix.length);
  return trackedFiles.has(`${stem}.ts`) || trackedFiles.has(`${stem}.tsx`);
}

/**
 * Production must not register test-only fixture handlers.  The runtime still
 * contains a deliberately bounded `fixture.thumbnail` protocol path used by
 * the real Worker delivery smoke, so matching every occurrence of that token
 * would incorrectly fail a valid release.  Keep this detector limited to
 * actual registry declarations and test-style exported fixture job types.
 */
const PRODUCTION_FIXTURE_REGISTRATION =
  /(?:\benqueueFixture\b|\bregisterFixture(?:Handler|Job)\b|\bexport\s+(?:const|let|var)\s+type\s*=\s*['"]fixture\.thumbnail['"])/iu;

export function findProductionFixtureRegistrations(root: string): readonly string[] {
  return collectFiles(root, 'apps')
    .filter(
      (path) =>
        /\.(?:ts|tsx)$/u.test(path) &&
        !/\.d\.ts$/u.test(path) &&
        !/\.test\.[^.]+$/u.test(path) &&
        !/[/\\]dist[/\\]/u.test(path),
    )
    .flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
      return lines.flatMap((line, index) =>
        productionFixtureLine(line) && PRODUCTION_FIXTURE_REGISTRATION.test(line)
          ? [`${relative(root, path)}:${index + 1}`]
          : [],
      );
    });
}

function productionFixtureLine(line: string): boolean {
  const trimmed = line.trim();
  return !/^(?:\/[/*]|\*|\||readonly\b|export interface\b|interface\b|type\b)/u.test(trimmed);
}

function readBrowserJourneys(root: string): readonly ReleaseBrowserJourney[] {
  const path = join(root, 'test-output/browser/journeys.json');
  if (!existsSync(path)) return [];
  try {
    return verifyBrowserJourneyEvidence(
      root,
      JSON.parse(readFileSync(path, 'utf8')) as ReleaseGateInput['browserJourneys'],
    );
  } catch {
    return [];
  }
}

export function verifyBrowserJourneyEvidence(
  root: string,
  journeys: readonly ReleaseBrowserJourney[],
): readonly ReleaseBrowserJourney[] {
  return journeys.map((journey) => {
    const {
      sourceProvenance: claimedSource,
      verifiedAt: claimedVerificationTime,
      execution: claimedExecution,
      deliveryChannel: claimedDeliveryChannel,
      inspectionState: claimedInspectionState,
      postMotionPlacement: claimedMotionPlacement,
      ...unboundJourney
    } = journey;
    void claimedSource;
    void claimedVerificationTime;
    void claimedExecution;
    void claimedDeliveryChannel;
    void claimedInspectionState;
    void claimedMotionPlacement;
    if (journey.status !== 'verified') return unboundJourney;
    if (journey.evidencePath === undefined) return { ...unboundJourney, execution: 'unknown' };
    const evidencePath = resolve(root, journey.evidencePath);
    const repositoryRoot = resolve(root);
    const insideRepository =
      evidencePath === repositoryRoot ||
      evidencePath.startsWith(`${repositoryRoot}/`) ||
      evidencePath.startsWith(`${repositoryRoot}\\`);
    if (!insideRepository || !existsSync(evidencePath))
      return { ...unboundJourney, execution: 'unknown' };
    try {
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as unknown;
      const evidenceRecord = record(evidence);
      if (evidenceRecord.journeyId !== journey.id || evidenceRecord.status !== 'verified')
        return { ...unboundJourney, status: 'unverified', execution: 'unknown' };
      return { ...unboundJourney, ...journeyReleaseAttributes(evidence) };
    } catch {
      return { ...unboundJourney, execution: 'unknown' };
    }
  });
}

function journeyReleaseAttributes(value: unknown): Partial<ReleaseBrowserJourney> {
  const evidence = record(value);
  const assertions = record(evidence.assertions);
  const verifiedExport = record(assertions.verifiedExport);
  const inspection = record(verifiedExport.inspection);
  const channel = verifiedExport.channel;
  const inspectionState = inspection.state;
  const execution = evidence.execution;
  const verifiedAt = evidence.verifiedAt;
  const motionPlacement = assertions.motionPlacement;
  const sourceProvenance = parseSourceProvenance(evidence.sourceProvenance);
  return {
    ...(execution === 'real-services' || execution === 'mocked' || execution === 'unknown'
      ? { execution }
      : { execution: 'unknown' as const }),
    ...(channel === 'verified-delivery' || channel === 'quick-browser-export'
      ? { deliveryChannel: channel }
      : { deliveryChannel: 'unknown' as const }),
    ...(inspectionState === 'passed' ||
    inspectionState === 'failed' ||
    inspectionState === 'not-requested'
      ? { inspectionState }
      : { inspectionState: 'unknown' as const }),
    postMotionPlacement: Array.isArray(motionPlacement) && motionPlacement.length >= 2,
    ...(typeof verifiedAt === 'string' ? { verifiedAt } : {}),
    ...(sourceProvenance === undefined ? {} : { sourceProvenance }),
  };
}

function parseSourceProvenance(value: unknown): ReleaseSourceProvenance | undefined {
  const source = record(value);
  if (
    typeof source.commitSha !== 'string' ||
    typeof source.treeHash !== 'string' ||
    typeof source.lockfileSha256 !== 'string' ||
    typeof source.worktreeClean !== 'boolean'
  )
    return undefined;
  return {
    commitSha: source.commitSha,
    treeHash: source.treeHash,
    lockfileSha256: source.lockfileSha256,
    worktreeClean: source.worktreeClean,
  };
}

function workspaceSourceProvenance(root: string): ReleaseSourceProvenance {
  const commitSha = gitOutput(root, ['rev-parse', 'HEAD']);
  const treeHash = gitOutput(root, ['rev-parse', 'HEAD^{tree}']);
  const status = gitOutput(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude)test-output/**',
    ':(exclude)test-results/**',
    ':(exclude)playwright-report/**',
  ]);
  const lockfile = join(root, 'pnpm-lock.yaml');
  return {
    commitSha,
    treeHash,
    lockfileSha256: existsSync(lockfile) ? sha256File(lockfile) : '',
    worktreeClean: status.length === 0,
  };
}

function gitOutput(root: string, args: readonly string[]): string {
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(git, args, { cwd: root, encoding: 'utf8', shell: false });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredFileText(path: string, label: string, errors: string[]): string | undefined {
  if (!existsSync(path)) {
    errors.push(`missing file: ${label}`);
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

function verifyArtifactHashes(
  root: string,
  hashes: Readonly<Record<string, string>>,
  manifest: Readonly<Record<string, unknown>>,
): void {
  const manifestArtifacts = manifest.artifacts;
  if (
    typeof manifestArtifacts !== 'object' ||
    manifestArtifacts === null ||
    Array.isArray(manifestArtifacts)
  ) {
    throw new Error('release manifest must contain an artifact hash map');
  }
  const manifestHashMap = manifestArtifacts as Record<string, unknown>;
  if (Object.keys(manifestHashMap).length !== Object.keys(hashes).length) {
    throw new Error('release manifest artifact hashes do not match the evidence hash map');
  }
  for (const [relativePath, expected] of Object.entries(hashes)) {
    if (manifestHashMap[relativePath] !== expected) {
      throw new Error(`release manifest hash mismatch: ${relativePath}`);
    }
    const path = resolve(root, relativePath);
    const repositoryRoot = resolve(root);
    if (
      path !== repositoryRoot &&
      !path.startsWith(`${repositoryRoot}/`) &&
      !path.startsWith(`${repositoryRoot}\\`)
    )
      throw new Error(`artifact path escapes repository: ${relativePath}`);
    if (!existsSync(path)) throw new Error(`artifact is missing: ${relativePath}`);
    const actual = sha256File(path);
    if (actual !== expected) throw new Error(`artifact hash mismatch: ${relativePath}`);
  }
}

function verifyReleaseDocuments(
  manifest: Readonly<Record<string, unknown>>,
  sbom: Readonly<Record<string, unknown>>,
  sourceProvenance?: ReleaseSourceProvenance,
): void {
  if (sourceProvenance === undefined) {
    if (manifest.schemaVersion !== 1) throw new Error('release manifest schemaVersion must be 1');
  } else {
    if (manifest.schemaVersion !== 2)
      throw new Error('source-bound release manifest must use schemaVersion 2');
    const manifestSource = parseSourceProvenance(manifest.sourceProvenance);
    if (manifestSource === undefined || !sameSource(manifestSource, sourceProvenance))
      throw new Error('release manifest source provenance does not match the workspace evidence');
  }
  if (
    (sbom.bomFormat !== 'cyclonedx' && sbom.bomFormat !== 'CycloneDX') ||
    !Array.isArray(sbom.components) ||
    sbom.components.length === 0 ||
    sbom.components.some(
      (component) =>
        component === null ||
        typeof component !== 'object' ||
        typeof (component as Record<string, unknown>).name !== 'string' ||
        typeof (component as Record<string, unknown>).version !== 'string',
    )
  ) {
    throw new Error('release SBOM must be CycloneDX with components');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const output = resolve(root, process.env.JOY_RELEASE_OUTPUT ?? 'test-output/release-gate');
  const evidencePath = process.env.JOY_RELEASE_EVIDENCE?.trim();
  const workspaceEvidence = buildEvidenceFromWorkspace(root);
  const supplied =
    evidencePath !== undefined && evidencePath.length > 0
      ? (JSON.parse(readFileSync(resolve(root, evidencePath), 'utf8')) as Partial<ReleaseEvidence>)
      : undefined;
  const evidence: ReleaseEvidence = {
    ...workspaceEvidence,
    ...(supplied === undefined
      ? {}
      : {
          browserJourneys: verifyBrowserJourneyEvidence(root, supplied.browserJourneys ?? []),
          ...(supplied.waivers !== undefined ? { waivers: supplied.waivers } : {}),
        }),
  };
  const result = writeReleaseEvidence(root, output, evidence);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
