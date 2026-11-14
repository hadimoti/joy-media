import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Compute mean and max absolute channel difference between two equal-length
 * RGBA buffers (measuring RGB channels only so alpha padding cannot skew scores).
 */
export function computeRgbaDiffMetrics(rgbaA, rgbaB) {
  if (rgbaA.length !== rgbaB.length || rgbaA.length % 4 !== 0) {
    throw new Error(`RGBA buffer mismatch: ${rgbaA.length} vs ${rgbaB.length}`);
  }
  const pixelCount = rgbaA.length / 4;
  let totalAbs = 0;
  let maxDiff = 0;
  let changedPixels = 0;

  for (let i = 0; i < rgbaA.length; i += 4) {
    const dr = Math.abs(rgbaA[i] - rgbaB[i]);
    const dg = Math.abs(rgbaA[i + 1] - rgbaB[i + 1]);
    const db = Math.abs(rgbaA[i + 2] - rgbaB[i + 2]);
    const pixelMax = Math.max(dr, dg, db);
    if (pixelMax > 0) changedPixels += 1;
    if (pixelMax > maxDiff) maxDiff = pixelMax;
    totalAbs += dr + dg + db;
  }

  return {
    meanAbsDiff: pixelCount === 0 ? 0 : totalAbs / (pixelCount * 3),
    maxDiff,
    changedPixels,
    totalPixels: pixelCount,
  };
}

/**
 * Measure RGB color spread across a rendered RGBA frame to catch solid-color or
 * completely blank renders.
 */
export function computeRgbaSpread(rgba) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error(`Invalid RGBA buffer length: ${rgba.length}`);
  }
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return {
    rangeR: maxR - minR,
    rangeG: maxG - minG,
    rangeB: maxB - minB,
    maxChannelRange: Math.max(maxR - minR, maxG - minG, maxB - minB),
  };
}

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
      ? `PASS Δ=${fmtNum(item.preview.vsBeforeMeanDiff)}`
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
