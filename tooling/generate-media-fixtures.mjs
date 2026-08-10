import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextEncoder } from 'node:util';

const root = join(process.cwd(), 'packages', 'test-fixtures', 'media');
mkdirSync(root, { recursive: true });
const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0x2c2c2c:s=320x180:d=1',
  '-frames:v',
  '1',
  join(root, 'image.png'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=0xb08a00:s=320x180:d=1',
  '-frames:v',
  '1',
  join(root, 'image.jpg'),
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
  join(root, 'video.mp4'),
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
  join(root, 'audio.wav'),
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
  join(root, 'audio.mp3'),
]);
const manifest = {};
const descriptors = {
  'image.png': { kind: 'image', mime: 'image/png', width: 320, height: 180 },
  'image.jpg': { kind: 'image', mime: 'image/jpeg', width: 320, height: 180 },
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
};
writeFileSync(join(root, 'captions-en.srt'), '1\n00:00:00,000 --> 00:00:01,500\nJOY Media\n');
writeFileSync(
  join(root, 'captions-fa.vtt'),
  'WEBVTT\n\n00:00.000 --> 00:01.500\nاین یک آزمون است\n',
);
writeFileSync(join(root, 'invalid.txt'), 'This is not a media file.\n');
writeFileSync(join(root, 'corrupt.mp4'), new TextEncoder().encode('not an MP4 container\n'));
writeFileSync(join(root, 'empty.bin'), new Uint8Array());
writeFileSync(join(root, 'joycode-attachment.md'), '# WP-29\n\nFixture attachment.\n');
for (const name of [
  'image.png',
  'image.jpg',
  'video.mp4',
  'audio.wav',
  'audio.mp3',
  'captions-en.srt',
  'captions-fa.vtt',
  'invalid.txt',
  'corrupt.mp4',
  'empty.bin',
  'joycode-attachment.md',
]) {
  const bytes = readFileSync(join(root, name));
  manifest[name] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    name,
    kind: descriptors[name].kind,
    mimeType: descriptors[name].mime,
    ...descriptors[name],
  };
}
writeFileSync(
  join(root, 'manifest.json'),
  `${JSON.stringify({ version: 1, generatedBy: 'tooling/generate-media-fixtures.mjs', files: manifest }, null, 2)}\n`,
);
console.log(`Generated ${Object.keys(manifest).length} fixtures in ${root}`);
