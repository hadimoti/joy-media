/* global URL */

export const EXPECTED_SANDBOX_STORAGE_ERROR =
  "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";

export function createJourneyTelemetry() {
  return {
    // The harness updates `phase` as the journey walk progresses; every captured
    // entry is stamped with the phase that was current when it fired, so a
    // failure report points at where in the walk the problem occurred.
    phase: 'init',
    consoleErrors: [], // { text, phase, location }
    consoleWarnings: [], // { text, phase }
    pageErrors: [], // { message, phase }
    failedRequests: [], // { url, method, resourceType, failureText, phase }
    httpErrors: [], // { status, method, url, phase }
  };
}

/** Strip credentials and query strings from a URL kept in evidence. */
export function sanitizeUrl(raw) {
  const value = String(raw ?? '');
  try {
    const url = new URL(value);
    // url.host excludes any user:pass@ userinfo; drop the query (may carry
    // tokens / presigned signatures) and the fragment.
    const base = `${url.protocol}//${url.host}${url.pathname}`;
    return url.search ? `${base}?<redacted-query>` : base;
  } catch {
    return value.split(/[?#]/)[0];
  }
}

const asText = (entry) =>
  typeof entry === 'string' ? entry : (entry?.text ?? entry?.message ?? JSON.stringify(entry));

const fmtConsole = (e) =>
  typeof e === 'string'
    ? e
    : `[${e.phase ?? '?'}] ${e.text}${e.location?.url ? ` (${e.location.url}:${e.location.lineNumber ?? '?'})` : ''}`;

const fmtFailedRequest = (e) =>
  typeof e === 'string'
    ? e
    : `[${e.phase ?? '?'}] ${e.method ?? 'GET'} ${e.url} — ${e.resourceType ?? 'other'} — ${e.failureText || 'unknown failure'}`;

const fmtHttpError = (e) =>
  typeof e === 'string' ? e : `[${e.phase ?? '?'}] ${e.status} ${e.method ?? 'GET'} ${e.url}`;

export function summarizeJourneyTelemetry(telemetry) {
  const unexpectedPageErrors = telemetry.pageErrors.filter(
    (error) => asText(error) !== EXPECTED_SANDBOX_STORAGE_ERROR,
  );
  return {
    console: {
      errors: telemetry.consoleErrors.length,
      warnings: telemetry.consoleWarnings.length,
      errorSamples: telemetry.consoleErrors.slice(0, 10).map(fmtConsole),
      warningSamples: telemetry.consoleWarnings.slice(0, 10).map(asText),
    },
    pageErrors: {
      total: telemetry.pageErrors.length,
      unexpected: unexpectedPageErrors.length,
      unexpectedSamples: unexpectedPageErrors.slice(0, 10).map(asText),
    },
    network: {
      failedRequests: telemetry.failedRequests.length,
      httpErrors: telemetry.httpErrors.length,
      failedRequestSamples: telemetry.failedRequests.slice(0, 10).map(fmtFailedRequest),
      httpErrorSamples: telemetry.httpErrors.slice(0, 10).map(fmtHttpError),
    },
  };
}

/**
 * Inspect journey telemetry WITHOUT throwing. Returns `{ summary, failure }`.
 * `failure` (when set) is a fully structured, sanitized report — console
 * errors, failed requests, page errors and HTTP errors together, each with its
 * journey phase — plus a one-line `message`. The caller persists it before
 * failing, so the reason a pass failed survives cleanup.
 *
 * Note: `net::ERR_FILE_NOT_FOUND` and the other `net::ERR_*` codes are browser
 * resource-load failures, NOT proof of an HTTP 404 — the cause stays
 * undetermined until the specific resource is identified.
 */
export function inspectJourneyTelemetry(telemetry, context = {}) {
  const summary = summarizeJourneyTelemetry(telemetry);
  const problems = [];
  if (summary.console.errors > 0)
    problems.push(
      `${summary.console.errors} console error(s): ${summary.console.errorSamples.join(' | ')}`,
    );
  if (summary.pageErrors.unexpected > 0)
    problems.push(
      `${summary.pageErrors.unexpected} unexpected page error(s): ${summary.pageErrors.unexpectedSamples.join(' | ')}`,
    );
  if (summary.network.failedRequests > 0)
    problems.push(
      `${summary.network.failedRequests} failed request(s): ${summary.network.failedRequestSamples.join(' | ')}`,
    );
  if (summary.network.httpErrors > 0)
    problems.push(
      `${summary.network.httpErrors} HTTP error(s): ${summary.network.httpErrorSamples.join(' | ')}`,
    );

  if (problems.length === 0) return { summary, failure: null };

  const netErrCodes = [
    ...telemetry.failedRequests.map((r) => (typeof r === 'string' ? r : r.failureText)),
  ].filter((t) => /net::ERR_/.test(t ?? ''));

  const failure = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    journeyPhaseAtFailure: context.phase ?? telemetry.phase ?? null,
    candidateSha: context.candidateSha ?? null,
    runId: context.runId ?? null,
    attempt: context.attempt ?? null,
    pass: context.pass ?? null,
    note:
      'net::ERR_FILE_NOT_FOUND / net::ERR_* are browser resource-load failures, ' +
      'NOT proof of an HTTP 404. Cause is undetermined until the resource below is identified.',
    netErrorCodesObserved: [...new Set(netErrCodes)],
    consoleErrors: telemetry.consoleErrors,
    unexpectedPageErrors: telemetry.pageErrors.filter(
      (error) => asText(error) !== EXPECTED_SANDBOX_STORAGE_ERROR,
    ),
    failedRequests: telemetry.failedRequests,
    httpErrors: telemetry.httpErrors,
    summary,
    message: `journey telemetry not clean (phase "${context.phase ?? telemetry.phase}"): ${problems.join(' ;; ')}`,
  };
  return { summary, failure };
}

/**
 * Back-compatible wrapper. `options.onFailure(report)` (if given) is invoked
 * synchronously with the structured report BEFORE the throw, so the caller can
 * persist it. Reports every issue class at once — never bails on the first.
 */
export function assertJourneyTelemetryClean(telemetry, options = {}) {
  const { summary, failure } = inspectJourneyTelemetry(telemetry, options);
  if (failure) {
    try {
      options.onFailure?.(failure);
    } catch {
      /* persistence is best-effort; the throw below still carries the detail */
    }
    throw new Error(failure.message);
  }
  return summary;
}

export function summarizePlaywrightProjectReport(reportText) {
  let report;
  let reportParseError = false;
  try {
    report = JSON.parse(reportText);
  } catch {
    reportParseError = true;
  }
  const stats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    interrupted: 0,
    reportParseError,
  };
  visitSuites(report?.suites, stats);
  return stats;
}

