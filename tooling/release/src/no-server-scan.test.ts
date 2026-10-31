import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scanScript = resolve(import.meta.dirname, 'no-server-scan.ts');
const sourceForbiddenStrings = [
  'joyst.ir/api',
  'joyst.ir/v1/auth',
  '/v1/entitlements',
  '/v1/billing',
  '/v1/releases',
  'getRemoteApiBaseUrl',
  'alchemy',
  'usdc',
];
const packagedForbiddenStrings = [
  'gpu-events.jsonl',
  'gpu-diagnostics.jsonl',
  '--joy-media-gpu-diagnostics',
  '--joy-media-test-user-data',
  'crashReporter',
];
let root = '';
let staged = '';
let allowListPath = '';

function createAllowList(path = allowListPath): void {
  const entries = [
    {
      pattern: '**/*.test.*',
      reason: 'Test source files are not part of shipped application source.',
    },
    {
      pattern: '**/*.spec.*',
      reason: 'Test source files are not part of shipped application source.',
    },
    {
      pattern: 'packages/test-control-plane/src/**',
      reason: 'This package contains development-only fixture code and is not shipped.',
    },
    {
      pattern: 'apps/account-web/src/**',
      reason:
        'P6 implements PLAN-v4 §4b and deletes api.ts; its one current hit is /v1/releases/' +
        '$' +
        '{channel} at apps/account-web/src/api.ts:151.',
    },
  ];
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ entries }, null, 2) + '\n', 'utf8');
}

function writeSource(relativePath: string, contents: string): void {
  const filePath = join(root, ...relativePath.split('/'));
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function writeStaged(relativePath: string, contents: string): void {
  const filePath = join(staged, ...relativePath.split('/'));
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

function runScan(customAllowList = allowListPath, scanRoot = root, stagedDirectory = staged) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      scanScript,
      'scan',
      '--root',
      scanRoot,
      '--staged',
      stagedDirectory,
      '--allow-list',
      customAllowList,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return { status: result.status, output: String(result.stdout) + String(result.stderr) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'joy-no-server-scan-'));
  staged = join(root, 'staged');
  allowListPath = join(root, 'tooling/release/no-server-scan.allow.json');
  mkdirSync(join(root, 'apps/example/src'), { recursive: true });
  mkdirSync(join(root, 'packages/example/src'), { recursive: true });
  writeSource('apps/example/src/index.ts', 'export const appReady = true;\n');
  writeSource('packages/example/src/index.ts', 'export const packageReady = true;\n');
  writeStaged('resources/app/cli/joy-media-bundle.mjs', 'console.log("safe");\n');
  createAllowList();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('no-server-scan.ts source scope', () => {
  it('reports a forbidden string planted in a scanned source file', () => {
    writeSource('apps/example/src/probe.ts', "const route = 'joyst.ir/api';\n");

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("apps/example/src/probe.ts:1: const route = 'joyst.ir/api';");
  });

  it.each(sourceForbiddenStrings)('matches the source string %s', (forbidden) => {
    writeSource('packages/example/src/probe.ts', "const value = '" + forbidden + "';\n");

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(forbidden);
    expect(result.output).toContain('packages/example/src/probe.ts:1:');
  });

  it('returns zero hits for a clean source tree', () => {
    writeSource('apps/example/src/index.ts', 'export const ready = true;\n');
    writeSource('packages/example/src/index.ts', 'export const ready = true;\n');

    const result = runScan();

    expect(result.status).toBe(0);
    expect(result.output).toContain('0 hits');
    expect(result.output).toContain('2 source text files');
  });

  it('does not treat a case-different identifier as the literal forbidden string', () => {
    writeSource(
      'packages/example/src/budget.ts',
      'export interface Budget { spendLimitUsdCents: number; }\n',
    );

    const result = runScan();

    expect(result.status).toBe(0);
    expect(result.output).toContain('0 hits');
  });

  it('scans the real shipped source tree and reports its measured file and hit counts', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../..');
    const repositoryAllowList = resolve(
      repositoryRoot,
      'tooling/release/no-server-scan.allow.json',
    );

    const result = runScan(repositoryAllowList, repositoryRoot, staged);

    console.log('REAL_SCAN: ' + result.output.trim());
    expect(result.status).toBe(0);
    expect(result.output).toMatch(
      /Scanned [1-9]\d* source text files and 1 packaged text files; 0 hits\./,
    );
  });

  it('excludes test files through the allow-list', () => {
    writeSource('apps/example/src/route.test.ts', "const route = 'joyst.ir/api';\n");
    writeSource('packages/test-control-plane/src/fixture.ts', "const route = 'joyst.ir/api';\n");

    const result = runScan();

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('route.test.ts');
    expect(result.output).not.toContain('packages/test-control-plane');
  });

  it('refuses an allow-list entry without a reason', () => {
    const invalidAllowListPath = join(root, 'invalid-allow-list.json');
    writeFileSync(
      invalidAllowListPath,
      JSON.stringify({ entries: [{ pattern: 'apps/example/src/**' }] }),
      'utf8',
    );

    const result = runScan(invalidAllowListPath);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('entry 1 has no non-empty reason');
  });
});

describe('no-server-scan.ts packaged output scope', () => {
  it('reports forbidden strings in staged resources/app text files', () => {
    writeStaged('resources/app/config.txt', 'first line\nsecond line has /v1/billing\n');

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('resources/app/config.txt:2: second line has /v1/billing');
  });

  it.each(packagedForbiddenStrings)('rejects packaged test instrumentation marker %s', (marker) => {
    writeStaged('resources/app/diagnostics.txt', 'marker: ' + marker + '\n');

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(marker);
  });

  it('rejects any staged path containing test-instrumentation', () => {
    writeStaged('resources/app/test-instrumentation/marker.js', 'const safe = true;\n');

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      'resources/app/test-instrumentation/marker.js:1: staged path contains test-instrumentation',
    );
  });

  it('rejects a staged test-control-plane package', () => {
    writeStaged('resources/app/packages/test-control-plane/fixture.js', 'export {};\n');

    const result = runScan();

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('packages/test-control-plane');
  });
});
