/* global URL, Buffer */

/**
 * A bounded, redacted line buffer for a subprocess's stdout+stderr. Both bounds
 * apply (lines AND bytes; oldest dropped first). Redaction happens on the
 * REASSEMBLED line, so a secret split across two `data` chunks — or across a
 * chunk boundary that isn't a newline — is still caught. Per-stream partials.
 */
export function createWebServerLog({
  secrets = [],
  maxLines = 4000,
  maxBytes = 512 * 1024,
  lineMax = 2000,
} = {}) {
  const activeSecrets = secrets.filter((v) => typeof v === 'string' && v.length >= 6);
  const lines = [];
  let bytes = 0;
  const partial = { stdout: '', stderr: '' };

  const redact = (line) => {
    let out = String(line);
    for (const s of activeSecrets) out = out.split(s).join('«redacted»');
    out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1«redacted»@');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1«redacted»');
    out = out.replace(
      /(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi,
      '$1«redacted»',
    );
    return out.length > lineMax ? `${out.slice(0, lineMax)}…[truncated]` : out;
  };
  const push = (redacted) => {
    lines.push(redacted);
    bytes += Buffer.byteLength(redacted, 'utf8') + 1;
    while (lines.length > 0 && (lines.length > maxLines || bytes > maxBytes)) {
      bytes -= Buffer.byteLength(lines.shift(), 'utf8') + 1;
    }
  };
  return {
    chunk(stream, buf) {
      const combined = (partial[stream] ?? '') + buf.toString('utf8');
      const parts = combined.split(/\r?\n/);
      partial[stream] = parts.pop() ?? '';
      if (partial[stream].length > lineMax * 4) {
        push(redact(partial[stream]));
        partial[stream] = '';
      }
      for (const line of parts) if (line !== '') push(redact(line));
    },
    flush() {
      for (const stream of ['stdout', 'stderr']) {
        if (partial[stream] !== '') {
          push(redact(partial[stream]));
          partial[stream] = '';
        }
      }
      return { lines: [...lines], maxLines, maxBytes };
    },
  };
}

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
    // Opaque schemes (data:, blob:, javascript:, filesystem:) have an empty
    // host and an unbounded, uncontrolled pathname — never pass that through.
    if (url.host === '') return `${url.protocol}<opaque>`;
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

  if (problems.length === 0 && !context.thrown) return { summary, failure: null };
  if (context.thrown) problems.unshift(`journey threw: ${context.thrown}`);

  const netErrCodes = [
    ...telemetry.failedRequests.map((r) => (typeof r === 'string' ? r : r.failureText)),
  ].filter((t) => /net::ERR_/.test(t ?? ''));

  const failure = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    journeyPhaseAtFailure: context.phase ?? telemetry.phase ?? null,
    thrown: context.thrown ?? null,
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
    /** titles (spec title, most specific) that ran and PASSED */
    passedTitles: [],
    /** titles that ran but did NOT pass */
    notPassedTitles: [],
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
    const title = typeof spec?.title === 'string' ? spec.title : '';
    for (const test of tests) {
      stats.total += 1;
      const result =
        Array.isArray(test?.results) && test.results.length > 0 ? test.results.at(-1) : null;
      const status = result?.status ?? test?.outcome ?? 'unknown';
      if (status === 'passed' || status === 'expected') {
        stats.passed += 1;
        if (title) stats.passedTitles.push(title);
      } else if (status === 'skipped') {
        stats.skipped += 1;
        if (title) stats.notPassedTitles.push(title);
      } else if (status === 'timedOut') {
        stats.timedOut += 1;
        if (title) stats.notPassedTitles.push(title);
      } else if (status === 'interrupted') {
        stats.interrupted += 1;
        if (title) stats.notPassedTitles.push(title);
      } else {
        stats.failed += 1;
        if (title) stats.notPassedTitles.push(title);
      }
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
