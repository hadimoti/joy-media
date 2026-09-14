// Plain data, no `electron` import: this file exists so tests (and preload.cjs) can share
// the allow-listed channel array without ever loading the real `electron` module outside an
// actual Electron process (requiring 'electron' from plain Node resolves to a path string,
// not the API, and would make the module below unsafe to `require()` in a unit test).
//
// MUST match ../ipc.ts's IPC_CHANNELS exactly - preload.test.ts asserts that.
'use strict';

const IPC_CHANNELS = Object.freeze([
  'desktop.select-file',
  'desktop.revoke-file',
  'desktop.request-derivative',
  'desktop.worker-status',
  'desktop.startup-preference',
  'desktop.job-status',
  'desktop.cancel-job',
]);

module.exports = { IPC_CHANNELS };
