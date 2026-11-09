/**
 * Equivalence check for the proposed single-pass gate (plan §3.4, "Proving it before it replaces the old gate"). It is
 * a pure comparison of two vitest JSON reports, the v2 run and the v3 run on the same frozen commit. It is not wired
 * into any workflow: the v3 pipeline waits for approval D17.
 *
 * The rule: v3 must execute every test that v2 executed. A test may be extra in v3, but none may be missing, and both
 * runs must reach the same verdict. A missing test is how a pipeline can pass while silently dropping coverage.
 */

export interface VitestReportSummary {
  /** Test IDs that ran to a verdict (passed or failed). Skipped tests are not executed. */
  readonly executed: ReadonlySet<string>;
  readonly failed: ReadonlySet<string>;
}

export interface EquivalenceResult {
  readonly ok: boolean;
  readonly verdictMatches: boolean;
  readonly missingInV3: readonly string[];
  readonly extraInV3: readonly string[];
}

interface VitestAssertion {
  readonly fullName?: unknown;
  readonly status?: unknown;
}

interface VitestFile {
  readonly name?: unknown;
  readonly assertionResults?: unknown;
}

const REPO_DIRECTORIES = [
  '/apps/',
  '/packages/',
  '/tooling/',
  '/tests/',
  '/ops/',
  '/docs/',
] as const;

/** Summarises a vitest `--reporter=json` document. Test IDs are repo-relative, so two checkouts compare equal. */
export function summarizeVitestJsonReport(report: unknown): VitestReportSummary {
  const files = Array.isArray((report as { testResults?: unknown } | null)?.testResults)
    ? ((report as { testResults: unknown[] }).testResults as VitestFile[])
    : [];
  const executed = new Set<string>();
  const failed = new Set<string>();
  for (const file of files) {
    const relative = repoRelative(typeof file.name === 'string' ? file.name : '');
    const assertions = Array.isArray(file.assertionResults)
      ? (file.assertionResults as VitestAssertion[])
      : [];
    for (const assertion of assertions) {
      if (typeof assertion.fullName !== 'string') continue;
      if (assertion.status !== 'passed' && assertion.status !== 'failed') continue;
      const id = `${relative}::${assertion.fullName}`;
      executed.add(id);
      if (assertion.status === 'failed') failed.add(id);
    }
  }
  return { executed, failed };
}

/** Compares a v3 summary with the v2 summary it must match. Extra tests in v3 are allowed; missing ones are not. */
export function compareV2WithV3(
  v2: VitestReportSummary,
  v3: VitestReportSummary,
): EquivalenceResult {
  const missingInV3 = [...v2.executed].filter((id) => !v3.executed.has(id)).sort();
  const extraInV3 = [...v3.executed].filter((id) => !v2.executed.has(id)).sort();
  const verdictMatches = (v2.failed.size === 0) === (v3.failed.size === 0);
  return {
    ok: verdictMatches && missingInV3.length === 0,
    verdictMatches,
    missingInV3,
    extraInV3,
  };
}

function repoRelative(path: string): string {
  const normalized = path.replace(/\\/gu, '/');
  for (const directory of REPO_DIRECTORIES) {
    const index = normalized.indexOf(directory);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return normalized;
}
