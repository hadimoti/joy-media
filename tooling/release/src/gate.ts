import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_BUILD_IDS = ['editor', 'api', 'worker'] as const;
export const REQUIRED_JOURNEY_ID = 'authenticated-editor-1.0' as const;
export const RELEASE_STATUS_MAX_AGE_DAYS = 45;

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
  readonly browserJourneys: readonly {
    readonly id: string;
    readonly status: 'verified' | 'failed' | 'unverified';
    readonly verifiedAt?: string;
  }[];
  readonly featureStatus: { readonly auditedOn: string; readonly statuses: readonly string[] };
  readonly waivers?: readonly ReleaseWaiver[];
}

export interface ReleaseGateResult {
  readonly passed: boolean;
  readonly generatedAt: string;
  readonly checks: readonly ReleaseCheck[];
}

export function evaluateReleaseGate(input: ReleaseGateInput, now = new Date()): ReleaseGateResult {
  const checks: ReleaseCheck[] = [
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
        (journey) => journey.id === REQUIRED_JOURNEY_ID && journey.status === 'verified',
      ),
      input.browserJourneys.some(
        (journey) => journey.id === REQUIRED_JOURNEY_ID && journey.status === 'verified',
      )
        ? 'authenticated editor 1.0 journey verified'
        : `required journey ${REQUIRED_JOURNEY_ID} is not verified`,
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
  readonly commandResults?: readonly ReleaseCommandResult[];
}

export interface ReleaseCommandResult {
  readonly id: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
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
  verifyArtifactHashes(root, evidence.artifactHashes);
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
  const artifacts = ['apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'];
  const artifactHashes: Record<string, string> = {};
  for (const directory of artifacts) {
    for (const path of collectFiles(root, directory))
      artifactHashes[relative(root, path)] = sha256File(path);
  }
  const commandResults = runReleaseCommands(root);
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
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifacts: artifactHashes,
    commands: commandResults,
  };
  const sbom = {
    bomFormat: 'cyclonedx',
    specVersion: '1.5',
    components: [{ type: 'application', name: 'joy-media', version: '1.0.0' }],
  };
  return {
    testSummary: { collected: tests === undefined ? 0 : 1, failed: tests?.exitCode === 0 ? 0 : 1 },
    dirtyGeneratedArtifacts: dirtyGeneratedArtifacts(root),
    fixtureHandlers: fixtureHandlers(root),
    builds: buildSuccess,
    manifestGenerated: false,
    sbomGenerated: false,
    browserJourneys,
    featureStatus: { auditedOn, statuses },
    artifactHashes,
    manifest,
    sbom,
    commandResults,
  };
}

function runReleaseCommands(root: string): readonly ReleaseCommandResult[] {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const commands: readonly [string, readonly string[]][] = [
    ['typecheck', ['typecheck']],
    ['lint', ['lint']],
    ['format', ['format:check']],
    ['tests', ['test:release']],
    ['editor-build', ['--filter', '@joy-media/editor-web', 'build']],
    ['api-build', ['--filter', '@joy-media/api', 'build']],
    ['worker-build', ['--filter', '@joy-media/worker', 'build']],
    ['goldens', ['exec', 'vitest', 'run', 'tooling/golden-render/src']],
  ];
  return commands.map(([id, args]) => {
    const started = Date.now();
    const result = spawnSync(pnpm, args, { cwd: root, stdio: 'ignore', shell: false });
    return {
      id,
      command: [pnpm, ...args].join(' '),
      exitCode: result.status ?? 1,
      durationMs: Date.now() - started,
    };
  });
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

function readBrowserJourneys(root: string): ReleaseGateInput['browserJourneys'] {
  const path = join(root, 'test-output/browser/journeys.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReleaseGateInput['browserJourneys'];
  } catch {
    return [];
  }
}

function verifyArtifactHashes(root: string, hashes: Readonly<Record<string, string>>): void {
  for (const [relativePath, expected] of Object.entries(hashes)) {
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const output = resolve(root, process.env.JOY_RELEASE_OUTPUT ?? 'test-output/release-gate');
  const evidencePath = process.env.JOY_RELEASE_EVIDENCE?.trim();
  const evidence =
    evidencePath !== undefined && evidencePath.length > 0
      ? (JSON.parse(readFileSync(resolve(root, evidencePath), 'utf8')) as ReleaseEvidence)
      : buildEvidenceFromWorkspace(root);
  const result = writeReleaseEvidence(root, output, evidence);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}
