import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { safeInstalledCliEnvironment } from './installed-cli-environment.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = resolve(repoRoot, 'packages/test-fixtures/media/video.mp4');
const schemaDirectory = resolve(repoRoot, 'apps/cli/schemas/v1');
const cliRequire = createRequire(resolve(repoRoot, 'apps/cli/package.json'));
const Ajv = cliRequire('ajv');
const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
const schemaValidators = new Map();

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

function runCli(launcherPath, args, env, label, expectedStatus = 0) {
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
    expectedStatus,
    `${label} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stdout.includes('\u001b['), false, `${label} wrote ANSI escapes`);
  return result.stdout;
}

async function runCliAsync(launcherPath, args, env, label, timeoutMs = 30_000) {
  const quoteCmdArgument = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const command = `call ${quoteCmdArgument(launcherPath)} ${args.map(quoteCmdArgument).join(' ')}`;
  let timedOut = false;
  let overflow = false;
  let stdout = '';
  let stderr = '';
  const maxOutputBytes = 16 * 1024 * 1024;
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: dirname(launcherPath),
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        overflow = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) {
        overflow = true;
        child.kill();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolveResult({ status, signal });
    });
  });

  assert.equal(timedOut, false, `${label} timed out after ${timeoutMs} ms`);
  assert.equal(overflow, false, `${label} exceeded the output limit`);
  assert.equal(
    result.status,
    0,
    `${label} failed with exit ${result.status} (${result.signal ?? 'no signal'})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.equal(stdout.includes('\u001b['), false, `${label} wrote ANSI escapes`);
  return stdout;
}

function parseSingleJson(stdout, label) {
  const trimmed = stdout.trim();
  assert.ok(
    trimmed.startsWith('{') || trimmed.startsWith('['),
    `${label} wrote a banner before JSON`,
  );
  return JSON.parse(trimmed);
}

function validateSchema(schemaFilename, value, label) {
  let validate = schemaValidators.get(schemaFilename);
  if (!validate) {
    const schema = JSON.parse(readFileSync(join(schemaDirectory, schemaFilename), 'utf8'));
    validate = ajv.compile(schema);
    schemaValidators.set(schemaFilename, validate);
  }
  assert.equal(
    validate(value),
    true,
    `${label} did not match ${schemaFilename}: ${ajv.errorsText(validate.errors)}`,
  );
}

async function startTextOnlyProviderMock() {
  let requestCount = 0;
  let lastAuthorization;
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock/editor' }] }));
      return;
    }

    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unknown local fixture route.' } }));
      return;
    }

    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requestCount += 1;
      lastAuthorization = request.headers.authorization;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const id = 'chatcmpl-joy-media-fixture';
      const created = 1_700_000_000;
      const model = typeof body.model === 'string' ? body.model : 'mock/editor';
      const content = 'No changes are needed for this fixture request.';

      if (body.stream === true) {
        const chunk = (delta, finishReason) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content }, null))}\n\n`);
        response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }

      const payload = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'Local provider must bind an ephemeral port.');

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    get requestCount() {
      return requestCount;
    },
    get lastAuthorization() {
      return lastAuthorization;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
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

const help = runCli(launcherPath, ['help'], env, 'help');
validateSchema('help-text.v1.schema.json', help, 'help');

const doctor = parseSingleJson(runCli(launcherPath, ['doctor', '--json'], env, 'doctor'), 'doctor');
validateSchema('doctor-report.v1.schema.json', doctor, 'doctor');

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
validateSchema('project-create.v1.schema.json', create, 'project create');
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
validateSchema('timeline-mutation.v1.schema.json', add, 'timeline add-clip');
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
validateSchema('project-show.v1.schema.json', reopened, 'project show');
assert.equal(reopened.title, title);
assert.equal(reopened.assetCount, 1);
assert.equal(reopened.tracks.flatMap((track) => track.clips).length, 1);

const listed = parseSingleJson(
  runCli(
    launcherPath,
    ['project', 'list', '--sqlite-path', databasePath, '--json'],
    env,
    'project list',
  ),
  'project list',
);
validateSchema('project-list.v1.schema.json', listed, 'project list');
assert.equal(
  listed.some((project) => project.id === projectId),
  true,
);

const projectExportPath = join(stateDirectory, 'project-export.joy');
const projectExport = parseSingleJson(
  runCli(
    launcherPath,
    [
      'project',
      'export',
      projectId,
      '--output',
      projectExportPath,
      '--sqlite-path',
      databasePath,
      '--json',
    ],
    env,
    'project export',
  ),
  'project export',
);
validateSchema('project-transfer.v1.schema.json', projectExport, 'project export');
assert.equal(existsSync(projectExportPath), true);

const reservedExport = parseSingleJson(
  runCli(
    launcherPath,
    ['project', 'export', projectId, '--output', 'NUL', '--sqlite-path', databasePath, '--json'],
    env,
    'reserved Windows device export',
    2,
  ),
  'reserved Windows device export',
);
validateSchema('command-error.v1.schema.json', reservedExport, 'reserved Windows device export');
assert.equal(reservedExport.code, 'USAGE');
assert.match(reservedExport.message, /reserved Windows device name/i);

const providerMock = await startTextOnlyProviderMock();
let agentRun;
try {
  agentRun = parseSingleJson(
    await runCliAsync(
      launcherPath,
      [
        'agent',
        'run',
        'review this fixture without making changes',
        '--project',
        projectId,
        '--json',
        '--url',
        providerMock.url,
        '--api-key',
        'synthetic-local-provider-key',
        '--model',
        'mock/editor',
      ],
      env,
      'local mock provider agent run',
    ),
    'local mock provider agent run',
  );
} finally {
  await providerMock.close();
}
validateSchema('agent-run-result.v1.schema.json', agentRun, 'agent run');
assert.equal(agentRun.ok, true);
assert.equal(agentRun.dryRun, true);
assert.equal(agentRun.applied, false);
assert.equal(providerMock.requestCount, 1);
assert.equal(providerMock.lastAuthorization, 'Bearer synthetic-local-provider-key');

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
for (const [index, event] of events.entries()) {
  validateSchema('render-event.v1.schema.json', event, `render event ${index + 1}`);
}
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
  outputSchemas: Object.fromEntries(
    [...schemaValidators.keys()].sort().map((filename) => [
      filename,
      createHash('sha256')
        .update(readFileSync(join(schemaDirectory, filename)))
        .digest('hex'),
    ]),
  ),
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
