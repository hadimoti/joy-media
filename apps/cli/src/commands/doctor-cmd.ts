/* global process, fetch, AbortSignal */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { CliFlags } from '../cli.js';
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
import { powershellOptions } from '../utils/windows-powershell.js';

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
  } catch (error) {
    return {
      id: 'sqlite',
      label: 'Built-in SQLite Engine',
      status: 'fail',
      message: `${String(error)} (Not functional)`,
    };
  }
}

function checkGpu(): DoctorCheck {
  const label = 'Hardware GPU';
  if (process.platform !== 'win32') {
    return { id: 'gpu', label, status: 'warn', message: 'not checked on this platform' };
  }

  try {
    const options = powershellOptions();
    const result = spawnSync(
      options.file,
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
      ],
      { encoding: 'utf8', env: options.env, timeout: 5000 },
    );
    const name = result.stdout?.trim().split(/\r?\n/)[0]?.trim();
    if (result.status === 0 && name) {
      return { id: 'gpu', label, status: 'pass', message: name, details: { name } };
    }
    return { id: 'gpu', label, status: 'warn', message: 'GPU could not be identified' };
  } catch {
    return { id: 'gpu', label, status: 'warn', message: 'GPU could not be identified' };
  }
}

function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function checkEdge(): Promise<DoctorCheck> {
  const label = 'Production Edge';
  const configured = process.env.JOY_MEDIA_EDGE_URL?.trim();
  if (configured === undefined || configured === '' || configured.toLowerCase() === 'off') {
    return { id: 'edge', label, status: 'skip', message: 'not configured' };
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { id: 'edge', label, status: 'warn', message: 'Invalid JOY_MEDIA_EDGE_URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      id: 'edge',
      label,
      status: 'warn',
      message: 'JOY_MEDIA_EDGE_URL must use HTTP or HTTPS',
    };
  }

  const url = safeUrl(parsed);
  try {
    const response = await fetch(parsed, { signal: AbortSignal.timeout(EDGE_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        id: 'edge',
        label,
        status: 'warn',
        message: `HTTP ${response.status} from configured endpoint`,
        details: { url, httpStatus: response.status },
      };
    }
    await response.body?.cancel().catch(() => undefined);
    return { id: 'edge', label, status: 'pass', message: 'Connected', details: { url } };
  } catch (error) {
    const timedOut = (error as Error | undefined)?.name === 'TimeoutError';
    return {
      id: 'edge',
      label,
      status: 'warn',
      message: timedOut ? `No response within ${EDGE_TIMEOUT_MS / 1000}s` : 'Unreachable',
      details: { url },
    };
  }
}

export async function runDoctorChecks(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkNode(), checkSqlite(), checkGpu(), await checkEdge()];
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
        'Optional features may be unavailable. Run joy-media doctor-local for local checks.',
    );
  } else {
    logSuccess('All diagnostics passed! Joy Media CLI is ready for full operation.');
    logInfo('Run joy-media doctor-local for local checks.');
  }
  return exitCode;
}
