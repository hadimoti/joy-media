// Exclusion test for the test-only instrumentation (plan section 10d, G0 item 2; OA3). It always checks the staging filter and
// the workflow files. It checks the staged packages only when their folders are named in the environment:
//   JOY_MEDIA_STAGED_DEFAULT       the joy-media-unpacked folder from `package-release.mjs --unpacked`
//   JOY_MEDIA_STAGED_INSTRUMENTED  the joy-media-unpacked folder from `package-release.mjs --unpacked --instrumented`
// A failure names the file and the string only. It never prints file contents.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTestInstrumentationPath, keepDistPath } from './staging-filter.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Strings that exist only in the instrumentation (OA3). A default package holds none of them. */
export const INSTRUMENTATION_ONLY_STRINGS = [
  'gpu-events.jsonl',
  'gpu-diagnostics.jsonl',
  '--joy-media-gpu-diagnostics',
  '--joy-media-test-user-data',
  'crashReporter',
];

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.json',
  '.html',
  '.css',
  '.md',
  '.txt',
  '.map',
]);

function listFiles(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else found.push(path);
  }
  return found;
}

/** The staged text files whose content holds `text`, reported by relative name only. */
function textFilesContaining(folder, files, text) {
  return files
    .filter((file) => TEXT_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase()))
    .filter((file) => readFileSync(file, 'utf8').includes(text))
    .map((file) => file.slice(folder.length + 1).replaceAll('\\', '/'));
}

test('the staging filter keeps the instrumentation only in an instrumented package', () => {
  const entry = 'C:\\pkg\\dist\\main\\electron-entry.js';
  const instrumentation = 'C:\\pkg\\dist\\main\\test-instrumentation\\index.js';
  assert.equal(keepDistPath(entry, { instrumented: false }), true);
  assert.equal(keepDistPath(instrumentation, { instrumented: false }), false);
  assert.equal(keepDistPath(instrumentation, { instrumented: true }), true);
  assert.equal(keepDistPath('/pkg/dist/main/gpu-event-log.test.js', { instrumented: true }), false);
  assert.equal(isTestInstrumentationPath('/pkg/dist/main/test-instrumentation'), true);
  assert.equal(isTestInstrumentationPath('/pkg/dist/main/test-instrumentation-notes.js'), false);
});

test('no workflow, package script, or desktop script passes --instrumented', () => {
  const workflows = join(repoRoot, '.github', 'workflows');
  const workflowFiles = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(workflowFiles.length > 0, 'expected workflow files');
  for (const name of workflowFiles) {
    assert.equal(
      readFileSync(join(workflows, name), 'utf8').includes('--instrumented'),
      false,
      `${name} must not pass --instrumented`,
    );
  }
  // The desktop scripts are scanned too, so a new caller of package-release.mjs cannot pass --instrumented unnoticed.
  const desktopScripts = join(repoRoot, 'apps', 'desktop', 'scripts');
  const callers = readdirSync(desktopScripts).filter(
    (name) =>
      name.endsWith('.mjs') &&
      name !== 'package-release.mjs' &&
      name !== 'test-instrumentation-exclusion.test.mjs',
  );
  for (const name of callers) {
    assert.equal(
      readFileSync(join(desktopScripts, name), 'utf8').includes('--instrumented'),
      false,
      `${name} must not pass --instrumented`,
    );
  }
  for (const manifest of ['package.json', join('apps', 'desktop', 'package.json')]) {
    const scripts = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith('package')) continue;
      assert.equal(
        command.includes('--instrumented'),
        false,
        `${manifest} script ${name} must not pass --instrumented`,
      );
    }
  }
});

test(
  'a default package stages no instrumentation and none of the instrumentation-only strings',
  {
    skip: process.env.JOY_MEDIA_STAGED_DEFAULT ? false : 'JOY_MEDIA_STAGED_DEFAULT is not set',
  },
  () => {
    const folder = process.env.JOY_MEDIA_STAGED_DEFAULT;
    assert.equal(
      existsSync(join(folder, 'dist', 'main', 'electron-entry.js')),
      true,
      'the staged main entry is missing',
    );
    const files = listFiles(folder);
    const staged = files.filter((file) => isTestInstrumentationPath(file.slice(folder.length)));
    assert.deepEqual(staged, [], 'no staged path may name test-instrumentation');
    for (const text of INSTRUMENTATION_ONLY_STRINGS) {
      assert.deepEqual(
        textFilesContaining(folder, files, text),
        [],
        `no staged text file may contain ${text}`,
      );
    }
  },
);

test(
  'an instrumented package stages the instrumentation and holds every instrumentation-only string',
  {
    skip: process.env.JOY_MEDIA_STAGED_INSTRUMENTED
      ? false
      : 'JOY_MEDIA_STAGED_INSTRUMENTED is not set',
  },
  () => {
    const folder = process.env.JOY_MEDIA_STAGED_INSTRUMENTED;
    assert.equal(
      existsSync(join(folder, 'dist', 'main', 'test-instrumentation', 'index.js')),
      true,
      'the instrumented package must stage dist/main/test-instrumentation/index.js',
    );
    const files = listFiles(folder);
    for (const text of INSTRUMENTATION_ONLY_STRINGS) {
      assert.notDeepEqual(
        textFilesContaining(folder, files, text),
        [],
        `an instrumented package must contain ${text}`,
      );
    }
  },
);
