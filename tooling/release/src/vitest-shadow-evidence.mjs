// Verifies the shadow Vitest reports of one release-candidate-v2 run, and merges them (plan section 3.4, D18).
//
//   node tooling/release/src/vitest-shadow-evidence.mjs verify --root <dir> --run-id <id> --attempt <n> --candidate-sha <sha>
//   node tooling/release/src/vitest-shadow-evidence.mjs union --root <dir> --run-id <id> --attempt <n> --candidate-sha <sha> --out <union.json>
//
// Every matrix instance of the v2 test lanes uploads one artifact of its reports, named for the instance. The verifier requires each
// instance in REQUIRED_INSTANCES: its artifact is present, its checksum file lists every required report, each report matches that
// checksum, each report parses, and every test it declares is counted. A missing, damaged, partial or extra report fails the verification,
// and the shadow comparison refuses the pair. The union merges the verified reports into one Vitest JSON report for
// ci-v3-run-inputs.mjs. A run whose evidence is complete can still fail its tests; the union keeps those failures.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unionReports } from './vitest-report-union.mjs';

// The checksum file each lane writes beside its reports, in sha256sum format: "<sha256>  <file name>".
export const CHECKSUM_FILE = 'shadow-sha256.txt';

// Every matrix instance the shadow comparison needs, with the reports it writes. The base names carry the matrix instance (the Node
// version or the pass), so no two instances share an artifact (release-candidate-v2.yml).
export const REQUIRED_INSTANCES = [
  {
    base: 'joy-media-v2-vitest-node-contracts-node-22.17.0',
    reports: ['node-contracts-cli.json', 'node-contracts-pg.json'],
  },
  {
    base: 'joy-media-v2-vitest-node-contracts-node-24',
    reports: ['node-contracts-cli.json', 'node-contracts-pg.json'],
  },
  { base: 'joy-media-v2-vitest-linux-p0-pass-1', reports: ['linux-p0.json'] },
  { base: 'joy-media-v2-vitest-linux-p0-pass-2', reports: ['linux-p0.json'] },
  { base: 'joy-media-v2-vitest-windows-p0', reports: ['windows-p0.json', 'windows-cli.json'] },
];

/** The artifact name of one instance in one run, as release-candidate-v2.yml uploads it. */
export function artifactName(instance, { runId, attempt, candidateSha }) {
  return `${instance.base}-${runId}-${attempt}-${candidateSha}`;
}

function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// sha256sum writes "<hash>  <name>" in text mode and "<hash> *<name>" in binary mode, and both are accepted.
function readChecksums(path) {
  const checksums = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) [ *]?(.+)$/u.exec(line.trimEnd());
    if (match) checksums.set(match[2], match[1]);
  }
  return checksums;
}

/** Reads one Vitest JSON report and checks that it counts every test it declares. Throws, naming the defect. */
export function readReport(path) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`is unreadable JSON (${error.message})`);
  }
  if (!Array.isArray(report?.testResults)) throw new Error('has no test results');
  const counts = {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
  };
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`has no ${key} count`);
  }
  if (counts.total < 1) throw new Error('counts no tests');
  if (counts.passed + counts.failed + counts.pending + counts.todo !== counts.total) {
    throw new Error('has status counts that do not add up to its total');
  }
  const declared = report.testResults.reduce(
    (sum, file) => sum + (file.assertionResults?.length ?? 0),
    0,
  );
  if (declared !== counts.total) {
    throw new Error(`declares ${declared} tests but counts ${counts.total}`);
  }
  return counts;
}

/** Checks the shadow reports of every required matrix instance. Returns { ok, problems, instances }; it writes nothing. */
export function verifyShadowEvidence({ root, runId, attempt, candidateSha }) {
  const problems = [];
  const instances = [];
  for (const instance of REQUIRED_INSTANCES) {
    const name = artifactName(instance, { runId, attempt, candidateSha });
    const dir = join(root, name);
    if (!isDirectory(dir)) {
      problems.push(`${name}: the artifact is missing`);
      continue;
    }
    const checksumPath = join(dir, CHECKSUM_FILE);
    if (!existsSync(checksumPath)) {
      problems.push(`${name}: ${CHECKSUM_FILE} is missing`);
      continue;
    }
    const checksums = readChecksums(checksumPath);
    const reports = [];
    for (const report of instance.reports) {
      const path = join(dir, report);
      if (!existsSync(path)) {
        problems.push(`${name}: ${report} is missing`);
        continue;
      }
      const recorded = checksums.get(report);
      if (recorded === undefined) {
        problems.push(`${name}: ${report} has no recorded checksum`);
        continue;
      }
      const actual = sha256(path);
      if (actual !== recorded) {
        problems.push(`${name}: ${report} does not match its recorded checksum`);
        continue;
      }
      try {
        reports.push({ name: report, sha256: actual, ...readReport(path) });
      } catch (error) {
        problems.push(`${name}: ${report} ${error.message}`);
      }
    }
    for (const file of readdirSync(dir)) {
      if (file !== CHECKSUM_FILE && !instance.reports.includes(file)) {
        problems.push(`${name}: unexpected file ${file}`);
      }
    }
    instances.push({ name, reports });
  }
  return { ok: problems.length === 0, problems, instances };
}

/** Verifies the run, then merges its required reports. The union is undefined when the evidence is incomplete. */
export function unionShadowEvidence(options) {
  const verdict = verifyShadowEvidence(options);
  if (!verdict.ok) return { ...verdict, union: undefined };
  const reports = REQUIRED_INSTANCES.flatMap((instance) => {
    const dir = join(options.root, artifactName(instance, options));
    return instance.reports.map((report) => JSON.parse(readFileSync(join(dir, report), 'utf8')));
  });
  return { ...verdict, union: unionReports(reports) };
}

function parseArgs(argv) {
  const [command, ...pairs] = argv;
  const options = {};
  for (let index = 0; index < pairs.length; index += 2) {
    const key = pairs[index];
    const value = pairs[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs, got: ${key}`);
    }
    options[key.slice(2)] = value;
  }
  if (command !== 'verify' && command !== 'union') {
    throw new Error('Expected the command verify or union');
  }
  for (const name of ['root', 'run-id', 'attempt', 'candidate-sha']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (command === 'union' && !options.out) throw new Error('Missing --out');
  return { command, options };
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  const scope = {
    root: resolve(options.root),
    runId: options['run-id'],
    attempt: options.attempt,
    candidateSha: options['candidate-sha'],
  };
  if (command === 'verify') {
    const verdict = verifyShadowEvidence(scope);
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    return verdict.ok ? 0 : 1;
  }
  const result = unionShadowEvidence(scope);
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }
  writeFileSync(resolve(options.out), `${JSON.stringify(result.union, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `instances ${result.instances.length}, tests ${result.union.numTotalTests}, passed ${result.union.numPassedTests}, failed ${result.union.numFailedTests}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
