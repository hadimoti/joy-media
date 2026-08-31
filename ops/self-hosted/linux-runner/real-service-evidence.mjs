export const EXPECTED_SANDBOX_STORAGE_ERROR =
  "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";

export function createJourneyTelemetry() {
  return {
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
  };
}

export function summarizeJourneyTelemetry(telemetry) {
  const unexpectedPageErrors = telemetry.pageErrors.filter(
    (error) => error !== EXPECTED_SANDBOX_STORAGE_ERROR,
  );
  return {
    console: {
      errors: telemetry.consoleErrors.length,
      warnings: telemetry.consoleWarnings.length,
      errorSamples: telemetry.consoleErrors.slice(0, 10),
      warningSamples: telemetry.consoleWarnings.slice(0, 10),
    },
    pageErrors: {
      total: telemetry.pageErrors.length,
      unexpected: unexpectedPageErrors.length,
      unexpectedSamples: unexpectedPageErrors.slice(0, 10),
    },
    network: {
      failedRequests: telemetry.failedRequests.length,
      httpErrors: telemetry.httpErrors.length,
      failedRequestSamples: telemetry.failedRequests.slice(0, 10),
      httpErrorSamples: telemetry.httpErrors.slice(0, 10),
    },
  };
}

export function assertJourneyTelemetryClean(telemetry) {
  const summary = summarizeJourneyTelemetry(telemetry);
  if (summary.console.errors > 0) {
    throw new Error(`browser console errors observed: ${summary.console.errorSamples.join(' | ')}`);
  }
  if (summary.pageErrors.unexpected > 0) {
    throw new Error(
      `unexpected browser page errors observed: ${summary.pageErrors.unexpectedSamples.join(' | ')}`,
    );
  }
  if (summary.network.failedRequests > 0) {
    throw new Error(
      `browser request failures observed: ${summary.network.failedRequestSamples.join(' | ')}`,
    );
  }
  if (summary.network.httpErrors > 0) {
    throw new Error(`browser HTTP errors observed: ${summary.network.httpErrorSamples.join(' | ')}`);
  }
  return summary;
}

export function summarizePlaywrightProjectReport(reportText) {
  const report = JSON.parse(reportText);
  const stats = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    interrupted: 0,
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
      const result = Array.isArray(test?.results) && test.results.length > 0 ? test.results.at(-1) : null;
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
    status: exitCode === 0 && stats.failed === 0 && stats.timedOut === 0 && stats.interrupted === 0
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
