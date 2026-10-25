import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPayloadManifest,
  isSafePayloadPath,
  parsePayloadManifest,
} from './installer-payload-manifest.mjs';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'payload-manifest-'));
  mkdirSync(join(root, 'resources', 'app'), { recursive: true });
  writeFileSync(join(root, 'joy-media.exe'), 'exe bytes');
  writeFileSync(join(root, 'resources', 'app', 'package.json'), '{"version":"1.0.3"}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installer payload manifest', () => {
  it('lists every payload file with its SHA-256, in forward-slash order', async () => {
    const parsed = parsePayloadManifest(await buildPayloadManifest(root));
    expect([...parsed.keys()]).toEqual(['joy-media.exe', 'resources/app/package.json']);
    expect(parsed.get('joy-media.exe')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes when any payload byte changes, so a tampered file cannot match its manifest', async () => {
    const before = parsePayloadManifest(await buildPayloadManifest(root)).get('joy-media.exe');
    writeFileSync(join(root, 'joy-media.exe'), 'exe bytes, changed');
    const after = parsePayloadManifest(await buildPayloadManifest(root)).get('joy-media.exe');
    expect(after).not.toBe(before);
  });

  it('refuses unsafe, malformed and duplicate lines', () => {
    const digest = 'a'.repeat(64);
    expect(() => parsePayloadManifest(`${digest}  ../outside.exe\n`)).toThrow(/Malformed/u);
    expect(() => parsePayloadManifest(`${digest}  /absolute.exe\n`)).toThrow(/Malformed/u);
    expect(() => parsePayloadManifest(`${digest}  bin\\joy.cmd\n`)).toThrow(/Malformed/u);
    expect(() => parsePayloadManifest('not a digest  file.exe\n')).toThrow(/Malformed/u);
    expect(() => parsePayloadManifest(`${digest}  same.exe\n${digest}  same.exe\n`)).toThrow(
      /Duplicate/u,
    );
    expect(() => parsePayloadManifest('# only a comment\n')).toThrow(/no files/u);
  });

  it('accepts only safe relative paths', () => {
    expect(isSafePayloadPath('resources/app/package.json')).toBe(true);
    expect(isSafePayloadPath('')).toBe(false);
    expect(isSafePayloadPath('a/../b')).toBe(false);
    expect(isSafePayloadPath('a//b')).toBe(false);
    expect(isSafePayloadPath('./a')).toBe(false);
  });
});
