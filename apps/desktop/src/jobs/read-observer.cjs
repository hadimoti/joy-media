/**
 * Test-only preload for a real Worker process. When JOY_TEST_READ_LOG is set, every read of a provider key file is
 * appended to that log: synchronous and callback reads, file handles and streams. A read whose result is discarded
 * still shows here, which a unit test cannot see. Loaded with NODE_OPTIONS=--require, so it runs before the Worker's
 * own modules.
 */
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

function record(file) {
  const log = process.env.JOY_TEST_READ_LOG;
  if (log && String(file).endsWith('ai-providers.json'))
    fs.appendFileSync(log, `${String(file)}\n`);
}

/** Wraps one read API so each call that names a file is recorded before the call runs. */
function observe(owner, name) {
  const original = owner[name];
  owner[name] = function observedRead(file, ...rest) {
    record(file);
    return original.call(this, file, ...rest);
  };
}

for (const name of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) {
  observe(fs, name);
}
for (const name of ['readFile', 'open']) observe(fs.promises, name);

// Named imports of built-ins (import { readFileSync } from 'node:fs') read live bindings, which only this call updates.
syncBuiltinESMExports();
