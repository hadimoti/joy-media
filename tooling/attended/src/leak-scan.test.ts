import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanForLiteralValues } from './leak-scan.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leak-scan-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanForLiteralValues', () => {
  it('counts UTF-8 and UTF-16LE matches in nested files and binary content', () => {
    writeFileSync(join(root, 'evidence.txt'), 'alpha-secret and alpha-secret again');
    writeFileSync(join(root, 'profile.log'), Buffer.from('alpha-secret', 'utf16le'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'trace.txt'), 'beta-token');
    writeFileSync(
      join(root, 'nested', 'blob.bin'),
      Buffer.from([0, 1, ...Buffer.from('beta-token'), 2]),
    );

    const result = scanForLiteralValues(root, ['alpha-secret', 'beta-token', 'absent-value']);
    expect(result.filesScanned).toBe(4);
    expect(result.matchesByValue).toEqual([3, 2, 0]);
    expect(result.total).toBe(5);
  });

  it('never returns the values or the text around them', () => {
    writeFileSync(join(root, 'evidence.txt'), 'token alpha-secret here');
    const result = scanForLiteralValues(root, ['alpha-secret']);
    expect(JSON.stringify(result)).not.toContain('alpha-secret');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  it('ignores an empty value, so it cannot match everything (negative control)', () => {
    writeFileSync(join(root, 'evidence.txt'), 'any text at all');
    expect(scanForLiteralValues(root, ['']).matchesByValue).toEqual([0]);
  });

  it('reports zero files and zero matches for an empty folder', () => {
    expect(scanForLiteralValues(root, ['alpha-secret'])).toEqual({
      filesScanned: 0,
      matchesByValue: [0],
      total: 0,
    });
  });
});
