import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  decodeWoff2Tables,
  libassCaptionFace,
  TRIPLETS,
  Woff2Error,
  woff2ToTrueType,
} from './woff2-to-ttf.mjs';

const fontFolder = new URL(
  '../../packages/html-scene-runtime/assets/fonts/noto-sans-arabic/',
  import.meta.url,
);
const libassFolder = new URL('libass/fonts/', fontFolder);
const manifest = JSON.parse(readFileSync(new URL('libass/manifest.json', fontFolder), 'utf8'));
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const readWoff2 = (file) => readFileSync(new URL(file, fontFolder));

test('each pinned libass face is rebuilt from its WOFF2 source byte for byte', () => {
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    const built = libassCaptionFace(readWoff2(entry.file.replace(/\.ttf$/u, '.woff2')), {
      weight: entry.weight,
      subset: entry.subset,
    });
    assert.equal(built.length, entry.byteLength, entry.file);
    assert.equal(sha256(built), entry.sha256, entry.file);
  }
});

test('the shipped libass faces match their pinned hashes', () => {
  for (const entry of manifest.files) {
    assert.equal(sha256(readFileSync(new URL(entry.file, libassFolder))), entry.sha256, entry.file);
  }
});

test('conversion is deterministic', () => {
  const woff2 = readWoff2('noto-sans-arabic-latin-400-normal.woff2');
  assert.ok(woff2ToTrueType(woff2).equals(woff2ToTrueType(woff2)));
});

test('the sfnt directory is sorted by tag and lists exactly the decoded tables', () => {
  const woff2 = readWoff2('noto-sans-arabic-arabic-400-normal.woff2');
  const { tables } = decodeWoff2Tables(woff2);
  const ttf = woff2ToTrueType(woff2);
  const count = ttf.readUInt16BE(4);
  const tags = Array.from({ length: count }, (_, index) =>
    ttf.toString('latin1', 12 + 16 * index, 16 + 16 * index),
  );
  assert.deepEqual(tags, [...tags].sort());
  assert.deepEqual(tags, [...tables.keys()].sort());
});

test('every triplet row has a byte count that matches its bit widths', () => {
  assert.equal(TRIPLETS.length, 128);
  for (const [byteCount, xBits, yBits] of TRIPLETS) {
    assert.equal(byteCount - 1, Math.ceil((xBits + yBits) / 8));
  }
});

test('rejects a file that is not WOFF2', () => {
  const file = Buffer.from(readWoff2('noto-sans-arabic-latin-400-normal.woff2'));
  file.write('wOFF', 0, 'latin1');
  assert.throws(() => woff2ToTrueType(file), Woff2Error);
});

test('rejects a file whose declared length differs from its size', () => {
  const file = readWoff2('noto-sans-arabic-latin-400-normal.woff2');
  assert.throws(() => woff2ToTrueType(file.subarray(0, file.length - 100)), Woff2Error);
});

test('rejects corrupted compressed data rather than producing a different font silently', () => {
  const pinned = manifest.files.find((entry) => entry.subset === 'latin' && entry.weight === 400);
  const file = Buffer.from(readWoff2('noto-sans-arabic-latin-400-normal.woff2'));
  file[file.length - 40] ^= 0xff;
  let converted = null;
  try {
    converted = woff2ToTrueType(file);
  } catch {
    return;
  }
  assert.notEqual(sha256(converted), pinned.sha256);
});

test('refuses a weight or subset that has no pinned face', () => {
  const woff2 = readWoff2('noto-sans-arabic-latin-400-normal.woff2');
  assert.throws(() => libassCaptionFace(woff2, { weight: 500, subset: 'latin' }));
  assert.throws(() => libassCaptionFace(woff2, { weight: 400, subset: 'cyrillic' }));
});