function visitSuites(suites, stats) {
  if (!Array.isArray(suites)) return;
  for (const suite of suites) {
    visitSpecs(suite?.specs, stats);
    visitSuites(suite?.suites, stats);
  }
}

function visitSpecs(specs, stats) {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    const tests = Array.isArray(spec?.tests) ? spec.tests : [];
    for (const test of tests) {
      stats.total += 1;
      const result =
        Array.isArray(test?.results) && test.results.length > 0 ? test.results.at(-1) : null;
      const status = result?.status ?? test?.outcome ?? 'unknown';
      if (status === 'passed' || status === 'expected') stats.passed += 1;
      else if (status === 'skipped') stats.skipped += 1;
      else if (status === 'timedOut') stats.timedOut += 1;
      else if (status === 'interrupted') stats.interrupted += 1;
      else stats.failed += 1;
    }
  }
}

export function buildProfileSummary({
  project,
  reportText,
  exitCode,
  startedAt,
  finishedAt,
  sourceProvenance,
}) {
  const stats = summarizePlaywrightProjectReport(reportText);
  return {
    project,
    status:
      exitCode === 0 &&
      !stats.reportParseError &&
      stats.total > 0 &&
      stats.failed === 0 &&
      stats.timedOut === 0 &&
      stats.interrupted === 0
        ? 'passed'
        : 'failed',
    exitCode,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    sourceProvenance,
    stats,
  };
}
