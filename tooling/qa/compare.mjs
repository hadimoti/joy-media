import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const tolerance = 1;
const ffmpeg = process.env.JOY_MEDIA_FFMPEG || 'ffmpeg';
const ffprobe = process.env.JOY_MEDIA_FFPROBE || 'ffprobe';

function run(command, args, { input, encoding = 'buffer', includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`),
        );
        return;
      }
      const output = Buffer.concat(includeStderr ? [...stdout, ...stderr] : stdout);
      resolve(encoding === 'utf8' ? output.toString('utf8') : output);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function decodeRgb(file) {
  const probe = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  );
  const stream = probe.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error(`No video frame found in ${file}`);
  const bytes = await run(ffmpeg, [
    '-v',
    'error',
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  const expected = stream.width * stream.height * 3;
  if (bytes.length !== expected)
    throw new Error(`Decoded frame has ${bytes.length} bytes; expected ${expected}`);
  return { width: stream.width, height: stream.height, bytes };
}

export async function compareFrames(previewPath, exportPath, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const preview = await decodeRgb(previewPath);
  const exported = await decodeRgb(exportPath);
  let differingChannels = 0;
  let maxChannelDelta = 0;
  let sumChannelDelta = 0;
  let firstDifference = null;
  if (preview.width !== exported.width || preview.height !== exported.height) {
    firstDifference = {
      reason: 'dimension-mismatch',
      preview: { width: preview.width, height: preview.height },
      export: { width: exported.width, height: exported.height },
    };
  } else {
    for (let index = 0; index < preview.bytes.length; index += 1) {
      const delta = Math.abs(preview.bytes[index] - exported.bytes[index]);
      if (delta > tolerance) {
        differingChannels += 1;
        firstDifference ??= {
          channelIndex: index,
          pixelX: Math.floor(index / 3) % preview.width,
          pixelY: Math.floor(index / 3 / preview.width),
          previewValue: preview.bytes[index],
          exportValue: exported.bytes[index],
          delta,
        };
      }
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      sumChannelDelta += delta;
    }
  }
  const sideBySidePath = path.join(outputDir, 'side-by-side.png');
  await run(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    previewPath,
    '-i',
    exportPath,
    '-filter_complex',
    '[0:v]format=rgb24[left];[1:v]format=rgb24[right];[left][right]hstack=inputs=2[out]',
    '-map',
    '[out]',
    '-frames:v',
    '1',
    sideBySidePath,
  ]);
  const result = {
    status: !firstDifference ? 'pass' : 'fail',
    tolerancePerChannel: tolerance,
    preview: { path: path.resolve(previewPath), width: preview.width, height: preview.height },
    export: { path: path.resolve(exportPath), width: exported.width, height: exported.height },
    differingChannels,
    totalChannels: preview.bytes.length,
    maxChannelDelta,
    meanAbsoluteChannelDelta: preview.bytes.length ? sumChannelDelta / preview.bytes.length : 0,
    firstDifference,
    sideBySide: sideBySidePath,
  };
  const resultPath = path.join(outputDir, 'result.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, resultPath };
}

export async function probeMedia(mediaPath) {
  const data = JSON.parse(
    await run(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=size,duration:format_tags=title:stream=codec_name,codec_type,width,height,sample_rate,channels:format=duration,size',
        '-of',
        'json',
        mediaPath,
      ],
      { encoding: 'utf8' },
    ),
  );
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio');
  const loudnessOutput = await run(
    ffmpeg,
    ['-v', 'info', '-i', mediaPath, '-vn', '-af', 'volumedetect', '-f', 'null', 'NUL'],
    { encoding: 'utf8', includeStderr: true },
  ).catch((error) => error.message);
  const mean = loudnessOutput.match(/mean_volume:\s*(-?[\d.]+)\s*dB/i)?.[1];
  const peak = loudnessOutput.match(/max_volume:\s*(-?[\d.]+)\s*dB/i)?.[1];
  const format = data.format || {};
  return {
    path: path.resolve(mediaPath),
    sizeBytes: Number(format.size) || null,
    durationSeconds: Number(format.duration) || null,
    codecs: (data.streams || []).map((stream) => ({
      type: stream.codec_type,
      codec: stream.codec_name,
    })),
    audio: audio
      ? { sampleRate: Number(audio.sample_rate) || null, channels: audio.channels ?? null }
      : null,
    loudness: {
      meanVolumeDb: mean === undefined ? null : Number(mean),
      maxVolumeDb: peak === undefined ? null : Number(peak),
    },
  };
}

export async function extractExportFrame(exportPath, timestamp, outputPath, dimensions) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) < 0)
    throw new Error('Timestamp must be a non-negative number of seconds');
  const args = [
    '-y',
    '-v',
    'error',
    '-ss',
    String(timestamp),
    '-i',
    exportPath,
    '-frames:v',
    '1',
    '-update',
    '1',
  ];
  if (dimensions) args.push('-vf', `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`);
  args.push(outputPath);
  await run(ffmpeg, args);
  return outputPath;
}

function usage() {
  return 'Usage: node tooling/qa/compare.mjs --preview <monitor-fit.png> --export <video> --time <seconds> --out <directory> [--probe <media>]';
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--') || !args[index + 1]) throw new Error(usage());
    options[key.slice(2)] = args[++index];
  }
  if (!options.preview || !options.export || !options.time || !options.out)
    throw new Error(usage());
  await mkdir(options.out, { recursive: true });
  const framePath = path.join(options.out, 'export-frame.png');
  const preview = await decodeRgb(options.preview);
  await extractExportFrame(options.export, Number(options.time), framePath, preview);
  const result = await compareFrames(options.preview, framePath, options.out);
  if (options.probe) result.media = await probeMedia(options.probe);
  if (result.media) await writeFile(result.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
