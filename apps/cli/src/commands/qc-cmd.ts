/**
 * `joy-media qc <file> [--json]`: the layer 1 technical check (ADR-0045, T-B02) on one media file.
 *
 * It runs the Worker's own `media.qc` code (FFmpeg filters, no model, no network, no cost) in this
 * process, so the numbers match what the desktop app reports. Exit codes: 0 clean, 1 findings or a
 * failure, 2 usage error.
 *
 * Hard cuts (`scene-cut`) are listed but do not make a file fail: every edited video has them.
 */
import { existsSync, statSync } from 'node:fs';
import { runMediaQc, type MediaQcReceipt } from '@joy-media/worker/media-qc';
import type { CliFlags } from '../cli.js';
import { c, logError, logInfo, logLine, logSuccess, logWarn, printJson } from '../utils/logger.js';

type QcReport = MediaQcReceipt['report'];
type QcFinding = QcReport['findings'][number];

export const QC_USAGE = 'joy-media qc <file> [--json]';

/** The report is about a file, never a path: this id is all the report says about where it came from. */
const CLI_ASSET_ID = 'cli-file';

/** Findings that make the check fail. Hard cuts are information, not faults. */
export function isFault(finding: Pick<QcFinding, 'type'>): boolean {
  return finding.type !== 'scene-cut';
}

/** Test seam and the exit rule: 1 when any finding is a fault, otherwise 0. */
export function exitCodeForReport(report: Pick<QcReport, 'findings'>): number {
  return report.findings.some(isFault) ? 1 : 0;
}

/** `83.5 s` as `1:23.5`; whole minutes and tenths of a second are enough for a human reader. */
export function formatQcTime(us: number): string {
  const totalTenths = Math.round(us / 100_000);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function describeFinding(finding: QcFinding): string {
  const range =
    finding.endUs > finding.startUs
      ? `${formatQcTime(finding.startUs)}-${formatQcTime(finding.endUs)}`
      : formatQcTime(finding.startUs);
  return `[${finding.severity}] ${finding.type} ${range}  ${finding.label}`;
}

function failure(message: string, json: boolean): number {
  logError(message);
  if (json) printJson({ ok: false, error: message });
  return 1;
}

function usageError(message: string, json: boolean): number {
  logError(`${message} Usage: ${QC_USAGE}`);
  if (json) printJson({ code: 'usage_error', error: `${message} Usage: ${QC_USAGE}` });
  return 2;
}

export async function handleQcCommand(args: string[], flags: CliFlags): Promise<number> {
  const json = flags.json;
  if (args.length === 0 || args[0] === '') return usageError('Missing input file.', json);
  if (args.length > 1) {
    return usageError(`qc takes exactly one input file, got ${args.length}.`, json);
  }
  const input = args[0]!;
  if (!existsSync(input)) return failure(`Input file not found: ${input}`, json);
  if (!statSync(input).isFile()) return failure(`Input is not a file: ${input}`, json);

  logInfo(`Checking ${c(input, 'bold')} ...`);
  let report: QcReport;
  try {
    const receipt = await runMediaQc({
      jobId: `cli-qc-${Date.now().toString(36)}`,
      assetId: CLI_ASSET_ID,
      sourcePath: input,
      cancelled: () => false,
      progress: async () => undefined,
    });
    report = receipt.report;
  } catch (error) {
    return failure(`QC failed: ${error instanceof Error ? error.message : String(error)}`, json);
  }

  const faults = report.findings.filter(isFault);
  if (json) {
    // The report itself, unchanged: stdout validates against the QcReport shape.
    printJson(report);
  } else {
    const technical = report.technical;
    if (technical !== undefined) {
      logLine(
        `  Length ${formatQcTime(technical.durationUs)}  video ${technical.hasVideo ? 'yes' : 'no'}  audio ${technical.hasAudio ? 'yes' : 'no'}  checks run: ${technical.checksRun.join(', ')}`,
      );
      for (const reason of technical.truncated) logWarn(`Incomplete: ${reason}`);
    }
    for (const finding of report.findings) logLine(`  ${describeFinding(finding)}`);
    if (faults.length === 0) logSuccess('No faults found.');
    else logError(`${faults.length} finding${faults.length === 1 ? '' : 's'} need attention.`);
  }
  return exitCodeForReport(report);
}
