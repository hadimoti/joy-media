import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const stagedDefault = process.env.JOY_MEDIA_STAGED_DEFAULT;

function findInstrumentationPaths(root, relative = '') {
  const found = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.name.toLowerCase() === 'test-instrumentation') found.push(path);
    if (entry.isDirectory()) found.push(...findInstrumentationPaths(root, path));
  }
  return found;
}

test(
  'staged default excludes test instrumentation',
  { skip: stagedDefault === undefined || stagedDefault.trim() === '' },
  () => {
    const stagedRoot = resolve(stagedDefault);
    assert.equal(statSync(stagedRoot).isDirectory(), true, 'staged default must be a directory');
    assert.deepEqual(findInstrumentationPaths(stagedRoot), []);
  },
);
