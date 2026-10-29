/* global console, process */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveByokConfig } from '../agent/provider.js';
import { getDefaultSqlitePath } from '../utils/config.js';
import { c, logError, logSuccess, logWarn, printBanner } from '../utils/logger.js';
import { isLocalPath, parseDriveTypes } from '../utils/local-path.js';
import { powershellOptions } from '../utils/windows-powershell.js';

const UNCHECKED = 'not checked (network, linked or unknown location)';

/** The type of each drive, from .NET's DriveInfo. Only the type is read, never the contents of a volume. */
function readDriveTypes(): Map<string, number> {
  const options = powershellOptions();
  const res = spawnSync(
    options.file,
    [
      '-NoProfile',
      '-Command',
      "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { '{0}={1}' -f $_.Name.TrimEnd('\\'), [int]$_.DriveType }",
    ],
    { encoding: 'utf8', env: options.env },
  );
  return res.status === 0 ? parseDriveTypes(res.stdout) : new Map();
}

/**
 * The explicit local check. It reads the desktop project store, the model folder, the Python environments
 * and the provider settings, which the default `doctor` never touches. A path is read only when it is
 * classified as local. A UNC or device path, a network or unknown drive, and any path through a link are
 * reported as not checked, and nothing is read from them. Off Windows nothing is read at all.
 */
export async function handleDoctorLocalCommand(): Promise<number> {
  printBanner();
  console.log(`  ${c('JOY Media Local Check (explicit)', 'bold')}\n`);

  if (process.platform !== 'win32') {
    logError('The local check inspects Windows drives. Nothing was read on this platform.');
    return 2;
  }

  const driveTypes = readDriveTypes();
  const joyMediaDir = join(homedir(), '.joy-media');
  // The database and provider checks read configuration, so they run only when every file they read is local.
  const configLocal = [
    joyMediaDir,
    join(joyMediaDir, 'cli-config.json'),
    join(joyMediaDir, 'ai-providers.json'),
  ].every((path) => isLocalPath(path, driveTypes));

  // 1. Desktop Project Store
  if (!configLocal) {
    logWarn(`Desktop Project Store: ${UNCHECKED}`);
  } else {
    const dbPath = getDefaultSqlitePath();
    if (!isLocalPath(dbPath, driveTypes)) {
      logWarn(`Desktop Project Store: ${UNCHECKED}`);
    } else if (existsSync(dbPath)) {
      logSuccess(`Desktop Project Store: Found at ${c(dbPath, 'cyan')}`);
    } else {
      logWarn(`Desktop Project Store: Not created yet (${dbPath})`);
    }
  }

  // 2. Local Model Inventory
  const modelsDir = process.env.JOY_MODELS_DIR ?? join(homedir(), 'JOY', 'models');
  if (!isLocalPath(modelsDir, driveTypes)) {
    logWarn(`Local Model Weights: ${UNCHECKED}`);
  } else if (existsSync(modelsDir)) {
    const files = readdirSync(modelsDir);
    logSuccess(`Local Model Weights: ${files.length} file(s) found in ${modelsDir}`);
  } else {
    logWarn(`Local Model Weights: Directory not found (${modelsDir})`);
  }

  // 3. Python Environments
  const venvs = ['venv-realesrgan', 'venv-birefnet', 'venv-deepfilternet', 'venv-tts'];
  const pythons = venvs.map((v) => join(joyMediaDir, v, 'Scripts', 'python.exe'));
  if (!pythons.every((python) => isLocalPath(python, driveTypes))) {
    logWarn(`Local AI Venvs: ${UNCHECKED}`);
  } else {
    const venvsReady = pythons.filter((python) => existsSync(python)).length;
    if (venvsReady === venvs.length) {
      logSuccess(
        `Local AI Venvs: All ${venvsReady}/${venvs.length} environments ready in ~/.joy-media`,
      );
    } else {
      logWarn(`Local AI Venvs: ${venvsReady}/${venvs.length} ready in ~/.joy-media`);
    }
  }

  // 4. Joy Agent Provider Settings
  if (!configLocal) {
    logWarn(`Joy Agent Provider: ${UNCHECKED}`);
  } else {
    const byok = resolveByokConfig();
    if (byok.apiKey && byok.apiKey !== 'not-provided') {
      logSuccess(
        `Joy Agent Provider: ${c(byok.provider, 'bold')} (${c(byok.modelId, 'cyan')}) [API Key Configured]`,
      );
    } else {
      logWarn(
        `Joy Agent Provider: ${byok.provider} (${byok.modelId}) [No API Key configured - set OPENROUTER_API_KEY]`,
      );
    }
  }

  console.log();
  logWarn(
    'Not detected by this check: a cloud placeholder that downloads on first read, and a link created between the check and the read.',
  );
  return 0;
}
