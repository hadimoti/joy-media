import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJourneyTelemetry,
  inspectJourneyTelemetry,
  assertJourneyTelemetryClean,
  sanitizeUrl,
  EXPECTED_SANDBOX_STORAGE_ERROR,
} from './real-service-evidence.mjs';

test('sanitizeUrl: strips credentials, query and hash', () => {
  assert.equal(
    sanitizeUrl('http://user:pass@127.0.0.1:5173/assets/x.woff2?token=abc#frag'),
    'http://127.0.0.1:5173/assets/x.woff2?<redacted-query>',
  );
  assert.equal(sanitizeUrl('not a url?x=1'), 'not a url');
});

test('sanitizeUrl: opaque schemes (data:, blob:, javascript:) never pass their payload through', () => {
  assert.equal(sanitizeUrl('data:application/javascript;base64,QUtJQUY0S0U='), 'data:<opaque>');
  assert.equal(sanitizeUrl('blob:http://127.0.0.1:5173/9f3c-1b7e'), 'blob:<opaque>');
  assert.equal(sanitizeUrl('javascript:alert(document.cookie)'), 'javascript:<opaque>');
});

test('inspectJourneyTelemetry: clean telemetry -> no failure', () => {
  const t = createJourneyTelemetry();
  t.consoleWarnings.push({ text: 'benign', phase: 'joy-code' });
  t.pageErrors.push({ message: EXPECTED_SANDBOX_STORAGE_ERROR, phase: 'init' });
  const { failure } = inspectJourneyTelemetry(t);
  assert.equal(failure, null);
});

test('inspectJourneyTelemetry: reports console errors AND failed requests together, phase-stamped', () => {
  const t = createJourneyTelemetry();
  t.phase = 'creative-brief';
  t.consoleErrors.push({
    text: 'Failed to load resource: net::ERR_FILE_NOT_FOUND',
    phase: 'creative-brief',
    location: { url: 'http://127.0.0.1:5173/assets/x.woff2', lineNumber: null, columnNumber: null },
  });
  t.failedRequests.push({
    url: 'http://127.0.0.1:5173/assets/x.woff2',
    method: 'GET',
    resourceType: 'font',
    failureText: 'net::ERR_FILE_NOT_FOUND',
    phase: 'creative-brief',
  });
  const { failure } = inspectJourneyTelemetry(t, {
    phase: 'creative-brief',
    candidateSha: 'abc',
    runId: '1',
    attempt: '1',
    pass: '2',
  });
  assert.ok(failure);
  assert.match(failure.message, /console error/);
  assert.match(failure.message, /failed request/);
  assert.match(failure.message, /creative-brief/);
  assert.equal(failure.journeyPhaseAtFailure, 'creative-brief');
  assert.deepEqual(failure.netErrorCodesObserved, ['net::ERR_FILE_NOT_FOUND']);
  assert.equal(failure.failedRequests[0].resourceType, 'font');
  assert.match(failure.note, /NOT proof of an HTTP 404/i);
});

test('inspectJourneyTelemetry: an HTTP error alone is still reported', () => {
  const t = createJourneyTelemetry();
  t.httpErrors.push({
    status: 500,
    method: 'POST',
    url: 'http://127.0.0.1/api/x',
    phase: 'export',
  });
  const { failure } = inspectJourneyTelemetry(t);
  assert.ok(failure);
  assert.match(failure.message, /HTTP error/);
});

test('assertJourneyTelemetryClean: invokes onFailure with the report before throwing', () => {
  const t = createJourneyTelemetry();
  t.consoleErrors.push({ text: 'boom', phase: 'joy-code', location: {} });
  let captured;
  assert.throws(
    () => assertJourneyTelemetryClean(t, { phase: 'joy-code', onFailure: (r) => (captured = r) }),
    /journey telemetry not clean/,
  );
  assert.ok(captured);
  assert.equal(captured.consoleErrors[0].text, 'boom');
});

test('assertJourneyTelemetryClean: clean telemetry returns the summary', () => {
  const t = createJourneyTelemetry();
  const summary = assertJourneyTelemetryClean(t);
  assert.equal(summary.console.errors, 0);
  assert.equal(summary.network.failedRequests, 0);
});
