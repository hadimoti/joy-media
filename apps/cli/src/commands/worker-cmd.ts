/* global console, process */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  c,
  logError,
  logInfo,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
} from '../utils/logger.js';

export interface WorkerCommandFlags {
  scale?: number | undefined;
  output?: string | undefined;
}

export async function handleWorkerCommand(
  args: string[],
  flags: WorkerCommandFlags,
): Promise<number> {
  const sub = args[0] ?? 'status';

  const modelsDir = process.env.JOY_MODELS_DIR ?? join(homedir(), 'JOY', 'models');
  const joyMediaDir = join(homedir(), '.joy-media');

  if (sub === 'status') {
    printBanner();
    console.log(`  ${c('Local AI Worker & Hardware Diagnostics:', 'bold')}\n`);

    // 1. GPU Check
    let gpuName = 'Unknown';
    try {
      const wmic = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
        ],
        { encoding: 'utf8' },
      );
      if (wmic.status === 0 && wmic.stdout.trim()) {
        gpuName = wmic.stdout.trim().split('\n')[0]?.trim() ?? 'Unknown';
      }
    } catch {
      // Ignore
    }
    logStep('Primary GPU', c(gpuName, gpuName.includes('NVIDIA') ? 'green' : 'yellow'));

    // 2. Python Venvs
    console.log(`\n  ${c('Isolated AI Environments (.joy-media):', 'bold')}`);
    const venvs = [
      { name: 'RealESRGAN (Upscaling)', dir: 'venv-realesrgan' },
      { name: 'BiRefNet (Background Removal)', dir: 'venv-birefnet' },
      { name: 'DeepFilterNet (Noise Reduction)', dir: 'venv-deepfilternet' },
      { name: 'Demucs / Qwen3 (Audio / TTS)', dir: 'venv-tts' },
    ];

    for (const v of venvs) {
      const pythonExe = join(joyMediaDir, v.dir, 'Scripts', 'python.exe');
      const ready = existsSync(pythonExe);
      logStep(v.name, ready ? `${c('READY', 'green')} (${pythonExe})` : c('NOT FOUND', 'dim'));
    }

    // 3. Models Inventory
    console.log(`\n  ${c('Local Model Weights (JOY/models):', 'bold')}`);
    if (existsSync(modelsDir)) {
      try {
        const files = readdirSync(modelsDir);
        for (const file of files) {
          const fullPath = join(modelsDir, file);
          const stat = statSync(fullPath);
          if (stat.isFile()) {
            const mb = (stat.size / (1024 * 1024)).toFixed(1);
            logStep(file, `${mb} MB`);
          }
        }
      } catch (err) {
        logWarn(`Cannot list models: ${String(err)}`);
      }
    } else {
      logWarn(`Models directory not found at ${modelsDir}`);
    }

    return 0;
  }

  if (sub === 'upscale') {
    const input = args[1];
    if (!input || !existsSync(input)) {
      logError('Usage: joy-media worker upscale <input-image> [--scale 4] [--output <out-image>]');
      return 1;
    }

    const scale = flags.scale ?? 4;
    const output = flags.output ?? input.replace(/(\.[^.]+)$/, `-upscaled-${scale}x$1`);

    logInfo(`Upscaling ${c(input, 'bold')} (${scale}x) -> ${c(output, 'cyan')}...`);

    const pythonExe = join(joyMediaDir, 'venv-realesrgan', 'Scripts', 'python.exe');
    if (!existsSync(pythonExe)) {
      logError(`RealESRGAN venv python not found at ${pythonExe}`);
      return 1;
    }

    const runner = spawnSync(
      pythonExe,
      ['-m', 'realesrgan', '-i', input, '-o', output, '-s', String(scale)],
      { stdio: 'inherit' },
    );

    if (runner.status === 0) {
      logSuccess(`Upscale completed successfully: ${output}`);
      return 0;
    } else {
      logError(`Upscale failed with exit code ${runner.status}`);
      return 1;
    }
  }

  if (sub === 'denoise') {
    const input = args[1];
    if (!input || !existsSync(input)) {
      logError('Usage: joy-media worker denoise <input-audio> [--output <out-audio>]');
      return 1;
    }

    const output = flags.output ?? input.replace(/(\.[^.]+)$/, '-denoised$1');
    logInfo(`Denoising ${c(input, 'bold')} -> ${c(output, 'cyan')}...`);

    const pythonExe = join(joyMediaDir, 'venv-deepfilternet', 'Scripts', 'python.exe');
    if (!existsSync(pythonExe)) {
      logError(`DeepFilterNet venv python not found at ${pythonExe}`);
      return 1;
    }

    const runner = spawnSync(pythonExe, ['-m', 'df.enhance', input, '-o', output], {
      stdio: 'inherit',
    });

    if (runner.status === 0) {
      logSuccess(`Denoise completed: ${output}`);
      return 0;
    } else {
      logError(`Denoise failed with exit code ${runner.status}`);
      return 1;
    }
  }

  logError(`Unknown worker subcommand: ${sub}`);
  console.log(
    `Available: ${c('status', 'cyan')}, ${c('upscale', 'cyan')}, ${c('denoise', 'cyan')}`,
  );
  return 1;
}
