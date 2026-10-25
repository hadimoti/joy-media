/* global process */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import type { CliFlags } from '../cli.js';
import { FlagValidationError, NUMERIC_RANGES, suggest } from '../utils/flags.js';
import {
  c,
  isMachineOutput,
  logError,
  logInfo,
  logLine,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
  printJson,
} from '../utils/logger.js';

export interface WorkerCommandFlags {
  scale?: number | undefined;
  output?: string | undefined;
}

export interface WorkerEnvironment {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
}

export const WORKER_ENVIRONMENTS: readonly WorkerEnvironment[] = [
  { id: 'realesrgan', name: 'RealESRGAN (Upscaling)', dir: 'venv-realesrgan' },
  { id: 'birefnet', name: 'BiRefNet (Background Removal)', dir: 'venv-birefnet' },
  { id: 'deepfilternet', name: 'DeepFilterNet (Noise Reduction)', dir: 'venv-deepfilternet' },
  { id: 'tts', name: 'Demucs / Qwen3 (Audio / TTS)', dir: 'venv-tts' },
];

const WORKER_SUBCOMMANDS = ['status', 'upscale', 'denoise'];

export function joyMediaHome(): string {
  return join(homedir(), '.joy-media');
}

export function modelsDirectory(): string {
  return process.env.JOY_MODELS_DIR ?? join(homedir(), 'JOY', 'models');
}

/**
 * Python interpreter of a venv under ~/.joy-media. Windows venvs keep it in
 * `Scripts/python.exe`, POSIX venvs in `bin/python` (or `bin/python3`).
 * Returns the conventional path even when nothing exists there.
 */
export function venvPython(venvDir: string): string {
  const root = join(joyMediaHome(), venvDir);
  const candidates =
    process.platform === 'win32'
      ? [join(root, 'Scripts', 'python.exe')]
      : [join(root, 'bin', 'python'), join(root, 'bin', 'python3')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export interface GpuInfo {
  /** Detected adapter name, or undefined when none could be identified. */
  readonly name: string | undefined;
  /** How we looked: `powershell` (Windows) or `nvidia-smi` (elsewhere). */
  readonly probe: 'powershell' | 'nvidia-smi';
  /** Why nothing was detected, when nothing was. */
  readonly reason?: string;
}

const GPU_PROBE_TIMEOUT_MS = 10_000;

/**
 * Identify the primary GPU without hanging: PowerShell/CIM on Windows only,
 * `nvidia-smi` elsewhere. Never throws.
 */
export function detectGpu(): GpuInfo {
  const windows = process.platform === 'win32';
  const probe = windows ? 'powershell' : 'nvidia-smi';
  try {
    const res = windows
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
          ],
          { encoding: 'utf8', timeout: GPU_PROBE_TIMEOUT_MS, windowsHide: true, stdio: 'pipe' },
        )
      : spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
          encoding: 'utf8',
          timeout: GPU_PROBE_TIMEOUT_MS,
          stdio: 'pipe',
        });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      return {
        name: undefined,
        probe,
        reason: code === 'ENOENT' ? `${probe} not found` : `${probe} failed (${code ?? 'error'})`,
      };
    }
    const names = (res.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (res.status !== 0 || names.length === 0) {
      return { name: undefined, probe, reason: `${probe} reported no GPU` };
    }
    const preferred =
      names.find((n) => /nvidia/i.test(n)) ?? names.find((n) => /amd|radeon/i.test(n)) ?? names[0];
    return { name: preferred, probe };
  } catch (err) {
    return { name: undefined, probe, reason: String(err) };
  }
}

export interface ModelInventory {
  readonly dir: string;
  readonly exists: boolean;
  readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  readonly error?: string;
}

export function modelInventory(): ModelInventory {
  const dir = modelsDirectory();
  if (!existsSync(dir)) return { dir, exists: false, files: [] };
  try {
    const files = readdirSync(dir)
      .map((name) => ({ name, stat: statSync(join(dir, name)) }))
      .filter((entry) => entry.stat.isFile())
      .map((entry) => ({ name: entry.name, sizeBytes: entry.stat.size }));
    return { dir, exists: true, files };
  } catch (err) {
    return { dir, exists: true, files: [], error: String(err) };
  }
}

