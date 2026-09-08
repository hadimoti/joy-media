/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJourneyTelemetry,
  inspectJourneyTelemetry,
  assertJourneyTelemetryClean,
  createWebServerLog,
  sanitizeUrl,
  EXPECTED_SANDBOX_STORAGE_ERROR,
} from './real-service-evidence.mjs';

test('createWebServerLog: redacts a secret split across two stdout chunks', () => {
  const secret = 'AKIA-SPLIT-SECRET-9f3c1b7e2d4a';
  const log = createWebServerLog({ secrets: [secret] });
  // secret straddles the chunk boundary AND there is no newline in chunk 1
  log.chunk('stdout', Buffer.from('resolve error near AKIA-SPLIT-'));
  log.chunk('stdout', Buffer.from('SECRET-9f3c1b7e2d4a in main.tsx\n'));
  const { lines } = log.flush();
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(secret), 'secret must not survive a chunk split');
  assert.match(lines[0], /«redacted»/);
});

test('createWebServerLog: enforces BOTH the line and byte bounds (oldest dropped)', () => {
  const log = createWebServerLog({ maxLines: 5, maxBytes: 1_000_000 });
  for (let i = 0; i < 20; i++) log.chunk('stderr', Buffer.from(`line ${i}\n`));
  let { lines } = log.flush();
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'line 15');

  const log2 = createWebServerLog({ maxLines: 100000, maxBytes: 200 });
  for (let i = 0; i < 50; i++) log2.chunk('stdout', Buffer.from(`0123456789abcdef ${i}\n`));
  lines = log2.flush().lines;
  const total = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.ok(total <= 200 + 20, `byte-bounded (~${total})`);
});

test('createWebServerLog: a trailing unterminated line is flushed, and bearer/presign shapes redacted', () => {
  const log = createWebServerLog();
  log.chunk('stderr', Buffer.from('GET /x?X-Amz-Signature=deadbeefcafe1234 401'));
  log.chunk('stdout', Buffer.from('authorization: Bearer abcdefgh12345678'));
  const { lines } = log.flush();
  assert.equal(lines.length, 2);
  assert.ok(lines.some((l) => /X-Amz-Signature=«redacted»/.test(l)));
  assert.ok(lines.some((l) => /Bearer «redacted»/.test(l)));
});

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
