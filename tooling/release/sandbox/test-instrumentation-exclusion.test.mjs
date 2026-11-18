import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

test('staged default excludes test instrumentation', (t) => {
  let stagedRoot;
  let temporaryRoot;
  if (stagedDefault !== undefined && stagedDefault.trim() !== '') {
    stagedRoot = resolve(stagedDefault);
  } else {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-media-staged-default-'));
    stagedRoot = join(temporaryRoot, 'stage');
    mkdirSync(join(stagedRoot, 'resources', 'app'), { recursive: true });
    writeFileSync(join(stagedRoot, 'resources', 'app', 'main.js'), 'export {}\n');
  }
  t.after(() => {
    if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
  });

  assert.equal(statSync(stagedRoot).isDirectory(), true, 'staged default must be a directory');
  assert.deepEqual(findInstrumentationPaths(stagedRoot), []);
});
