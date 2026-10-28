/**
 * Test-only preload for a real Worker process. When JOY_TEST_READ_LOG is set, every read of a provider key file
 * is appended to that log. A read whose result is discarded still shows here, which a unit test cannot see.
 * Loaded with NODE_OPTIONS=--require, so it runs before the Worker's own modules.
 */
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

function record(file) {
  const log = process.env.JOY_TEST_READ_LOG;
  if (log && String(file).endsWith('ai-providers.json'))
    fs.appendFileSync(log, `${String(file)}\n`);
}

const readFileSync = fs.readFileSync;
fs.readFileSync = function observedReadFileSync(file, ...rest) {
  record(file);
  return readFileSync.call(this, file, ...rest);
};

const openSync = fs.openSync;
fs.openSync = function observedOpenSync(file, ...rest) {
  record(file);
  return openSync.call(this, file, ...rest);
};

const readFile = fs.promises.readFile;
fs.promises.readFile = function observedReadFile(file, ...rest) {
  record(file);
  return readFile.call(this, file, ...rest);
};

// Named imports of built-ins (import { readFileSync } from 'node:fs') read live bindings, which only this call updates.
syncBuiltinESMExports();
