/**
 * Release-gate summary evaluator (structured, and keyed by lane NAME).
 *
 * GitHub Actions passes `toJSON(needs)` — an object mapping every job named in
 * the summary job's `needs:` to `{ result, outputs, ... }`. The gate passes only
 * when:
 *   - the JSON parses to an object,
 *   - its key set is EXACTLY the expected lane names (a lane removed from
 *     `needs:` is caught even if a count literal was lowered to match; an
 *     unexpected extra lane is caught too), and
 *   - every lane's `result` is exactly `"success"`.
 *
 * `failure`, `cancelled`, `skipped`, `timed_out`, `action_required`, `neutral`
 * and anything else all fail. A cancelled or failed run is never a passing
 * repeatability result.
 *
 * CLI: `node --experimental-strip-types tooling/release/src/ci-gate-summary.ts '<toJSON(needs)>' '<comma,separated,expected,lane,names>'`
 * Exit 0 = gate passes; exit 1 = gate fails (reasons on stderr).
 *
 * Back-compat: if the second arg parses as a positive integer, the first arg is
 * treated as the legacy `toJSON(needs.*.result)` array and only the count +
 * all-success checks run (name checking is skipped). New call sites should pass
 * names.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface GateSummaryResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

function evaluateByCount(rawResults: string, expected: number): GateSummaryResult {
  let results: unknown;
  try {
    results = JSON.parse(rawResults);
  } catch (error) {
    return { ok: false, reasons: [`lane results are not valid JSON: ${(error as Error).message}`] };
  }
  if (!Array.isArray(results)) return { ok: false, reasons: ['lane results are not a JSON array'] };
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

function evaluateByName(rawNeeds: string, expectedNames: readonly string[]): GateSummaryResult {
  let needs: unknown;
  try {
    needs = JSON.parse(rawNeeds);
  } catch (error) {
    return { ok: false, reasons: [`needs context is not valid JSON: ${(error as Error).message}`] };
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return { ok: false, reasons: ['needs context is not a JSON object'] };
  }
  const record = needs as Record<string, { result?: unknown }>;
  const present = Object.keys(record).sort();
  const expected = [...expectedNames].sort();
  const reasons: string[] = [];

  const missing = expected.filter((n) => !present.includes(n));
  const unexpected = present.filter((n) => !expected.includes(n));
  if (missing.length > 0) reasons.push(`required lane(s) absent from needs: ${missing.join(', ')}`);
  if (unexpected.length > 0)
    reasons.push(`unexpected lane(s) in needs (contract drift): ${unexpected.join(', ')}`);

  const notSuccess = expected
    .filter((n) => present.includes(n))
    .map((n) => [n, record[n]?.result] as const)
    .filter(([, r]) => r !== 'success');
  if (notSuccess.length > 0) {
    reasons.push(
      `lane result(s) not success: ${notSuccess
        .map(([n, r]) => `${n}=${JSON.stringify(r)}`)
        .join(', ')}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * @param raw  `toJSON(needs)` (object) for name-keyed evaluation, OR the legacy
 *             `toJSON(needs.*.result)` array when `spec` is a positive integer.
 * @param spec comma-separated expected lane names, OR a positive integer count
 *             (legacy).
 */
export function evaluateGateSummary(raw: string, spec: string | number): GateSummaryResult {
  const asNumber = Number(spec);
  if (
    typeof spec === 'number' ||
    (Number.isInteger(asNumber) && asNumber >= 1 && String(spec).trim() === String(asNumber))
  ) {
    return evaluateByCount(raw, asNumber);
  }
  const names = String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return {
      ok: false,
      reasons: [`expected lane spec is neither a positive integer nor a name list: ${spec}`],
    };
  }
  return evaluateByName(raw, names);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , raw, spec] = process.argv;
  if (raw === undefined || spec === undefined) {
    console.error("usage: ci-gate-summary.ts '<toJSON(needs)>' '<name,name,...>' (or a count)");
    process.exit(1);
  }
  const { ok, reasons } = evaluateGateSummary(raw, spec);
  console.log(`gate summary input: ${raw}`);
  if (ok) {
    console.log(`gate summary: every expected release lane succeeded (${spec})`);
    process.exit(0);
  }
  console.error(`gate summary FAILED:\n  - ${reasons.join('\n  - ')}`);
  process.exit(1);
}
