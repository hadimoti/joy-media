import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeInstalledCliEnvironment } from './installed-cli-environment.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = resolve(repoRoot, 'packages/test-fixtures/media/video.mp4');

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function requireWithin(path, root, label) {
  const relativePath = relative(root, path);
  assert.ok(
    relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath),
    `${label} must be a child of ${root}; received ${path}`,
  );
}

function runCli(launcherPath, args, env, label) {
  const quoteCmdArgument = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const command = `call ${quoteCmdArgument(launcherPath)} ${args.map(quoteCmdArgument).join(' ')}`;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
    cwd: dirname(launcherPath),
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  assert.equal(
    result.error,
    undefined,
    `${label} could not start the packaged CLI launcher: ${result.error?.message ?? ''}`,
  );
  assert.equal(
    result.status,
    0,
    `${label} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stdout.includes('\u001b['), false, `${label} wrote ANSI escapes`);
  return result.stdout;
}

function parseSingleJson(stdout, label) {
  const trimmed = stdout.trim();
  assert.ok(
    trimmed.startsWith('{') || trimmed.startsWith('['),
    `${label} wrote a banner before JSON`,
  );
  return JSON.parse(trimmed);
}

function resolveWindowsToolPath(name) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(
    systemRoot && isAbsolute(systemRoot),
    'SystemRoot is required to locate Windows tools.',
  );
  const system32 = join(systemRoot, 'System32');
  const wherePath = join(system32, 'where.exe');
  const result = spawnSync(wherePath, [`${name}.exe`], {
    encoding: 'utf8',
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: process.env.PATH ?? system32,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    windowsHide: true,
  });
  assert.equal(
    result.error,
    undefined,
    `Could not locate ${name}.exe: ${result.error?.message ?? ''}`,
  );
  assert.equal(result.status, 0, `${name}.exe is required on PATH.`);
  const executablePath = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => isAbsolute(entry) && existsSync(entry));
  assert.ok(executablePath, `Could not resolve an absolute ${name}.exe path.`);
  return realpathSync(executablePath);
}

const [, , launcherArgument, stateArgument, evidenceArgument] = process.argv;
assert.ok(
  launcherArgument,
  'Usage: node installed-cli-acceptance.mjs <joy.cmd|joy-media.cmd> <temp-state-dir> [evidence-dir]',
);
assert.ok(stateArgument, 'A disposable state directory is required.');

const launcherPath = realpathSync(resolve(launcherArgument));
const stateDirectory = resolve(stateArgument);
const temporaryRoot = resolve(tmpdir());
const stateName = stateDirectory.split(/[\\/]/).at(-1) ?? '';
const evidenceDirectory = resolve(evidenceArgument ?? join(stateDirectory, 'evidence'));
requireWithin(stateDirectory, temporaryRoot, 'State directory');
assert.equal(
  dirname(stateDirectory),
  temporaryRoot,
  'State directory must be a direct child of the OS temp directory.',
);
assert.match(
  stateName,
  /^joy-media-installed-cli-[a-z0-9-]+$/i,
  'State directory must use the disposable acceptance prefix.',
);
assert.equal(existsSync(stateDirectory), false, 'State directory must not already exist.');
requireWithin(evidenceDirectory, stateDirectory, 'Evidence directory');
assert.ok(
  ['joy.cmd', 'joy-media.cmd'].includes(launcherPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''),
  'Launcher must be the packaged joy.cmd or joy-media.cmd entry point.',
);
assert.ok(
  existsSync(join(dirname(launcherPath), 'joy-media.exe')),
  'Packaged joy-media.exe is missing.',
);
const bundlePath = join(dirname(launcherPath), 'resources', 'app', 'cli', 'joy-media-bundle.mjs');
const workerPath = join(dirname(launcherPath), 'resources', 'app', 'worker', 'joy-worker.exe');
assert.ok(existsSync(bundlePath), 'Packaged CLI bundle is missing.');
assert.ok(existsSync(workerPath), 'Packaged JOY Worker executable is missing.');
assert.ok(existsSync(fixturePath), `Video fixture is missing: ${fixturePath}`);
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
const ffmpegPath = resolveWindowsToolPath('ffmpeg');
const ffprobePath = resolveWindowsToolPath('ffprobe');
assert.equal(
  spawnSync(ffmpegPath, ['-version'], { windowsHide: true }).status,
  0,
  'FFmpeg is required.',
);
assert.equal(
  spawnSync(ffprobePath, ['-version'], { windowsHide: true }).status,
  0,
  'FFprobe is required.',
);

mkdirSync(stateDirectory, { recursive: true });
mkdirSync(evidenceDirectory, { recursive: true });
const env = safeInstalledCliEnvironment({
  stateDirectory,
  systemRoot,
  executablePaths: [ffmpegPath, ffprobePath],
});
const databasePath = env.JOY_MEDIA_SQLITE_PATH;
mkdirSync(dirname(databasePath), { recursive: true });
const workerSelfTest = spawnSync(workerPath, ['--joy-worker-self-test'], {
  encoding: 'utf8',
  env,
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(
  workerSelfTest.status,
  0,
  `Packaged Worker self-test failed: ${workerSelfTest.stderr}`,
);
assert.equal(JSON.parse(workerSelfTest.stdout).ok, true);
const title = 'Installed CLI readiness فارسی';
const create = parseSingleJson(
  runCli(
    launcherPath,
    ['project', 'create', title, '--sqlite-path', databasePath, '--json'],
    env,
    'project create',
  ),
  'project create',
);
assert.equal(create.title, title);
assert.equal(resolve(create.sqlitePath), resolve(databasePath));

const projectId = create.id;
assert.equal(typeof projectId, 'string');
const add = parseSingleJson(
  runCli(
    launcherPath,
    [
      'timeline',
      'add-clip',
      '--project',
      projectId,
      '--asset',
      fixturePath,
      '--sqlite-path',
      databasePath,
      '--json',
    ],
    env,
    'timeline add-clip',
  ),
  'timeline add-clip',
);
assert.equal(add.changed, true);

const reopened = parseSingleJson(
  runCli(
    launcherPath,
    ['project', 'show', projectId, '--sqlite-path', databasePath, '--json'],
    env,
    'fresh-process project show',
  ),
  'fresh-process project show',
);
assert.equal(reopened.title, title);
assert.equal(reopened.assetCount, 1);
assert.equal(reopened.tracks.flatMap((track) => track.clips).length, 1);

const outputDirectory = join(stateDirectory, 'خروجی playable');
const renderStdout = runCli(
  launcherPath,
  [
    'render',
    '--project',
    projectId,
    '--out',
    outputDirectory,
    '--sqlite-path',
    databasePath,
    '--json',
  ],
  env,
  'real media render',
);
const events = renderStdout
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
const completion = events.at(-1);
assert.equal(completion?.type, 'complete');
assert.equal(completion?.mediaProduced, true);
const mediaPath = resolve(completion.artifactPath);
requireWithin(mediaPath, outputDirectory, 'Rendered media');
assert.ok(existsSync(mediaPath), `Rendered video is missing: ${mediaPath}`);
const manifestPath = `${mediaPath}.manifest.json`;
assert.ok(existsSync(manifestPath), 'Render manifest is missing.');
const probe = JSON.parse(
  execFileSync(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', mediaPath],
    { env, encoding: 'utf8', windowsHide: true },
  ),
);
const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
assert.equal(videoStream?.codec_name, 'h264');
assert.equal(audioStream?.codec_name, 'aac');
assert.ok(Number(probe.format.duration) >= 2.9);
execFileSync(ffmpegPath, ['-v', 'error', '-i', mediaPath, '-f', 'null', '-'], {
  env,
  windowsHide: true,
});

const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const lockPath = join(repoRoot, 'pnpm-lock.yaml');
const fixtureManifestPath = join(repoRoot, 'packages', 'test-fixtures', 'media', 'manifest.json');
const evidence = {
  schemaVersion: 1,
  result: 'passed',
  generatedAt: new Date().toISOString(),
  sourceHead: gitHead,
  launcherPath,
  launcherSha256: await sha256(launcherPath),
  desktopExecutableSha256: await sha256(join(dirname(launcherPath), 'joy-media.exe')),
  cliBundleSha256: await sha256(bundlePath),
  workerExecutableSha256: await sha256(workerPath),
  lockfileSha256: await sha256(lockPath),
  fixtureManifestSha256: await sha256(fixtureManifestPath),
  fixtureSha256: await sha256(fixturePath),
  databasePath,
  projectId,
  mediaPath,
  mediaSha256: await sha256(mediaPath),
  manifestPath,
  videoCodec: videoStream.codec_name,
  audioCodec: audioStream.codec_name,
  durationSeconds: Number(probe.format.duration),
};
writeFileSync(
  join(evidenceDirectory, 'installed-cli-acceptance.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
