// Stands in for the Playwright run during `run-default-export-repeat.ps1 -SelfTest`. It writes the JSON report and the GPU record
// that the harness reads, then exits. It starts no app and does no GPU work. Usage: node selftest-fake-spec.mjs <scenario>

import { writeFile } from 'node:fs/promises';

const scenario = process.argv[2] ?? 'clean';

// Long enough for the harness to take at least two encoder samples while this process runs.
await new Promise((resolve) => setTimeout(resolve, 1200));

const reportPath = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
if (reportPath) {
  await writeFile(
    reportPath,
    JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0 } }),
    'utf8',
  );
}

const gpuPath = process.env.JOY_MEDIA_GPU_ACCEPTANCE_OUT;
if (gpuPath) {
  const lines = [{ event: 'launch', fallbackArgument: false }];
  if (scenario === 'relaunch') lines.push({ event: 'launch', fallbackArgument: true });
  if (scenario === 'gpu-exit')
    lines.push({ event: 'gpu-child-process-gone', exitCodeHex: '0xC0000409' });
  await writeFile(gpuPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
}
