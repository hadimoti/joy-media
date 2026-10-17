#!/usr/bin/env node

/**
 * Generate all JOY Media test fixtures with --out-dir support.
 * Usage: node tooling/generate-media-fixtures.mjs [--out-dir <path>]
 *
 * Without --out-dir the output defaults to packages/test-fixtures/media/.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TextEncoder } from 'node:util';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const outDirIndex = process.argv.indexOf('--out-dir');
let outDir;
if (outDirIndex !== -1) {
  const requestedOutDir = process.argv[outDirIndex + 1];
  if (!requestedOutDir || requestedOutDir.startsWith('--')) {
    throw new Error('usage: generate-media-fixtures.mjs [--out-dir <path>]');
  }
  outDir = resolve(process.cwd(), requestedOutDir);
} else {
  outDir = resolve(process.cwd(), 'packages', 'test-fixtures', 'media');
}

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const ffmpegVersion = () => {
  const out = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', maxBuffer: 8192 });
  return out.split(/\r?\n/u)[0] ?? 'ffmpeg version unknown';
};
const ffprobeVersion = () => {
  const out = execFileSync('ffprobe', ['-version'], { encoding: 'utf8', maxBuffer: 8192 });
  return out.split(/\r?\n/u)[0] ?? 'ffprobe version unknown';
};

// ---------------------------------------------------------------------------
// Step 1 — generate the 16 existing legacy fixtures (unchanged)
// ---------------------------------------------------------------------------

run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x2c2c2c:s=320x180:d=1',
  '-frames:v',
  '1',
  join(outDir, 'image.png'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0xb08a00:s=320x180:d=1',
  '-frames:v',
  '1',
  join(outDir, 'image.jpg'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x2f4858:s=160x96:d=1',
  '-frames:v',
  '1',
  '-c:v',
  'libwebp',
  '-lossless',
  '1',
  join(outDir, 'image.webp'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x96:rate=4',
  '-t',
  '1',
  '-vf',
  'fps=4,scale=160:96',
  join(outDir, 'animated.gif'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x96:rate=4',
  '-t',
  '1',
  '-c:v',
  'libwebp_anim',
  '-loop',
  '0',
  '-lossless',
  '1',
  join(outDir, 'animated.webp'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x180:rate=30',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '3',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  join(outDir, 'video.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '3',
  '-ac',
  '1',
  join(outDir, 'audio.wav'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000',
  '-t',
  '3',
  '-ac',
  '1',
  '-codec:a',
  'libmp3lame',
  join(outDir, 'audio.mp3'),
]);

writeFileSync(join(outDir, 'captions-en.srt'), '1\n00:00:00,000 --> 00:00:01,500\nJOY Media\n');
writeFileSync(
  join(outDir, 'captions-fa.vtt'),
  'WEBVTT\n\n00:00.000 --> 00:01.500\nاین یک آزمون است\n',
);
writeFileSync(join(outDir, 'invalid.txt'), 'This is not a media file.\n');
writeFileSync(join(outDir, 'corrupt.mp4'), new TextEncoder().encode('not an MP4 container\n'));
writeFileSync(join(outDir, 'corrupt.gif'), new TextEncoder().encode('GIF89a\x01\x00'));
writeFileSync(
  join(outDir, 'corrupt.webp'),
  new TextEncoder().encode('RIFF\x08\x00\x00\x00WEBPVP8X'),
);
writeFileSync(join(outDir, 'empty.bin'), new Uint8Array());
writeFileSync(join(outDir, 'joycode-attachment.md'), '# WP-29\n\nFixture attachment.\n');

// ---------------------------------------------------------------------------
// Step 2 — generate the 15 readiness fixtures
// ---------------------------------------------------------------------------

// 1) readiness-hard-cut.mkv — red 0-1s, blue 1-2s, 25fps, 320x180, audio
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0xFF0000:s=320x180:r=25:d=1',
  '-f',
  'lavfi',
  '-i',
  'color=c=0x0000FF:s=320x180:r=25:d=1',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=1',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:sample_rate=48000:duration=1',
  '-filter_complex',
  '[0:v][1:v]concat=n=2:v=1:a=0[vid];[2:a][3:a]concat=n=2:v=0:a=1[aud]',
  '-map',
  '[vid]',
  '-map',
  '[aud]',
  '-c:v',
  'ffv1',
  '-c:a',
  'pcm_s16le',
  join(outDir, 'readiness-hard-cut.mkv'),
]);

// 2) readiness-flash-click.mkv — dark video, single white frame at 1s, PCM click at 1s
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x000000:s=320x180:r=25:d=2',
  '-f',
  'lavfi',
  '-i',
  'aevalsrc=if(gte(t\\,1)*lt(t\\,1.02)\\,sin(2*PI*1000*t)*0.5\\,0):s=48000:c=mono:duration=2',
  '-filter_complex',
  '[0:v]drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable=gte(t\\,1)*lt(t\\,1.04)[vid]',
  '-map',
  '[vid]',
  '-map',
  '1:a',
  '-c:v',
  'ffv1',
  '-c:a',
  'pcm_s16le',
  join(outDir, 'readiness-flash-click.mkv'),
]);

// 3) readiness-silent.mp4 — video only, no audio stream
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x808080:s=320x180:r=25:d=2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-an',
  join(outDir, 'readiness-silent.mp4'),
]);

// 4) readiness-audio-only.wav — pure audio
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=2',
  '-ac',
  '1',
  join(outDir, 'readiness-audio-only.wav'),
]);

// 5) readiness-stereo-tones.wav — 440Hz left, 880Hz right, amplitude 0.5
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=2',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=880:sample_rate=48000:duration=2',
  '-filter_complex',
  '[0:a]volume=4[left];[1:a]volume=4[right];[left][right]amerge=inputs=2[out]',
  '-map',
  '[out]',
  join(outDir, 'readiness-stereo-tones.wav'),
]);

// 6) readiness-tone-44100.wav — 44100 Hz tone
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=44100:duration=2',
  '-ac',
  '1',
  join(outDir, 'readiness-tone-44100.wav'),
]);

// 7) readiness-tone-48000.wav — 48000 Hz tone
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=2',
  '-ac',
  '1',
  join(outDir, 'readiness-tone-48000.wav'),
]);

// 8) readiness-vfr.mkv — 5 frames at non-uniform PTS using select with non-uniform indices
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=25:duration=1',
  '-vf',
  "select='eq(n\\,0)+eq(n\\,3)+eq(n\\,7)+eq(n\\,12)+eq(n\\,20)'",
  '-fps_mode',
  'vfr',
  '-frames:v',
  '5',
  '-c:v',
  'ffv1',
  join(outDir, 'readiness-vfr.mkv'),
]);

// 9) readiness-ntsc-30000-1001.mp4 — 30000/1001 fps, 60 frames
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=320x180:r=30000/1001:d=2.002',
  '-frames:v',
  '60',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  join(outDir, 'readiness-ntsc-30000-1001.mp4'),
]);

// 10) readiness-rotation.mp4 — 90-degree rotation metadata
const rotationSource = join(outDir, '.readiness-rotation-source.mp4');
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=320x180:r=30:d=2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  rotationSource,
]);
run([
  '-display_rotation',
  '90',
  '-i',
  rotationSource,
  '-c',
  'copy',
  join(outDir, 'readiness-rotation.mp4'),
]);
rmSync(rotationSource, { force: true });

// 11) readiness-alpha.png — left opaque red, right transparent
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0xFF0000:s=64x64:d=1,format=rgba',
  '-vf',
  "geq=r=255:g=0:b=0:a='if(lt(X\\,32)\\,255\\,0)'",
  '-frames:v',
  '1',
  join(outDir, 'readiness-alpha.png'),
]);

// 12) readiness-odd-161x91.mkv — lossless 161x91
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=161x91:r=25:d=1',
  '-c:v',
  'ffv1',
  join(outDir, 'readiness-odd-161x91.mkv'),
]);

// 13) readiness-truncated.mp4 — generate a valid mp4 then truncate it
const truncTemp = join(outDir, 'readiness-truncated.mp4');
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=gray:s=320x180:r=30:d=1',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  truncTemp,
]);
{
  const full = readFileSync(truncTemp);
  writeFileSync(truncTemp, full.slice(0, Math.min(full.byteLength, 200)));
}

// 14) readiness-mislabeled.jpg — WAV content with .jpg extension
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=1',
  '-f',
  'wav',
  '-ac',
  '1',
  join(outDir, 'readiness-mislabeled.jpg'),
]);

// 15) paths with spaces/فارسی 😀 tone.wav
const unicodeDir = join(outDir, 'paths with spaces');
mkdirSync(unicodeDir, { recursive: true });
run([
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=1',
  '-ac',
  '1',
  join(unicodeDir, 'فارسی 😀 tone.wav'),
]);

// ---------------------------------------------------------------------------
// Step 3 — collect FFmpeg/FFprobe versions
// ---------------------------------------------------------------------------

const ffmpegVer = ffmpegVersion();
const ffprobeVer = ffprobeVersion();

// ---------------------------------------------------------------------------
// Step 4 — build the manifest
// ---------------------------------------------------------------------------

const existingNames = [
  'image.png',
  'image.jpg',
  'image.webp',
  'animated.gif',
  'animated.webp',
  'video.mp4',
  'audio.wav',
  'audio.mp3',
  'captions-en.srt',
  'captions-fa.vtt',
  'invalid.txt',
  'corrupt.mp4',
  'corrupt.gif',
  'corrupt.webp',
  'empty.bin',
  'joycode-attachment.md',
];

// Legacy descriptors use `mime` as the internal key (preserving old manifest format).
// The entry builder will also set `mimeType` from `mime`.
const legacyDescriptors = {
  'image.png': { kind: 'image', mime: 'image/png', width: 320, height: 180 },
  'image.jpg': { kind: 'image', mime: 'image/jpeg', width: 320, height: 180 },
  'image.webp': { kind: 'image', mime: 'image/webp', width: 160, height: 96 },
  'animated.gif': {
    kind: 'image',
    mime: 'image/gif',
    width: 160,
    height: 96,
    animation: { frameCount: 4, cycleDurationUs: 1_000_000, loopCount: 0, hasAlpha: true },
  },
  'animated.webp': {
    kind: 'image',
    mime: 'image/webp',
    width: 160,
    height: 96,
    animation: { frameCount: 4, cycleDurationUs: 1_000_000, loopCount: 0, hasAlpha: true },
  },
  'video.mp4': {
    kind: 'video',
    mime: 'video/mp4',
    durationUs: 3_000_000,
    width: 320,
    height: 180,
    sampleRate: 48_000,
    channels: 1,
  },
  'audio.wav': {
    kind: 'audio',
    mime: 'audio/wav',
    durationUs: 3_000_000,
    sampleRate: 48_000,
    channels: 1,
  },
  'audio.mp3': {
    kind: 'audio',
    mime: 'audio/mpeg',
    durationUs: 3_000_000,
    sampleRate: 48_000,
    channels: 1,
  },
  'captions-en.srt': { kind: 'caption', mime: 'application/x-subrip' },
  'captions-fa.vtt': { kind: 'caption', mime: 'text/vtt' },
  'invalid.txt': { kind: 'invalid', mime: 'text/plain' },
  'corrupt.mp4': { kind: 'invalid', mime: 'video/mp4' },
  'empty.bin': { kind: 'invalid', mime: 'application/octet-stream' },
  'joycode-attachment.md': { kind: 'attachment', mime: 'text/markdown' },
  'corrupt.gif': { kind: 'invalid', mime: 'image/gif' },
  'corrupt.webp': { kind: 'invalid', mime: 'image/webp' },
};

const legacyExpectedDecoded = {
  'image.png': { width: 320, height: 180, format: 'png' },
  'image.jpg': { width: 320, height: 180, format: 'jpeg' },
  'image.webp': { width: 160, height: 96, format: 'webp' },
  'animated.gif': { width: 160, height: 96, frames: 4, durationUs: 1_000_000, hasAlpha: true },
  'animated.webp': { width: 160, height: 96, frames: 4, durationUs: 1_000_000, hasAlpha: true },
  'video.mp4': {
    width: 320,
    height: 180,
    frames: 90,
    frameRate: '30/1',
    durationUs: 3_000_000,
    streams: ['video', 'audio'],
    sampleRate: 48_000,
    channels: 1,
  },
  'audio.wav': { durationUs: 3_000_000, streams: ['audio'], sampleRate: 48_000, channels: 1 },
  'audio.mp3': { durationUs: 3_000_000, streams: ['audio'], sampleRate: 48_000, channels: 1 },
  'captions-en.srt': { kind: 'caption-text', language: 'en' },
  'captions-fa.vtt': { kind: 'caption-text', language: 'fa', direction: 'rtl' },
  'invalid.txt': { decodable: false },
  'corrupt.mp4': { decodable: false },
  'corrupt.gif': { decodable: false },
  'corrupt.webp': { decodable: false },
  'empty.bin': { decodable: false },
  'joycode-attachment.md': { kind: 'markdown-text' },
};

const syntheticProvenance = {
  kind: 'synthetic',
  license: 'Generated deterministic developer fixture; no third-party media.',
};
const fixtureConsumers = ['cli', 'editor', 'desktop', 'release'];

const readinessMetadata = {
  'readiness-hard-cut.mkv': {
    kind: 'video',
    mimeType: 'video/x-matroska',
    purpose: 'Hard cut from red to blue at 1 s with simultaneous audio',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, frames: 50, durationUs: 2_000_000, hasAudio: true },
  },
  'readiness-flash-click.mkv': {
    kind: 'video',
    mimeType: 'video/x-matroska',
    purpose: 'Single white video frame at 1 s and PCM click at 1 s on dark background',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, onsetUs: 1_000_000, hasAudio: true },
  },
  'readiness-silent.mp4': {
    kind: 'video',
    mimeType: 'video/mp4',
    purpose: 'Silent video with no audio stream',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, hasAudio: false },
  },
  'readiness-audio-only.wav': {
    kind: 'audio',
    mimeType: 'audio/wav',
    purpose: 'Audio-only WAV with no video stream',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { sampleRate: 48_000, channels: 1, durationUs: 2_000_000 },
  },
  'readiness-stereo-tones.wav': {
    kind: 'audio',
    mimeType: 'audio/wav',
    purpose: 'Stereo WAV with 440 Hz left and 880 Hz right at half amplitude',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: {
      sampleRate: 48_000,
      channels: 2,
      leftFrequencyHz: 440,
      rightFrequencyHz: 880,
    },
  },
  'readiness-tone-44100.wav': {
    kind: 'audio',
    mimeType: 'audio/wav',
    purpose: 'Mono tone at 44100 Hz sample rate',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { sampleRate: 44_100, channels: 1 },
  },
  'readiness-tone-48000.wav': {
    kind: 'audio',
    mimeType: 'audio/wav',
    purpose: 'Mono tone at 48000 Hz sample rate',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { sampleRate: 48_000, channels: 1 },
  },
  'readiness-vfr.mkv': {
    kind: 'video',
    mimeType: 'video/x-matroska',
    purpose: 'Variable frame rate MKV with 5 frames at non-uniform PTS',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, frames: 5 },
  },
  'readiness-ntsc-30000-1001.mp4': {
    kind: 'video',
    mimeType: 'video/mp4',
    purpose: 'NTSC 30000/1001 fps video with 60 frames',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, frames: 60, frameRate: '30000/1001' },
  },
  'readiness-rotation.mp4': {
    kind: 'video',
    mimeType: 'video/mp4',
    purpose: 'Video with 90-degree rotation metadata',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 320, height: 180, rotationDeg: 90 },
  },
  'readiness-alpha.png': {
    kind: 'image',
    mimeType: 'image/png',
    purpose: 'PNG with fully opaque left half and fully transparent right half',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: {
      width: 64,
      height: 64,
      hasAlpha: true,
      opaqueLeft: true,
      transparentRight: true,
    },
  },
  'readiness-odd-161x91.mkv': {
    kind: 'video',
    mimeType: 'video/x-matroska',
    purpose: 'Lossless video with odd dimensions 161x91',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { width: 161, height: 91 },
  },
  'readiness-truncated.mp4': {
    kind: 'invalid',
    mimeType: 'video/mp4',
    purpose: 'Truncated MP4 that fails ffprobe',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { truncated: true },
  },
  'readiness-mislabeled.jpg': {
    kind: 'invalid',
    mimeType: 'image/jpeg',
    purpose: 'WAV audio payload deliberately named .jpg to catch extension-based misclassification',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: {
      payloadFormat: 'wav',
      sampleRate: 48_000,
      channels: 1,
      extensionMismatch: true,
    },
  },
  'paths with spaces/فارسی 😀 tone.wav': {
    kind: 'audio',
    mimeType: 'audio/wav',
    purpose: 'Tone WAV at a Unicode path with spaces, RTL text, and emoji',
    generatedBy: `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: { kind: 'synthetic', license: 'Generated for JOY Media readiness tests' },
    consumers: ['cli', 'editor', 'desktop', 'release'],
    expectedDecoded: { sampleRate: 48_000, channels: 1 },
  },
};

const allNames = [...existingNames, ...Object.keys(readinessMetadata)].sort();

const files = {};
for (const name of allNames) {
  const path = join(outDir, name);
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const legacyDesc = legacyDescriptors[name];
  const readinessMeta = readinessMetadata[name];

  const entry = {
    sha256,
    bytes: bytes.byteLength,
    name,
    kind: readinessMeta?.kind ?? legacyDesc.kind,
    mimeType: readinessMeta?.mimeType ?? legacyDesc.mime,
    purpose:
      readinessMeta?.purpose ??
      `Deterministic ${legacyDesc.kind} fixture for JOY Media import and validation tests.`,
    generatedBy:
      readinessMeta?.generatedBy ??
      `tooling/generate-media-fixtures.mjs using ${ffmpegVer} / ${ffprobeVer}`,
    provenance: readinessMeta?.provenance ?? syntheticProvenance,
    consumers: readinessMeta?.consumers ?? fixtureConsumers,
    expectedDecoded: readinessMeta?.expectedDecoded ?? legacyExpectedDecoded[name],
    ...(legacyDesc ? { ...legacyDesc } : {}),
  };

  // Overwrite kind/mimeType from readiness meta when present (readiness entries
  // may set kind/mimeType directly)
  if (readinessMeta) {
    const { kind: _rk, mimeType: _rm, ...readinessRest } = readinessMeta;
    Object.assign(entry, readinessRest);
  }

  files[name] = entry;
}

// Duration metadata for original assets
if (files['video.mp4']) files['video.mp4'].durationUs = 3_000_000;
if (files['audio.wav']) files['audio.wav'].durationUs = 3_000_000;
if (files['audio.mp3']) files['audio.mp3'].durationUs = 3_000_000;

const manifest = {
  version: 2,
  generatedBy: 'tooling/generate-media-fixtures.mjs',
  toolchain: {
    ffmpegVersion: ffmpegVer,
    ffprobeVersion: ffprobeVer,
  },
  files,
};

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Generated ${Object.keys(files).length} fixtures in ${outDir}`);