export async function handleWorkerCommand(args: string[], flags: CliFlags): Promise<number> {
  validateScale(flags.scale);
  const sub = args[0] ?? 'status';

  if (sub === 'status') return workerStatus(flags);

  if (sub === 'upscale') {
    const scale = flags.scale ?? 4;
    return runWorkerJob({
      operation: 'upscale',
      usage: 'joy-media worker upscale <input-image> [--scale 4] [--output <out-image>]',
      args,
      flags,
      env: WORKER_ENVIRONMENTS[0]!,
      outputSuffix: `-upscaled-${scale}x`,
      describe: (input, output) =>
        `Upscaling ${c(input, 'bold')} (${scale}x) -> ${c(output, 'cyan')}...`,
      pythonArgs: (input, output) => [
        '-m',
        'realesrgan',
        '-i',
        input,
        '-o',
        output,
        '-s',
        String(scale),
      ],
      extra: { scale },
    });
  }

  if (sub === 'denoise') {
    return runWorkerJob({
      operation: 'denoise',
      usage: 'joy-media worker denoise <input-audio> [--output <out-audio>]',
      args,
      flags,
      env: WORKER_ENVIRONMENTS[2]!,
      outputSuffix: '-denoised',
      describe: (input, output) => `Denoising ${c(input, 'bold')} -> ${c(output, 'cyan')}...`,
      pythonArgs: (input, output) => ['-m', 'df.enhance', input, '-o', output],
      extra: {},
    });
  }

  const guess = suggest(sub, WORKER_SUBCOMMANDS);
  logError(
    `Unknown worker subcommand "${sub}".${guess ? ` Did you mean "${guess}"?` : ''} ` +
      `Available: ${WORKER_SUBCOMMANDS.join(', ')}.`,
  );
  return 2;
}

