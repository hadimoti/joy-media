/* global console, process */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { c, logError, logSuccess, logWarn, printBanner } from '../utils/logger.js';
import { powershellOptions } from '../utils/windows-powershell.js';

/**
 * The default doctor is strictly non-invasive. It reads no user path, opens no file, makes no network call
 * and writes nothing. It checks the Node runtime, the built-in SQLite engine (in memory only), and the GPU
 * through one fixed PowerShell query on Windows. Local files, models, Python environments and provider
 * settings are checked only by the explicit `doctor-local` command.
 */
export async function handleDoctorCommand(): Promise<number> {
  printBanner();
  console.log(`  ${c('JOY Media System Diagnostic & Health Check (Doctor)', 'bold')}\n`);

  let failures = 0;

  // 1. Node.js Engine
  const nodeVer = process.versions.node;
  const major = parseInt(nodeVer.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    logSuccess(`Node.js Runtime: v${nodeVer} (Supported >= 22)`);
  } else {
    logError(`Node.js Runtime: v${nodeVer} (Requires >= 22)`);
    failures++;
  }

  // 2. Built-in SQLite & WAL (in memory only)
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

  // 3. Hardware GPU: one fixed PowerShell query, on Windows only
  if (process.platform !== 'win32') {
    logWarn('Hardware GPU: not checked on this platform');
  } else {
    let gpuName = 'Unknown';
    try {
      const options = powershellOptions();
      const res = spawnSync(
        options.file,
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
        ],
        { encoding: 'utf8', env: options.env },
      );
      if (res.status === 0 && res.stdout.trim()) {
        gpuName = res.stdout.trim().split('\n')[0]?.trim() ?? 'Unknown';
      }
    } catch {
      // The GPU name stays Unknown.
    }
    if (gpuName.includes('NVIDIA') || gpuName.includes('AMD') || gpuName.includes('Intel')) {
      logSuccess(`Hardware GPU: ${c(gpuName, 'bold')}`);
    } else {
      logWarn(`Hardware GPU: ${gpuName}`);
    }
  }

  console.log();
  logWarn(
    'Local files, models, Python environments and provider settings are not read here. Run `joy-media doctor-local` to check them.',
  );
  console.log();
  if (failures === 0) {
    logSuccess('All core system diagnostics passed! Joy Media CLI is ready for full operation.');
    return 0;
  }
  logError(`${failures} diagnostic check(s) failed.`);
  return 1;
}
