import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plan section 3.4 (serial project): every Vitest file that spawns a process runs in the serial-process project of
// vitest.config.ts, and no other file does. The list is vitest.serial-process.json. This test rebuilds the set from the files
// Vitest discovers, so a new spawning test that is not listed fails here instead of staying in the parallel project.
const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SELF = 'tooling/release/src/vitest-serial-project.test.ts';

// The same explicit files vitest.config.ts includes beside the src glob. Keep the two lists in step.
const EXPLICIT_TESTS = [
  'apps/desktop/scripts/cli-launcher-layout.test.mjs',
  'apps/desktop/scripts/installer-uninstall.test.mjs',
  'apps/desktop/scripts/installer-payload-manifest.test.mjs',
  'apps/desktop/scripts/installer-setup-contract.test.mjs',
  'apps/desktop/scripts/copy-cli-fonts.test.mjs',
  'apps/desktop/scripts/install-electron-windows.test.mjs',
  'tests/e2e/helpers/browser-console-audit.unit.ts',
  'tests/e2e/helpers/control-port.unit.ts',
  'tests/desktop/project-request-audit.unit.ts',
];

// The src test files that vitest.config.ts excludes. Vitest never runs them, so they are not in the discovered set either.
const EXCLUDED_TESTS: readonly RegExp[] = [
  /^tooling\/golden-render\/src\/first-party-scenes\.test\.ts$/u,
  /^packages\/html-scene-runtime\/src\/.*\.e2e\.test\.ts$/u,
  /^apps\/editor-web\/src\/p0-desktop-handoff\.test\.ts$/u,
  /^apps\/cli\/src\/commands\/p0-design\.e2e\.test\.ts$/u,
];

// A child_process import, or a call to a spawning function that is not a method (so `pattern.exec(` does not count).
const SPAWN_PATTERN =
  /from ['"](node:)?child_process['"]|(?<![.\w])(spawnSync|execFileSync|execFile|spawn|fork|exec)\(/u;

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
}

// The files Vitest discovers under vitest.config.ts: src test files under apps, packages and tooling, plus the explicit list.
function discoveredTests(): string[] {
  const files: string[] = [];
  for (const root of ['apps', 'packages', 'tooling']) {
    if (existsSync(join(repoRoot, root))) walk(join(repoRoot, root), files);
  }
  const srcTests = files
    .map((file) => relative(repoRoot, file).split(sep).join('/'))
    .filter((path) => /(^|\/)src\/.*\.test\.(ts|tsx)$/u.test(path));
  return [...srcTests, ...EXPLICIT_TESTS].filter(
    (path) => path !== SELF && !EXCLUDED_TESTS.some((pattern) => pattern.test(path)),
  );
}

const serialList: string[] = JSON.parse(
  readFileSync(join(repoRoot, 'vitest.serial-process.json'), 'utf8'),
) as string[];

describe('vitest serial-process project', () => {
  it('detects a process-spawning file, and not a method that only looks like one', () => {
    // The samples are joined so this file's own text never matches the pattern it tests.
    const importLine = 'import { spawn } from ' + "'node:" + "child_process';";
    const callLine = 'const child = spawn' + "('node', []);";
    const methodCall = 'const match = pattern.' + 'exec(text);';
    const prose = 'a spawned later step';
    expect(SPAWN_PATTERN.test(importLine)).toBe(true);
    expect(SPAWN_PATTERN.test(callLine)).toBe(true);
    expect(SPAWN_PATTERN.test(methodCall)).toBe(false);
    expect(SPAWN_PATTERN.test(prose)).toBe(false);
  });

  it('lists each file once, and only files that exist', () => {
    expect(new Set(serialList).size).toBe(serialList.length);
    for (const path of serialList) expect(existsSync(join(repoRoot, path)), path).toBe(true);
  });

  it('lists every discovered process-spawning test file, and no other', () => {
    const spawning = discoveredTests()
      .filter((path) => SPAWN_PATTERN.test(readFileSync(join(repoRoot, path), 'utf8')))
      .sort();
    expect([...serialList].sort()).toEqual(spawning);
  });
});
