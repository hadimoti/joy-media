/**
 * Release-gate summary evaluator (structured, not string-matched).
 *
 * GitHub Actions passes `toJSON(needs.*.result)` — a JSON array of the result of
 * every job named in the summary job's `needs:` — plus the count of lanes the
 * gate expects. The gate passes only when:
 *   - the JSON parses to a non-empty array,
 *   - its length equals the expected lane count (a missing required job shows up
 *     as a short array or a `skipped` entry), and
 *   - every entry is exactly `"success"`.
 *
 * `failure`, `cancelled`, `skipped`, `timed_out`, `action_required`, `neutral`
 * and anything else all fail. A cancelled or failed run is never a passing
 * repeatability result.
 *
 * CLI: `node --experimental-strip-types tooling/release/src/ci-gate-summary.ts '<JSON array>' <expectedLaneCount>`
 * Exit 0 = gate passes; exit 1 = gate fails (reasons on stderr).
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface GateSummaryResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export function evaluateGateSummary(
  rawResults: string,
  expectedLaneCount: number | string,
): GateSummaryResult {
  let results: unknown;
  try {
    results = JSON.parse(rawResults);
  } catch (error) {
    return {
      ok: false,
      reasons: [`lane results are not valid JSON: ${(error as Error).message}`],
    };
  }
  if (!Array.isArray(results)) {
    return { ok: false, reasons: ['lane results are not a JSON array'] };
  }
  const expected = Number(expectedLaneCount);
  if (!Number.isInteger(expected) || expected < 1) {
    return { ok: false, reasons: [`expected lane count is invalid: ${expectedLaneCount}`] };
  }

  const reasons: string[] = [];
  if (results.length === 0) reasons.push('no lane results were recorded');
  if (results.length !== expected) {
    reasons.push(
      `expected ${expected} release lanes, got ${results.length} results ` +
        `(a missing required job -> short array / "skipped")`,
    );
  }
  const notSuccess = results.map((r, i) => [i, r] as const).filter(([, r]) => r !== 'success');
  if (notSuccess.length > 0) {
    reasons.push(
      `lane result(s) not success: ${notSuccess
        .map(([i, r]) => `#${i}=${JSON.stringify(r)}`)
        .join(', ')}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , rawResults, expected] = process.argv;
  if (rawResults === undefined || expected === undefined) {
    console.error("usage: ci-gate-summary.ts '<JSON array>' <expectedLaneCount>");
    process.exit(1);
  }
  const { ok, reasons } = evaluateGateSummary(rawResults, expected);
  console.log(`lane results: ${rawResults}`);
  if (ok) {
    console.log(`gate summary: all ${expected} release lanes succeeded`);
    process.exit(0);
  }
  console.error(`gate summary FAILED:\n  - ${reasons.join('\n  - ')}`);
  process.exit(1);
}
