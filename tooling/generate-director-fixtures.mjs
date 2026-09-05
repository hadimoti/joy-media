import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const mediaRoot = join(root, 'packages', 'test-fixtures', 'live-director-generated');
const manifestPath = join(root, 'tooling', 'fixtures', 'joy-director-fixture-manifest.json');
mkdirSync(mediaRoot, { recursive: true });

const run = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
const probe = (path) =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,start_time:stream=codec_name,codec_type,time_base,sample_rate,channels,nb_frames:frame=media_type,best_effort_timestamp_time,pkt_duration_time',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' },
    ),
  );
const fixturePath = (name) => join(mediaRoot, name);

/**
 * A tiny built-in bitmap alphabet keeps the fixture reproducible on machines
 * without Fontconfig or a system font. Black becomes transparent in the
 * video filter below; white pixels are the deliberately small text signal.
 */
function writePixelTextFixture() {
  const glyphs = {
    J: ['001', '001', '001', '101', '010'],
    O: ['010', '101', '101', '101', '010'],
    Y: ['101', '101', '010', '010', '010'],
    F: ['111', '100', '110', '100', '100'],
    I: ['111', '010', '010', '010', '111'],
    X: ['101', '101', '010', '101', '101'],
    T: ['111', '010', '010', '010', '010'],
    U: ['101', '101', '101', '101', '111'],
    R: ['110', '101', '110', '101', '101'],
    E: ['111', '100', '110', '100', '111'],
  };
  const width = 160;
  const height = 90;
  const pixels = Buffer.alloc(width * height * 3);
  const scale = 2;
  let cursorX = 10;
  const cursorY = 10;
  for (const character of 'JOY FIXTURE') {
    if (character === ' ') {
      cursorX += scale * 2;
      continue;
    }
    for (const [row, bits] of glyphs[character].entries())
      for (const [column, bit] of [...bits].entries()) {
        if (bit !== '1') continue;
        for (let y = 0; y < scale; y += 1)
          for (let x = 0; x < scale; x += 1) {
            const offset = ((cursorY + row * scale + y) * width + cursorX + column * scale + x) * 3;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
          }
      }
    cursorX += scale * 4;
  }
  writeFileSync(
    fixturePath('small-pixel-text.ppm'),
    Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]),
  );
}

writePixelTextFixture();

