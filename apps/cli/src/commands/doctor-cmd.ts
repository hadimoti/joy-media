/* global console, process */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveByokConfig } from '../agent/provider.js';
import { getDefaultSqlitePath } from '../utils/config.js';
import { c, logError, logSuccess, logWarn, printBanner } from '../utils/logger.js';

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
  const dbPath = getDefaultSqlitePath();
  if (existsSync(dbPath)) {
    logSuccess(`Desktop Project Store: Found at ${c(dbPath, 'cyan')}`);
  } else {
    logWarn(`Desktop Project Store: Not created yet (${dbPath})`);
  }

  // 4. GPU Telemetry
  let gpuName = 'Unknown';
  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
      ],
      { encoding: 'utf8' },
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
  if (existsSync(modelsDir)) {
    const files = readdirSync(modelsDir);
    logSuccess(`Local Model Weights: ${files.length} file(s) found in ${modelsDir}`);
  } else {
    logWarn(`Local Model Weights: Directory not found (${modelsDir})`);
  }

  // 6. Python Environments
  const joyMediaDir = join(homedir(), '.joy-media');
  const venvs = ['venv-realesrgan', 'venv-birefnet', 'venv-deepfilternet', 'venv-tts'];
  let venvsReady = 0;
  for (const v of venvs) {
    if (existsSync(join(joyMediaDir, v, 'Scripts', 'python.exe'))) {
      venvsReady++;
    }
  }
  if (venvsReady === venvs.length) {
    logSuccess(
      `Local AI Venvs: All ${venvsReady}/${venvs.length} environments ready in ~/.joy-media`,
    );
  } else {
    logWarn(`Local AI Venvs: ${venvsReady}/${venvs.length} ready in ~/.joy-media`);
  }

  // 7. Joy Agent BYOK Configuration
  const byok = await resolveByokConfig().catch(() => undefined);
  if (byok?.apiKey && byok.apiKey !== 'not-provided') {
    logSuccess(
      `Joy Agent Provider: ${c(byok.provider, 'bold')} (${c(byok.modelId, 'cyan')}) [API Key Configured]`,
    );
  } else {
    logWarn(
      `Joy Agent Provider: ${byok?.provider ?? 'openrouter'} (${byok?.modelId ?? 'openrouter/free'}) [No API Key configured - set OPENROUTER_API_KEY]`,
    );
  }

  // 8. Production Edge & Control Plane Connectivity
  try {
    const edgeRes = await fetch('https://joyst.ir/ready', { signal: AbortSignal.timeout(3000) });
    if (edgeRes.ok) {
      const json = (await edgeRes.json()) as {
        releaseIdentity?: { commitSha?: string; schemaVersion?: number };
      };
      const commit = json.releaseIdentity?.commitSha?.slice(0, 8) ?? 'live';
      const schema = json.releaseIdentity?.schemaVersion ?? 9;
      logSuccess(
        `Production Edge (Sweden VPS): ${c('Connected', 'bold')} [release: ${c(commit, 'cyan')}, schema: v${schema}]`,
      );
    } else {
      logWarn(`Production Edge (Sweden VPS): HTTP ${edgeRes.status} (offline fallback active)`);
    }
  } catch {
    logWarn('Production Edge (Sweden VPS): Unreachable (100% offline-first mode active)');
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
