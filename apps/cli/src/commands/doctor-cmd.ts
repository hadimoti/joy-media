/* global console, process */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveByokConfig } from '../agent/provider.js';
import { getDefaultSqlitePath } from '../utils/config.js';
import { c, logError, logSuccess, logWarn, printBanner } from '../utils/logger.js';
import { isLocalPath, parseDriveTypes } from '../utils/local-path.js';

const UNCHECKED = 'not checked (network or linked path)';

/**
 * The Windows directory, taken from SystemRoot only when it is a drive path. A relative value or a
 * UNC path is replaced by C:\Windows.
 */
function systemRoot(): string {
  const root = process.env.SystemRoot ?? '';
  return /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows';
}

/** Windows PowerShell by absolute path, so that no PATH entry can supply another program. */
function powershellPath(): string {
  return join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The child's environment, with the module path pinned to the system modules folder. */
function powershellEnv(): NodeJS.ProcessEnv {
  const modules = join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return { ...process.env, PSModulePath: modules };
}

/**
 * The type of each drive, from .NET's DriveInfo. Only the type is read, never the contents of a
 * volume. When the query fails, no drive is known, so every drive-letter path is reported unchecked.
 */
function readDriveTypes(): Map<string, number> {
  const res = spawnSync(
    powershellPath(),
    [
      '-NoProfile',
      '-Command',
      "[System.IO.DriveInfo]::GetDrives() | ForEach-Object { '{0}={1}' -f $_.Name.TrimEnd('\\'), [int]$_.DriveType }",
    ],
    { encoding: 'utf8', env: powershellEnv() },
  );
  return res.status === 0 ? parseDriveTypes(res.stdout) : new Map();
}

export async function handleDoctorCommand(): Promise<number> {
  printBanner();
  console.log(`  ${c('JOY Media System Diagnostic & Health Check (Doctor)', 'bold')}\n`);

  let failures = 0;

  // A path on a network drive, behind a UNC name or behind a link is not read at all. The
  // configuration files are read by the database and BYOK checks, so those checks run only when
  // every one of them is local.
  const driveTypes = readDriveTypes();
  const joyMediaDir = join(homedir(), '.joy-media');
  const configLocal = [
    joyMediaDir,
    join(joyMediaDir, 'cli-config.json'),
    join(joyMediaDir, 'ai-providers.json'),
  ].every((path) => isLocalPath(path, driveTypes));

  // 1. Node.js Engine
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    logSuccess(`Node.js Runtime: v${nodeVer} (Supported >= 22)`);
  } else {
    logError(`Node.js Runtime: v${nodeVer} (Requires >= 22)`);
    failures++;
  }

  // 2. Built-in SQLite & WAL
  try {
    const memDb = new DatabaseSync(':memory:');
    memDb.exec('PRAGMA journal_mode = WAL');
    memDb.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    memDb.close();
    logSuccess('Built-in SQLite Engine: Functional (WAL enabled)');
  } catch (err) {
    logError(`Built-in SQLite Engine Failed: ${String(err)}`);
    failures++;
  }

  // 3. Desktop Database Path
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

  // 4. GPU Telemetry
  let gpuName = 'Unknown';
  try {
    const res = spawnSync(
      powershellPath(),
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
      ],
      { encoding: 'utf8', env: powershellEnv() },
    );
    if (res.status === 0 && res.stdout.trim()) {
      gpuName = res.stdout.trim().split('\n')[0]?.trim() ?? 'Unknown';
    }
  } catch {
    // Ignore
  }
  if (gpuName.includes('NVIDIA') || gpuName.includes('AMD') || gpuName.includes('Intel')) {
    logSuccess(`Hardware GPU: ${c(gpuName, 'bold')}`);
  } else {
    logWarn(`Hardware GPU: ${gpuName}`);
  }

  // 5. Local Model Inventory
  const modelsDir = process.env.JOY_MODELS_DIR ?? join(homedir(), 'JOY', 'models');
  if (!isLocalPath(modelsDir, driveTypes)) {
    logWarn(`Local Model Weights: ${UNCHECKED}`);
  } else if (existsSync(modelsDir)) {
    const files = readdirSync(modelsDir);
    logSuccess(`Local Model Weights: ${files.length} file(s) found in ${modelsDir}`);
  } else {
    logWarn(`Local Model Weights: Directory not found (${modelsDir})`);
  }

  // 6. Python Environments
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

  // 7. Joy Agent BYOK Configuration
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
  if (failures === 0) {
    logSuccess('All core system diagnostics passed! Joy Media CLI is ready for full operation.');
    return 0;
  } else {
    logError(`${failures} diagnostic check(s) failed.`);
    return 1;
  }
}
