/* global process, fetch, AbortSignal */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolveByokConfig } from '../agent/provider.js';
import type { CliFlags } from '../cli.js';
import { getDefaultSqlitePath } from '../utils/config.js';
import {
  c,
  logError,
  logInfo,
  logLine,
  logSuccess,
  logWarn,
  printBanner,
  printJson,
} from '../utils/logger.js';
import {
  WORKER_ENVIRONMENTS,
  detectGpu,
  modelInventory,
  venvPython,
  joyMediaHome,
} from './worker-cmd.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly summary: Readonly<Record<DoctorStatus, number>>;
  readonly checks: readonly DoctorCheck[];
}

/** Default production edge readiness endpoint. Override with JOY_MEDIA_EDGE_URL (or `off`). */
export const DEFAULT_EDGE_URL = 'https://joyst.ir/ready';
export const EDGE_TIMEOUT_MS = 3000;

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  return major >= 22
    ? {
        id: 'node',
        label: 'Node.js Runtime',
        status: 'pass',
        message: `v${version} (supported >= 22)`,
      }
    : {
        id: 'node',
        label: 'Node.js Runtime',
        status: 'fail',
        message: `v${version} (requires >= 22)`,
      };
}

function checkSqlite(): DoctorCheck {
  try {
    const memDb = new DatabaseSync(':memory:');
    memDb.exec('PRAGMA journal_mode = WAL');
    memDb.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    memDb.close();
    return { id: 'sqlite', label: 'Built-in SQLite Engine', status: 'pass', message: 'Functional' };
  } catch (err) {
    return { id: 'sqlite', label: 'Built-in SQLite Engine', status: 'fail', message: String(err) };
  }
}

function checkProjectStore(): DoctorCheck {
  const path = getDefaultSqlitePath();
  return existsSync(path)
    ? {
        id: 'project-store',
        label: 'Desktop Project Store',
        status: 'pass',
        message: `Found at ${path}`,
        details: { path },
      }
    : {
        id: 'project-store',
        label: 'Desktop Project Store',
        status: 'warn',
        message: `Not created yet (${path})`,
        details: { path },
      };
}

function checkGpu(): DoctorCheck {
  const gpu = detectGpu();
  return gpu.name
    ? { id: 'gpu', label: 'Hardware GPU', status: 'pass', message: gpu.name, details: { ...gpu } }
    : {
        id: 'gpu',
        label: 'Hardware GPU',
        status: 'warn',
        message: `Not detected (${gpu.reason ?? 'unknown'}); GPU-accelerated workers unavailable`,
        details: { ...gpu },
      };
}

function checkModels(): DoctorCheck {
  const models = modelInventory();
  const details = { dir: models.dir, files: models.files.length };
  if (!models.exists) {
    return {
      id: 'models',
      label: 'Local Model Weights',
      status: 'warn',
      message: `Directory not found (${models.dir})`,
      details,
    };
  }
  if (models.error) {
    return {
      id: 'models',
      label: 'Local Model Weights',
      status: 'warn',
      message: `Cannot list ${models.dir}: ${models.error}`,
      details,
    };
  }
  if (models.files.length === 0) {
    return {
      id: 'models',
      label: 'Local Model Weights',
      status: 'warn',
      message: `No files in ${models.dir}`,
      details,
    };
  }
  return {
    id: 'models',
    label: 'Local Model Weights',
    status: 'pass',
    message: `${models.files.length} file(s) found in ${models.dir}`,
    details,
  };
}

function checkVenvs(): DoctorCheck {
  const missing = WORKER_ENVIRONMENTS.filter((env) => !existsSync(venvPython(env.dir))).map(
    (env) => env.id,
  );
  const total = WORKER_ENVIRONMENTS.length;
  const ready = total - missing.length;
  const details = { dir: joyMediaHome(), ready, total, missing };
  return missing.length === 0
    ? {
        id: 'venvs',
        label: 'Local AI Venvs',
        status: 'pass',
        message: `All ${total}/${total} environments ready in ~/.joy-media`,
        details,
      }
    : {
        id: 'venvs',
        label: 'Local AI Venvs',
        status: 'warn',
        message: `${ready}/${total} ready in ~/.joy-media (missing: ${missing.join(', ')})`,
        details,
      };
}

