/**
 * `doctor` and `worker` against the real binary, on a machine that looks like
 * a fresh laptop or an air-gapped box: no GPU tooling, no Python venvs, no
 * model weights, and an edge server we control (never the real internet).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeRaw,
  isWindows,
  refusedUrl,
  spawnCli,
  startServer,
  writeExecutable,
} from './cli-helpers.js';
import { createSandbox, describeRun, hasAnsi, type Sandbox } from './harness.js';

interface DoctorJson {
  ok: boolean;
  summary: Record<'pass' | 'warn' | 'fail' | 'skip', number>;
  checks: Array<{
    id: string;
    label: string;
    status: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

const CHECK_IDS = [
  'node',
  'sqlite',
  'project-store',
  'gpu',
  'models',
  'venvs',
  'agent-provider',
  'edge',
];

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('doctor-worker');
});
afterEach(() => sb.cleanup());

function check(doc: DoctorJson, id: string): DoctorJson['checks'][number] {
  const found = doc.checks.find((c) => c.id === id);
  if (!found) throw new Error(`doctor --json has no "${id}" check: ${JSON.stringify(doc)}`);
  return found;
}

/** Fake venv python (POSIX) that records its argv, chats on stdout, creates `-o <out>`. */
function installFakeVenv(venv: string, exitCode = 0): string {
  return writeExecutable(
    join(sb.joyDir, venv, 'bin', 'python'),
    [
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
      'printf "%s\\n" "$@" > "$HOME/worker-args.txt"',
      'echo "fake worker: processing on stdout"',
      'cat > /dev/null', // would hang if the CLI handed us an open stdin
      `if [ -n "$out" ]; then echo processed > "$out"; fi`,
      `exit ${exitCode}`,
    ].join('\n'),
  );
}