run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=30:duration=2',
  '-c:v',
  'libx264',
  '-bf',
  '0',
  '-pix_fmt',
  'yuv420p',
  fixturePath('cfr-numbered.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=30:duration=2',
  '-vf',
  "select='eq(n,0)+eq(n,1)+eq(n,5)+eq(n,6)+eq(n,14)+eq(n,15)+eq(n,29)+eq(n,45)',setpts=PTS",
  '-fps_mode',
  'vfr',
  '-c:v',
  'libx264',
  '-bf',
  '0',
  '-pix_fmt',
  'yuv420p',
  fixturePath('vfr-numbered.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=24:duration=2',
  '-c:v',
  'libx264',
  '-bf',
  '2',
  '-g',
  '24',
  '-pix_fmt',
  'yuv420p',
  fixturePath('b-frame-reorder.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=12:duration=1',
  '-output_ts_offset',
  '2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixturePath('nonzero-pts-origin.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=120x200:rate=24:duration=1',
  '-vf',
  'setsar=4/3',
  '-metadata:s:v:0',
  'rotate=90',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixturePath('portrait-rotation-sar.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=black:size=160x90:rate=30:duration=1',
  '-vf',
  "drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='between(t,0.5,0.533333)'",
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixturePath('single-frame-flash.mp4'),
]);
run([
  '-loop',
  '1',
  '-framerate',
  '30',
  '-i',
  fixturePath('small-pixel-text.ppm'),
  '-f',
  'lavfi',
  '-i',
  'color=c=navy:size=160x90:rate=30:duration=2',
  '-filter_complex',
  "[1:v]drawbox=x=0:y=0:w=iw:h=ih:color=orange:t=fill:enable='gte(t,0.5)',fade=t=in:st=1:d=0.5[background];[0:v]format=rgba,colorkey=black:0.01:0.0[text];[background][text]overlay=0:0:shortest=1",
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixturePath('cut-fade-small-text.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x90:rate=30:duration=12',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  fixturePath('long-sequence.mp4'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'anullsrc=channel_layout=mono:sample_rate=48000',
  '-t',
  '2',
  '-c:a',
  'pcm_s16le',
  fixturePath('silent-audio.wav'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'aevalsrc=sin(2*PI*220*t)+0.5*sin(2*PI*440*t):s=48000:d=2',
  '-c:a',
  'pcm_s16le',
  fixturePath('speech-like-synthetic.wav'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'aevalsrc=0.6*sin(2*PI*110*t)+0.2*sin(2*PI*330*t):s=48000:d=2',
  '-c:a',
  'pcm_s16le',
  fixturePath('music-like-synthetic.wav'),
]);
run([
  '-f',
  'lavfi',
  '-i',
  'color=c=purple:size=96x54:rate=12:duration=1',
  '-c:v',
  'libaom-av1',
  '-cpu-used',
  '8',
  '-crf',
  '40',
  '-pix_fmt',
  'yuv420p',
  fixturePath('av1-runtime-probe.webm'),
]);
writeFileSync(fixturePath('corrupt-truncated.mp4'), Buffer.from('not an MP4 container'));

const expectations = {
  'small-pixel-text.ppm': { profile: 'small-pixel-text-source', expectedEvents: [] },
  'cfr-numbered.mp4': { profile: 'cfr-numbered', expectedEvents: [] },
  'vfr-numbered.mp4': { profile: 'vfr-numbered', expectedEvents: [] },
  'b-frame-reorder.mp4': { profile: 'b-frame-reorder', expectedEvents: [] },
  'nonzero-pts-origin.mp4': { profile: 'nonzero-pts-origin', expectedEvents: [] },
  'portrait-rotation-sar.mp4': { profile: 'portrait-rotation-sar', expectedEvents: [] },
  'single-frame-flash.mp4': {
    profile: 'single-frame-flash',
    expectedEvents: [{ type: 'flash', startUs: 500000, endUs: 533334 }],
  },
  'cut-fade-small-text.mp4': {
    profile: 'cut-fade-small-text',
    expectedEvents: [
      { type: 'hard-cut', atUs: 500000 },
      { type: 'fade-in', startUs: 1000000, endUs: 1500000 },
      { type: 'small-text', text: 'JOY fixture' },
    ],
  },
  'long-sequence.mp4': { profile: 'long-sequence', expectedEvents: [] },
  'silent-audio.wav': { profile: 'silent-audio', expectedEvents: [] },
  'speech-like-synthetic.wav': { profile: 'speech-like-synthetic', expectedEvents: [] },
  'music-like-synthetic.wav': { profile: 'music-like-synthetic', expectedEvents: [] },
  'av1-runtime-probe.webm': {
    profile: 'runtime-codec-probe',
    expectedEvents: [],
    browserSupport: 'runtime-probed-not-assumed',
  },
  'corrupt-truncated.mp4': {
    profile: 'corrupt-truncated',
    expectedEvents: [],
    browserSupport: 'unsupported',
  },
};

const fixtures = Object.keys(expectations).map((name) => {
  const path = fixturePath(name);
  const bytes = readFileSync(path);
  const base = {
    name,
    path: `packages/test-fixtures/live-director-generated/${name}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    license: 'Generated deterministic developer fixture; no third-party media.',
    generatedBy: 'tooling/generate-director-fixtures.mjs (ffmpeg/ffprobe)',
    ...expectations[name],
  };
  if (name === 'corrupt-truncated.mp4' || name === 'small-pixel-text.ppm') return base;
  const metadata = probe(path);
  const video = metadata.streams?.find((stream) => stream.codec_type === 'video');
  const audio = metadata.streams?.find((stream) => stream.codec_type === 'audio');
  const videoFrames = (metadata.frames ?? [])
    .filter((frame) => frame.media_type === 'video')
    .map((frame) => Math.round(Number(frame.best_effort_timestamp_time) * 1_000_000));
  const audioFrames = (metadata.frames ?? []).filter((frame) => frame.media_type === 'audio');
  return {
    ...base,
    durationUs: Math.round(Number(metadata.format?.duration ?? 0) * 1_000_000),
    startUs: Math.round(Number(metadata.format?.start_time ?? 0) * 1_000_000),
    video: video
      ? {
          codec: video.codec_name,
          timeBase: video.time_base,
          frameCount: videoFrames.length,
          actualPresentationPtsUs: videoFrames,
        }
      : undefined,
    audio: audio
      ? {
          codec: audio.codec_name,
          sampleRate: Number(audio.sample_rate),
          channels: Number(audio.channels),
          packetCount: audioFrames.length,
        }
      : undefined,
  };
});

writeFileSync(manifestPath, `${JSON.stringify({ version: 1, fixtures }, null, 2)}\n`);
console.log(`Generated ${fixtures.length} Live Director fixtures and manifest.`);