function checkAgentProvider(): DoctorCheck {
  try {
    const byok = resolveByokConfig();
    const details = { provider: byok.provider, model: byok.modelId, apiKeyConfigured: false };
    if (byok.apiKey && byok.apiKey !== 'not-provided') {
      return {
        id: 'agent-provider',
        label: 'Joy Agent Provider',
        status: 'pass',
        message: `${byok.provider} (${byok.modelId}) [API key configured]`,
        details: { ...details, apiKeyConfigured: true },
      };
    }
    return {
      id: 'agent-provider',
      label: 'Joy Agent Provider',
      status: 'warn',
      message: `${byok.provider} (${byok.modelId}) [no API key configured - set OPENROUTER_API_KEY]`,
      details,
    };
  } catch (err) {
    return {
      id: 'agent-provider',
      label: 'Joy Agent Provider',
      status: 'warn',
      message: `Cannot read configuration: ${String(err)}`,
    };
  }
}

/**
 * Production edge reachability. JOY Media is offline-first, so an unreachable
 * edge is a warning, never a failure, and the probe is bounded by
 * {@link EDGE_TIMEOUT_MS}. `JOY_MEDIA_EDGE_URL=off` skips it.
 */
async function checkEdge(): Promise<DoctorCheck> {
  const label = 'Production Edge';
  const configured = process.env.JOY_MEDIA_EDGE_URL?.trim();
  if (configured !== undefined && /^(?:off|0|false|none|)$/i.test(configured)) {
    return { id: 'edge', label, status: 'skip', message: 'Disabled by JOY_MEDIA_EDGE_URL' };
  }
  const url = configured || DEFAULT_EDGE_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      id: 'edge',
      label,
      status: 'warn',
      message: `Invalid JOY_MEDIA_EDGE_URL "${url}"`,
      details: { url },
    };
  }
  try {
    const res = await fetch(parsed, { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        id: 'edge',
        label,
        status: 'warn',
        message: `HTTP ${res.status} from ${url} (offline fallback active)`,
        details: { url, httpStatus: res.status },
      };
    }
    let identity: { commitSha?: string; schemaVersion?: number } | undefined;
    try {
      const body = (await res.json()) as { releaseIdentity?: typeof identity };
      identity = body.releaseIdentity;
    } catch {
      identity = undefined;
    }
    const commit = identity?.commitSha?.slice(0, 8) ?? 'live';
    const schema = identity?.schemaVersion;
    return {
      id: 'edge',
      label,
      status: 'pass',
      message: `Connected [release: ${commit}${schema !== undefined ? `, schema: v${schema}` : ''}]`,
      details: { url, release: commit, schemaVersion: schema },
    };
  } catch (err) {
    const timedOut = (err as Error | undefined)?.name === 'TimeoutError';
    return {
      id: 'edge',
      label,
      status: 'warn',
      message: timedOut
        ? `No response within ${EDGE_TIMEOUT_MS / 1000}s (offline-first mode active)`
        : 'Unreachable (offline-first mode active)',
      details: { url },
    };
  }
}

export async function runDoctorChecks(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkNode(),
    checkSqlite(),
    checkProjectStore(),
    checkGpu(),
    checkModels(),
    checkVenvs(),
    checkAgentProvider(),
    await checkEdge(),
  ];
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status]++;
  return { ok: summary.fail === 0, summary, checks };
}

export async function handleDoctorCommand(args: string[] = [], flags?: CliFlags): Promise<number> {
  void args;
  const json = flags?.json === true;
  if (!json) {
    printBanner();
    logLine(`  ${c('JOY Media System Diagnostic & Health Check (Doctor)', 'bold')}\n`);
  }

  const report = await runDoctorChecks();
  const exitCode = report.ok ? 0 : 1;
  const idsWith = (status: DoctorStatus): string[] =>
    report.checks.filter((check) => check.status === status).map((check) => check.id);
  const failed = idsWith('fail');
  const warned = idsWith('warn');
  const failureSummary =
    `${failed.length} diagnostic check(s) failed: ${failed.join(', ')}.` +
    (warned.length ? ` ${warned.length} warning(s): ${warned.join(', ')}.` : '');

  if (json) {
    printJson(report);
    if (!report.ok) logError(failureSummary);
    return exitCode;
  }

  for (const check of report.checks) {
    const line = `${check.label}: ${check.message}`;
    if (check.status === 'pass') logSuccess(line);
    else if (check.status === 'warn') logWarn(line);
    else if (check.status === 'skip') logInfo(`${check.label}: skipped (${check.message})`);
    else logError(line);
  }

  logLine();
  if (!report.ok) {
    logError(failureSummary);
  } else if (warned.length > 0) {
    logWarn(
      `Core checks passed with ${warned.length} warning(s): ${warned.join(', ')}. ` +
        'Optional features may be unavailable.',
    );
  } else {
    logSuccess('All diagnostics passed! Joy Media CLI is ready for full operation.');
  }
  return exitCode;
}