function installWindowsFakeVenv(venv: string): string {
  const pythonDirectory = join(sb.joyDir, venv, 'Scripts');
  const pythonPath = join(pythonDirectory, 'python.exe');
  const sourcePath = sb.path('fake-python.cs');
  const source = [
    'using System;',
    'using System.IO;',
    'class FakePython {',
    '  static int Main(string[] args) {',
    '    string output = null;',
    '    for (int i = 0; i + 1 < args.Length; i++) { if (args[i] == "-o") output = args[i + 1]; }',
    '    string exitText = Environment.GetEnvironmentVariable("JOY_TEST_FAKE_WORKER_EXIT_CODE");',
    '    if (output != null && exitText != "3") File.WriteAllText(output, "processed");',
    '    Console.WriteLine("fake worker: processing on stdout");',
    '    Console.In.ReadToEnd();',
    '    int exitCode = 0;',
    '    Int32.TryParse(exitText, out exitCode);',
    '    return exitCode;',
    '  }',
    '}',
  ].join('\n');
  mkdirSync(pythonDirectory, { recursive: true });
  writeFileSync(sourcePath, source, 'utf8');
  const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const compiled = spawnSync(compiler, ['/nologo', `/out:${pythonPath}`, sourcePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (compiled.error || compiled.status !== 0) {
    throw new Error(
      `Could not compile the Windows worker fixture: ${compiled.stderr || compiled.stdout}`,
    );
  }
  return pythonPath;
}

describe('doctor on a machine without network, GPU or models', () => {
  it('finishes, exits 0, lists what is missing and does not claim everything passed', async () => {
    const r = await sb.run(['doctor'], { env: { JOY_MEDIA_EDGE_URL: await refusedUrl() } });
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stderr, describeRun(r)).toBe('');
    expect(r.out).toMatch(/Production Edge: Unreachable \(offline-first mode active\)/);
    expect(r.out).toMatch(/Local AI Venvs: 0\/4 ready/);
    expect(r.out).toMatch(/Local Model Weights: Directory not found/);
    expect(r.out).not.toMatch(/All (core system )?diagnostics passed/);
    expect(r.out).toMatch(/Core checks passed with \d+ warning\(s\): .*edge/);
  });

  it('gives up on an edge that accepts but never answers, and says so', async () => {
    const edge = await startServer();
    try {
      const r = await sb.run(['doctor', '--json'], { env: { JOY_MEDIA_EDGE_URL: edge.url } });
      expect(r.code, describeRun(r)).toBe(0);
      const doc = r.json<DoctorJson>();
      expect(check(doc, 'edge')).toMatchObject({
        status: 'warn',
        message: expect.stringMatching(/No response within 3s/),
      });
      expect(edge.hits()).toBe(1);
    } finally {
      await edge.close();
    }
  });

  it('reports a healthy edge with its release identity', async () => {
    const edge = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ releaseIdentity: { commitSha: 'abcdef1234567890', schemaVersion: 9 } }),
      );
    });
    try {
      const r = await sb.run(['doctor'], { env: { JOY_MEDIA_EDGE_URL: edge.url } });
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.out).toMatch(/Production Edge: Connected \[release: abcdef12, schema: v9\]/);
    } finally {
      await edge.close();
    }
  });

  it('an edge that answers 503 or garbage is a warning/pass, never "unreachable"', async () => {
    const down = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('maintenance');
    });
    const garbage = await startServer((_req, res) => res.end('<html>not json</html>'));
    try {
      const r503 = await sb.run(['doctor', '--json'], { env: { JOY_MEDIA_EDGE_URL: down.url } });
      expect(check(r503.json<DoctorJson>(), 'edge')).toMatchObject({
        status: 'warn',
        message: expect.stringMatching(/HTTP 503/),
      });
      const rHtml = await sb.run(['doctor', '--json'], {
        env: { JOY_MEDIA_EDGE_URL: garbage.url },
      });
      expect(check(rHtml.json<DoctorJson>(), 'edge')).toMatchObject({
        status: 'pass',
        message: expect.stringMatching(/Connected \[release: live\]/),
      });
    } finally {
      await down.close();
      await garbage.close();
    }
  });

  it('JOY_MEDIA_EDGE_URL=off skips the probe entirely', async () => {
    const r = await sb.run(['doctor', '--json'], { env: { JOY_MEDIA_EDGE_URL: 'off' } });
    expect(check(r.json<DoctorJson>(), 'edge').status).toBe('skip');
  });

  it('--json is exactly one document: ok, summary and checks[] with id/status/message', async () => {
    const r = await sb.run(['doctor', '--json'], {
      env: { JOY_MEDIA_EDGE_URL: await refusedUrl(), FORCE_COLOR: '1' },
    });
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stderr, describeRun(r)).toBe('');
    expect(hasAnsi(r.stdout)).toBe(false);
    const doc = r.json<DoctorJson>();
    expect(doc.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    for (const c of doc.checks) {
      expect(['pass', 'warn', 'fail', 'skip']).toContain(c.status);
      expect(typeof c.message).toBe('string');
    }
    const counted = { pass: 0, warn: 0, fail: 0, skip: 0 } as DoctorJson['summary'];
    for (const c of doc.checks) counted[c.status as keyof typeof counted]++;
    expect(doc.summary).toEqual(counted);
    expect(doc.ok).toBe(doc.summary.fail === 0);
    const gpu = check(doc, 'gpu');
    expect(typeof gpu.details?.name === 'string').toBe(gpu.status === 'pass');
    expect(['pass', 'warn']).toContain(gpu.status);
  });

  it.skipIf(isWindows)('never shells out to PowerShell on a non-Windows machine', async () => {
    const fakeBin = sb.path('fake-bin');
    const marker = sb.path('powershell-was-run');
    for (const tool of ['powershell', 'pwsh']) {
      writeExecutable(join(fakeBin, tool), `touch '${marker}'\nsleep 5\necho "NVIDIA Fake"`);
    }
    const r = await sb.run(['doctor', '--json'], {
      env: { JOY_MEDIA_EDGE_URL: 'off', PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` },
    });
    expect(r.code, describeRun(r)).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(isWindows)('detects an NVIDIA GPU through nvidia-smi', async () => {
    const fakeBin = sb.path('fake-bin');
    writeExecutable(join(fakeBin, 'nvidia-smi'), 'echo "NVIDIA GeForce RTX 4090"');
    const r = await sb.run(['doctor', '--json'], {
      env: { JOY_MEDIA_EDGE_URL: 'off', PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` },
    });
    expect(check(r.json<DoctorJson>(), 'gpu')).toMatchObject({
      status: 'pass',
      message: 'NVIDIA GeForce RTX 4090',
    });
  });

  it.skipIf(isWindows)('recognises a POSIX venv layout (bin/python) and model files', async () => {
    installFakeVenv('venv-realesrgan');
    const models = sb.path('models');
    mkdirSync(models);
    writeFileSync(join(models, 'RealESRGAN_x4plus.pth'), 'weights');
    const r = await sb.run(['doctor', '--json'], {
      env: { JOY_MEDIA_EDGE_URL: 'off', JOY_MODELS_DIR: models },
    });
    const doc = r.json<DoctorJson>();
    expect(check(doc, 'venvs').details).toMatchObject({ ready: 1, total: 4 });
    expect(check(doc, 'models')).toMatchObject({
      status: 'pass',
      message: expect.stringMatching(/1 file/),
    });
  });
});