function workerStatus(flags: CliFlags): number {
  const gpu = detectGpu();
  const environments = WORKER_ENVIRONMENTS.map((env) => {
    const python = venvPython(env.dir);
    return { id: env.id, name: env.name, dir: env.dir, ready: existsSync(python), python };
  });
  const models = modelInventory();

  if (flags.json) {
    printJson({
      gpu: { detected: gpu.name !== undefined, ...gpu },
      environments,
      models,
    });
    return 0;
  }

  printBanner();
  logLine(`  ${c('Local AI Worker & Hardware Diagnostics:', 'bold')}\n`);
  const gpuLabel = gpu.name ?? `Unknown (${gpu.reason ?? 'not detected'})`;
  logStep('Primary GPU', c(gpuLabel, gpuLabel.includes('NVIDIA') ? 'green' : 'yellow'));

  logLine(`\n  ${c('Isolated AI Environments (.joy-media):', 'bold')}`);
  for (const env of environments) {
    logStep(env.name, env.ready ? `${c('READY', 'green')} (${env.python})` : c('NOT FOUND', 'dim'));
  }

  logLine(`\n  ${c('Local Model Weights (JOY/models):', 'bold')}`);
  if (!models.exists) {
    logWarn(`Models directory not found at ${models.dir}`);
  } else if (models.error) {
    logWarn(`Cannot list models: ${models.error}`);
  } else if (models.files.length === 0) {
    logWarn(`No model weights in ${models.dir}`);
  } else {
    for (const file of models.files) {
      logStep(file.name, `${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
    }
  }
  return 0;
}

interface WorkerJob {
  readonly operation: 'upscale' | 'denoise';
  readonly usage: string;
  readonly args: readonly string[];
  readonly flags: CliFlags;
  readonly env: WorkerEnvironment;
  readonly outputSuffix: string;
  readonly describe: (input: string, output: string) => string;
  readonly pythonArgs: (input: string, output: string) => string[];
  readonly extra: Record<string, unknown>;
}

/** `photo.png` -> `photo<suffix>.png`, kept next to the input; works without an extension. */
export function defaultOutputPath(input: string, suffix: string): string {
  const parsed = parse(input);
  return join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
}

async function runWorkerJob(job: WorkerJob): Promise<number> {
  const { operation, flags } = job;
  const json = flags.json;
  const positional = job.args.slice(1);

  if (positional.length === 0 || positional[0] === '') {
    logError(`Missing input file. Usage: ${job.usage}`);
    return 2;
  }
  if (positional.length > 1) {
    logError(
      `worker ${operation} takes exactly one input file, got ${positional.length}. Usage: ${job.usage}`,
    );
    return 2;
  }

  const input = positional[0]!;
  let output = job.flags.output ?? defaultOutputPath(input, job.outputSuffix);
  if (existsSync(output) && statSync(output).isDirectory()) {
    output = join(output, basename(defaultOutputPath(input, job.outputSuffix)));
  }

  const fail = (message: string, details: Record<string, unknown> = {}): number => {
    logError(message);
    if (json) {
      printJson({ ok: false, operation, input, output, ...job.extra, ...details, error: message });
    }
    return 1;
  };

  if (!existsSync(input)) return fail(`Input file not found: ${input}`);
  if (!statSync(input).isFile()) return fail(`Input is not a file: ${input}`);

  if (resolve(output) === resolve(input)) {
    logError(
      `Refusing to overwrite the input file ${input}. Choose a different --output for worker ${operation}.`,
    );
    return 2;
  }
  if (!existsSync(dirname(resolve(output)))) {
    return fail(`Output directory does not exist: ${dirname(resolve(output))}`);
  }

  logInfo(job.describe(input, output));

  const pythonExe = venvPython(job.env.dir);
  if (!existsSync(pythonExe)) {
    return fail(
      `${job.env.name} environment is not installed (expected Python at ${pythonExe}). ` +
        'Run "joy-media worker status" to see what is available.',
      { python: pythonExe },
    );
  }

  const result = await runChild(pythonExe, job.pythonArgs(input, output), isMachineOutput());
  if (result.error) {
    return fail(`Could not start ${job.env.name} worker (${pythonExe}): ${result.error}`, {
      python: pythonExe,
    });
  }
  if (result.code !== 0) {
    return fail(
      `${operation === 'upscale' ? 'Upscale' : 'Denoise'} failed: worker exited with ` +
        `${result.signal ? `signal ${result.signal}` : `code ${result.code}`}.`,
      { workerExitCode: result.code },
    );
  }

  if (json) {
    printJson({ ok: true, operation, input, output, ...job.extra });
  } else {
    logSuccess(`${operation === 'upscale' ? 'Upscale' : 'Denoise'} completed: ${output}`);
  }
  return 0;
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

/**
 * Run a worker process without ever handing it our stdin (it must not block on
 * input), sending its stdout to our stderr in machine mode so stdout stays
 * pure JSON, and killing it if the CLI exits first (Ctrl-C, SIGTERM).
 */
function runChild(command: string, args: string[], machine: boolean): Promise<ChildResult> {
  return new Promise<ChildResult>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', machine ? 2 : 'inherit', 'inherit'],
      windowsHide: true,
    });
    const killChild = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    process.once('exit', killChild);
    child.once('error', (err) => {
      process.removeListener('exit', killChild);
      resolvePromise({ code: null, signal: null, error: err.message });
    });
    child.once('close', (code, signal) => {
      process.removeListener('exit', killChild);
      resolvePromise({ code, signal });
    });
  });
}

function validateScale(value: number | undefined): void {
  if (value === undefined) return;
  const range = NUMERIC_RANGES.scale;
  if (!Number.isFinite(value)) {
    throw new FlagValidationError('scale', 'value is not a finite number', value);
  }
  if (value < range.min || value > range.max) {
    throw new FlagValidationError(
      'scale',
      `value must be between ${range.min} and ${range.max}`,
      value,
    );
  }
}
