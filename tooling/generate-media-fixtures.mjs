import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  'image.png': { mime: 'image/png', width: 320, height: 180 },
  'image.jpg': { mime: 'image/jpeg', width: 320, height: 180 },
  'video.mp4': {
    mime: 'video/mp4',
    durationUs: 3_000_000,
    width: 320,
    height: 180,
    sampleRate: 48_000,
    channels: 1,
  },
  'audio.wav': { mime: 'audio/wav', durationUs: 3_000_000, sampleRate: 48_000, channels: 1 },
  'audio.mp3': { mime: 'audio/mpeg', durationUs: 3_000_000, sampleRate: 48_000, channels: 1 },
  'captions-en.srt': { mime: 'application/x-subrip' },
  'captions-fa.vtt': { mime: 'text/vtt' },
  'invalid.txt': { mime: 'text/plain' },
  'corrupt.mp4': { mime: 'video/mp4' },
};
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
]) {
  const bytes = readFileSync(join(root, name));
  manifest[name] = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...descriptors[name],
  };
}
writeFileSync(
  join(root, 'manifest.json'),
  `${JSON.stringify({ version: 1, generatedBy: 'tooling/generate-media-fixtures.mjs', files: manifest }, null, 2)}\n`,
);
console.log(`Generated ${Object.keys(manifest).length} fixtures in ${root}`);
