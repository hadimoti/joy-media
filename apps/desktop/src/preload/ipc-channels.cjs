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
  'desktop.worker-retry',
  'desktop.startup-preference',
  'desktop.job-status',
  'desktop.cancel-job',
  'desktop.generation.start',
  'desktop.generation.status',
  'desktop.generation.cancel',
  'desktop.generation.list',
  'desktop.provider-profile.save',
  'desktop.provider-profile.list',
  'desktop.provider-profile.delete',
  'desktop.provider-profile.later',
  'desktop.provider-profile.sign-in',
  'desktop.provider-profile.sign-in-cancel',
  'desktop.provider-profile.sign-in-reopen',
  'desktop.provider-profile.sign-out',
  'desktop.provider.test',
  'desktop.provider.models',
  'desktop.agent.request',
  'desktop.agent.cancel',
  'desktop.agent-slots.list',
  'desktop.agent-slots.save',
  'desktop.window-minimize',
  'desktop.window-maximize',
  'desktop.window-close',
  'desktop.window-is-maximized',
  'desktop.asset-library.get-settings',
  'desktop.asset-library.set-directory',
  'desktop.asset-library.select-directory',
  'desktop.asset-library.get-catalog',
  'desktop.asset-library.reset-directory',
  'desktop.asset-library.remove-entry',
  'desktop.asset-library.open-directory',
  'desktop.media.asset.register',
  'desktop.media.asset.remove-internal',
  'desktop.media.asset.upload-original',
  'desktop.media.asset.upload-original-chunk',
  'desktop.media.asset.upload-original-finish',
  'desktop.media.asset.upload-original-abort',
  'desktop.media.asset.import-dropped',
  'desktop.media.asset.cancel-dropped-import',
  'desktop.media.asset.revoke-dropped',
  'desktop.media.project.document.get',
  'desktop.media.project.document.put',
  'desktop.media.render.enqueue',
  'desktop.media.qc.run',
  'desktop.media.job.status',
  'desktop.media.job.cancel',
  'desktop.media.derivative.bytes',
  'desktop.media.audio.denoise',
  'desktop.media.speech.transcribe',
  'desktop.media.preview.frame',
  'desktop.media.workers.list',
]);

const DROP_FILES_ENDPOINT = 'joy-desktop-drop-files';
const DROPPED_IMPORT_PROGRESS_CHANNEL = 'joy-desktop-dropped-import-progress';

module.exports = { IPC_CHANNELS, DROP_FILES_ENDPOINT, DROPPED_IMPORT_PROGRESS_CHANNEL };