describe('worker status', () => {
  it('reports GPU, venvs and models, quiet stderr', async () => {
    const r = await sb.run(['worker', 'status']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stderr, describeRun(r)).toBe('');
    expect(r.out).toMatch(/Primary GPU: /);
    expect(r.out).toMatch(/RealESRGAN \(Upscaling\): NOT FOUND/);
    expect(r.out).toMatch(/Models directory not found/);
  });

  it('--json reports gpu, environments and models as one document', async () => {
    const r = await sb.run(['worker', 'status', '--json']);
    expect(r.code, describeRun(r)).toBe(0);
    const doc = r.json<{
      gpu: { detected: boolean; name?: string; reason?: string };
      environments: Array<{ id: string; ready: boolean; python: string }>;
      models: { exists: boolean; files: unknown[] };
    }>();
    expect(typeof doc.gpu.detected).toBe('boolean');
    expect(doc.gpu.detected).toBe(typeof doc.gpu.name === 'string');
    expect(doc.environments.map((e) => e.id)).toEqual([
      'realesrgan',
      'birefnet',
      'deepfilternet',
      'tts',
    ]);
    expect(doc.environments.every((e) => !e.ready)).toBe(true);
    expect(doc.models).toMatchObject({ exists: false, files: [] });
  });
});

describe('worker upscale / denoise', () => {
  it('no input is a usage error (2); a missing file is a runtime error (1) that names the file', async () => {
    const none = await sb.run(['worker', 'upscale']);
    expect(none.code, describeRun(none)).toBe(2);
    expect(none.err).toMatch(/Missing input file\. Usage: joy-media worker upscale/);

    const missing = await sb.run(['worker', 'upscale', 'nope.png']);
    expect(missing.code, describeRun(missing)).toBe(1);
    expect(missing.err).toMatch(/Input file not found: nope\.png/);

    mkdirSync(sb.path('a-folder'));
    const folder = await sb.run(['worker', 'denoise', 'a-folder']);
    expect(folder.code, describeRun(folder)).toBe(1);
    expect(folder.err).toMatch(/Input is not a file: a-folder/);
  });

  it('bad --scale values are usage errors with accurate messages', async () => {
    writeFileSync(sb.path('in.png'), 'png');
    const cases: Array<[string, RegExp]> = [
      ['0', /--scale: value must be >= 1 \(received: 0\)/],
      ['17', /--scale: value must be <= 16/],
      ['2.5', /--scale: expected an integer/],
      ['-2', /--scale: value must be >= 1/],
    ];
    for (const [value, message] of cases) {
      const r = await sb.run(['worker', 'upscale', 'in.png', '--scale', value]);
      expect(r.code, describeRun(r)).toBe(2);
      expect(r.err).toMatch(message);
    }
  });

  it('without the Python environment it says exactly what is missing', async () => {
    writeFileSync(sb.path('in.png'), 'png');
    const r = await sb.run(['worker', 'upscale', 'in.png']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/RealESRGAN \(Upscaling\) environment is not installed/);
    expect(r.err).toContain(isWindows ? join('Scripts', 'python.exe') : join('bin', 'python'));
  });

  it.skipIf(isWindows)('with a working environment: output lands next to the input', async () => {
    installFakeVenv('venv-realesrgan');
    writeFileSync(sb.path('photo.png'), 'original');
    const r = await sb.run(['worker', 'upscale', 'photo.png', '--scale', '2']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toMatch(/Upscale completed: photo-upscaled-2x\.png/);
    expect(readFileSync(sb.path('photo-upscaled-2x.png'), 'utf8')).toBe('processed\n');
    expect(readFileSync(join(sb.home, 'worker-args.txt'), 'utf8').split('\n')).toEqual(
      expect.arrayContaining(['-i', 'photo.png', '-o', 'photo-upscaled-2x.png', '-s', '2']),
    );
  });

  it.skipIf(!isWindows)(
    'Windows Scripts/python.exe runs an isolated fake worker and writes output',
    async () => {
      installWindowsFakeVenv('venv-realesrgan');
      writeFileSync(sb.path('photo.png'), 'original');
      const r = await sb.run(['worker', 'upscale', 'photo.png', '--scale', '2'], {
        env: { JOY_TEST_FAKE_WORKER_EXIT_CODE: '0' },
      });
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.out).toMatch(/Upscale completed: photo-upscaled-2x\.png/);
      expect(readFileSync(sb.path('photo-upscaled-2x.png'), 'utf8')).toBe('processed');
      expect(readFileSync(sb.path('photo.png'), 'utf8')).toBe('original');
    },
  );

  it.skipIf(!isWindows)('Windows --json keeps fake worker chatter on stderr', async () => {
    installWindowsFakeVenv('venv-deepfilternet');
    writeFileSync(sb.path('voice.wav'), 'audio');
    const r = await sb.run(['worker', 'denoise', 'voice.wav', '--json'], {
      env: { JOY_TEST_FAKE_WORKER_EXIT_CODE: '0' },
    });
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      operation: 'denoise',
      input: 'voice.wav',
      output: 'voice-denoised.wav',
    });
    expect(r.err).toContain('fake worker: processing on stdout');
  });

  it.skipIf(isWindows)(
    '--json: stdout is one JSON document; worker chatter goes to stderr',
    async () => {
      installFakeVenv('venv-deepfilternet');
      writeFileSync(sb.path('voice.wav'), 'audio');
      const r = await sb.run(['worker', 'denoise', 'voice.wav', '--json']);
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.json()).toEqual({
        ok: true,
        operation: 'denoise',
        input: 'voice.wav',
        output: 'voice-denoised.wav',
      });
      expect(r.err).toContain('fake worker: processing on stdout');
      expect(r.err).toMatch(/Denoising voice\.wav/);
    },
  );

  it.skipIf(isWindows)('a failing worker process is exit 1 with its exit status', async () => {
    installFakeVenv('venv-realesrgan', 3);
    writeFileSync(sb.path('photo.png'), 'original');
    const r = await sb.run(['worker', 'upscale', 'photo.png', '--json']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, operation: 'upscale', workerExitCode: 3 });
    expect(r.err).toMatch(/Upscale failed: worker exited with code 3/);
  });

  it.skipIf(!isWindows)('Windows worker failure returns a structured nonzero result', async () => {
    installWindowsFakeVenv('venv-realesrgan');
    writeFileSync(sb.path('photo.png'), 'original');
    const r = await sb.run(['worker', 'upscale', 'photo.png', '--scale', '2', '--json'], {
      env: { JOY_TEST_FAKE_WORKER_EXIT_CODE: '3' },
    });
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, operation: 'upscale', workerExitCode: 3 });
    expect(r.err).toMatch(/Upscale failed: worker exited with code 3/);
    expect(readFileSync(sb.path('photo.png'), 'utf8')).toBe('original');
  });

  it.skipIf(isWindows)(
    'never clobbers the input: extension-less and dotted-directory inputs',
    async () => {
      installFakeVenv('venv-realesrgan');
      mkdirSync(sb.path('my.shots'));
      writeFileSync(sb.path('my.shots', 'frame'), 'original');
      const r = await sb.run(['worker', 'upscale', join('my.shots', 'frame')]);
      expect(r.code, describeRun(r)).toBe(0);
      expect(readFileSync(sb.path('my.shots', 'frame'), 'utf8')).toBe('original');
      expect(readFileSync(sb.path('my.shots', 'frame-upscaled-4x'), 'utf8')).toBe('processed\n');

      const same = await sb.run([
        'worker',
        'upscale',
        'my.shots/frame',
        '--output',
        './my.shots/frame',
      ]);
      expect(same.code, describeRun(same)).toBe(2);
      expect(same.err).toMatch(/Refusing to overwrite the input file/);
      expect(readFileSync(sb.path('my.shots', 'frame'), 'utf8')).toBe('original');
    },
  );

  it.skipIf(isWindows)(
    'the worker never inherits an open stdin (no hang in a tool loop)',
    async () => {
      installFakeVenv('venv-realesrgan'); // the fake reads stdin to EOF
      writeFileSync(sb.path('photo.png'), 'original');
      const args = ['worker', 'upscale', 'photo.png'];
      const r = await spawnCli(sb, args, { keepStdinOpen: true, timeoutMs: 20_000 });
      expect(r.code, describeRaw(args, r)).toBe(0);
    },
  );

  it.skipIf(!isWindows)('Windows worker does not inherit a tool loop stdin', async () => {
    installWindowsFakeVenv('venv-realesrgan');
    writeFileSync(sb.path('photo.png'), 'original');
    const args = ['worker', 'upscale', 'photo.png', '--scale', '2'];
    const r = await spawnCli(sb, args, {
      keepStdinOpen: true,
      env: { JOY_TEST_FAKE_WORKER_EXIT_CODE: '0' },
      timeoutMs: 20_000,
    });
    expect(r.code, describeRaw(args, r)).toBe(0);
  });

  it('an unknown worker subcommand is reported on stderr with a suggestion', async () => {
    const r = await sb.run(['worker', 'upscal', 'x.png']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Unknown worker subcommand "upscal"\. Did you mean "upscale"\?/);
    expect(r.stdout).toBe('');
  });
});
