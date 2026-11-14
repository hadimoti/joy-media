import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export { computeRgbaDiffMetrics, computeRgbaSpread } from './pixel-metrics.mjs';

function fmtNum(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function escapeMd(text) {
  return String(text ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ');
}

function formatParamsCell(item) {
  const total = item.paramChecks.length;
  const passed = item.paramChecks.filter((p) => p.passed).length;
  return `${passed}/${total}`;
}

function formatKeyframeCell(item) {
  const kf = item.keyframes;
  if (!kf) return 'n/a';
  if (kf.skipped) return `Skipped (${kf.policy}: ${escapeMd(kf.reason)})`;
  const icon = kf.passed ? 'PASS' : 'FAIL';
  return `${icon} \`${kf.paramKey}\` (mid-start=${fmtNum(kf.midVsStartMeanDiff)}, mid-end=${fmtNum(kf.midVsEndMeanDiff)})`;
}

function formatExportCell(item) {
  const exp = item.exportComparison;
  const nativeNote = exp.ffmpegBackendNative ? 'ffmpeg:native' : 'ffmpeg:pixi-only';
  if (!exp.ok) return `FAIL (${nativeNote}; ${escapeMd(exp.error)})`;
  return `PASS Δ=${fmtNum(exp.meanAbsoluteChannelDelta)} max=${exp.maxChannelDelta} (${exp.exportMode}; ${nativeNote})`;
}

/**
 * Format a complete Markdown report (summary + detailed per-item table).
 */
export function buildLibraryMarkdownReport(report) {
  const passedCount = report.items.filter((item) => item.passed).length;
  const failedItems = report.items.filter((item) => !item.passed);
  const lines = [
    `# Library Test Harness Report — ${report.kind}`,
    '',
    `- **Generated**: ${report.generatedAt}`,
    `- **Git commit**: \`${report.gitCommit}\``,
    `- **Items tested**: ${report.items.length} (${passedCount} passed, ${failedItems.length} failed)`,
    `- **Preview resolution**: ${report.previewResolution.width}x${report.previewResolution.height}`,
    `- **Benchmark resolution**: ${report.benchmarkResolution.width}x${report.benchmarkResolution.height}`,
    `- **Export duration**: ${report.exportDurationSec}s @ ${report.exportFps} fps`,
    `- **Known test frame**: \`${report.knownTestFramePath}\``,
    '',
    '## Results',
    '',
    '| ID | Label | Preview vs Before | Export vs Preview | Params (L/D/H) | Reset / Undo / Redo | Keyframes | 1080p ms/frame | Errors | Status |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];

  for (const item of report.items) {
    const previewCell = item.preview.passed
      ? `PASS${item.preview.neutralDefault ? ' (neutral default, visible when adjusted)' : ''} Δ=${fmtNum(item.preview.vsBeforeMeanDiff)}`
      : `FAIL Δ=${fmtNum(item.preview.vsBeforeMeanDiff)}`;
    const undoCell = item.resetUndoRedo.passed
      ? 'PASS'
      : `FAIL (${escapeMd(item.resetUndoRedo.reason ?? '')})`;
    const errorCount = item.consoleErrors.length + item.pageErrors.length;
    const statusCell = item.passed ? 'PASS' : 'FAIL';

    lines.push(
      `| \`${item.id}\` | ${escapeMd(item.label)} | ${previewCell} | ${formatExportCell(item)} | ${formatParamsCell(item)} | ${undoCell} | ${formatKeyframeCell(item)} | ${fmtNum(item.perf1080p.meanMsPerFrame)} ms | ${errorCount} | **${statusCell}** |`,
    );
  }

  if (failedItems.length > 0) {
    lines.push('', '## Failures Detail', '');
    for (const item of failedItems) {
      lines.push(`### \`${item.id}\` (${escapeMd(item.label)})`);
      for (const reason of item.failureReasons) {
        lines.push(`- ${reason}`);
      }
      if (item.consoleErrors.length > 0 || item.pageErrors.length > 0) {
        for (const err of [...item.consoleErrors, ...item.pageErrors]) {
          lines.push(`- Runtime error: ${err}`);
        }
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Persist both <kind>-report.json and <kind>-report.md into outDir.
 */
export function writeLibraryReports(outDir, kind, report) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${kind}-report.json`);
  const markdownPath = join(outDir, `${kind}-report.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, buildLibraryMarkdownReport(report), 'utf8');
  return { jsonPath, markdownPath };
}
