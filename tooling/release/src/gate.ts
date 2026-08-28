import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_BUILD_IDS = ['editor', 'api', 'worker'] as const;
export const REQUIRED_JOURNEY_ID = 'authenticated-editor-1.0' as const;
export const RELEASE_STATUS_MAX_AGE_DAYS = 45;
export const RELEASE_EVIDENCE_MAX_AGE_HOURS = 24;

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
  readonly builds: Readonly<Record<string, boolean>>;
  readonly manifestGenerated: boolean;
  readonly sbomGenerated: boolean;
  readonly browserJourneys: readonly ReleaseBrowserJourney[];
  readonly featureStatus: { readonly auditedOn: string; readonly statuses: readonly string[] };
  readonly waivers?: readonly ReleaseWaiver[];
  readonly commandResults?: readonly ReleaseCommandResult[];
  /** Present for real workspace evidence; omitted by the pure evaluator. */
  readonly sourceProvenance?: ReleaseSourceProvenance;
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
          : 'one or more required release commands failed',
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
      'builds',
      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true),
      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true)
        ? 'editor, API, and Worker builds passed'
        : `missing or failed builds: ${REQUIRED_BUILD_IDS.filter((id) => input.builds[id] !== true).join(', ')}`,
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
      'feature-status',
      featureStatusFresh(input.featureStatus.auditedOn, now) &&
        input.featureStatus.statuses.every((status) =>
          ['production', 'demo-only', 'experimental', 'hidden'].includes(status),
        ),
      featureStatusFresh(input.featureStatus.auditedOn, now)
        ? 'feature status audit is current'
        : `feature status audit is older than ${RELEASE_STATUS_MAX_AGE_DAYS} days`,
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

function featureStatusFresh(auditedOn: string, now: Date): boolean {
  const timestamp = Date.parse(auditedOn);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  return age >= 0 && age <= RELEASE_STATUS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
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
  if (journey === undefined) return `required journey ${REQUIRED_JOURNEY_ID} is missing`;
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
    return 'authenticated browser evidence is not bound to a source revision';
  if (!sameSource(journey.sourceProvenance, source))
    return 'authenticated browser evidence was produced from a different source revision';
  if (!browserJourneyFresh(journey, now))
    return `authenticated browser evidence is older than ${RELEASE_EVIDENCE_MAX_AGE_HOURS} hours`;
  return `clean source and browser evidence match commit ${source.commitSha}`;
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

function validSource(source: ReleaseSourceProvenance): boolean {
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

export function buildEvidenceFromWorkspace(root: string): ReleaseEvidence {
  const commandResults = runReleaseCommands(root);
  const sourceProvenance = workspaceSourceProvenance(root);
  const artifacts = ['apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'];
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
      artifactHashes[relative(root, path)] = sha256File(path);
  }
  const tests = commandResults.find((result) => result.id === 'tests');
  const featureStatusText = existsSync(join(root, 'docs/product/FEATURE-STATUS.md'))
    ? readFileSync(join(root, 'docs/product/FEATURE-STATUS.md'), 'utf8')
    : '';
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
    commands: commandResults,
  };
  const sbom = buildSbom(root);
  const testSummary = parseTestSummary(tests?.output ?? '', tests?.exitCode ?? 1);
  return {
    testSummary,
    dirtyGeneratedArtifacts: dirtyGeneratedArtifacts(root),
    fixtureHandlers: fixtureHandlers(root),
    builds: buildSuccess,
    manifestGenerated: true,
    sbomGenerated: true,
    browserJourneys,
    featureStatus: { auditedOn, statuses },
    artifactHashes,
    manifest,
    sbom,
    commandResults,
    sourceProvenance,
  };
}

export const RELEASE_COMMANDS: readonly [string, readonly string[]][] = [
  ['editor-build', ['--filter', '@joy-media/editor-web', 'build']],
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['format', ['format:check']],
  ['tests', ['test:release']],
  ['api-build', ['--filter', '@joy-media/api', 'build']],
  ['worker-build', ['--filter', '@joy-media/worker', 'build']],
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
  const pnpm = process.platform === 'win32' ? 'git.exe' : 'git';
  const result = spawnSync(
    pnpm,
    ['status', '--porcelain', '--', 'apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    },
  );
  return (result.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fixtureHandlers(root: string): readonly string[] {
  return collectFiles(root, 'apps')
    .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !/\.test\.[^.]+$/u.test(path))
    .flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
      return lines.flatMap((line, index) =>
        /fixture(?:handler|registry|port)/iu.test(line)
          ? [`${relative(root, path)}:${index + 1}`]
          : [],
      );
    });
}

function readBrowserJourneys(root: string): readonly ReleaseBrowserJourney[] {
  const path = join(root, 'test-output/browser/journeys.json');
  if (!existsSync(path)) return [];
  try {
    return verifiedBrowserJourneys(
      root,
      JSON.parse(readFileSync(path, 'utf8')) as ReleaseGateInput['browserJourneys'],
    );
  } catch {
    return [];
  }
}

function verifiedBrowserJourneys(
  root: string,
  journeys: readonly ReleaseBrowserJourney[],
): readonly ReleaseBrowserJourney[] {
  return journeys.map((journey) => {
    const {
      sourceProvenance: claimedSource,
      verifiedAt: claimedVerificationTime,
      ...unboundJourney
    } = journey;
    void claimedSource;
    void claimedVerificationTime;
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
          browserJourneys: verifiedBrowserJourneys(root, supplied.browserJourneys ?? []),
          ...(supplied.waivers !== undefined ? { waivers: supplied.waivers } : {}),
        }),
  };
  const result = writeReleaseEvidence(root, output, evidence);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
