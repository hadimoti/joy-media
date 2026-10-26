/* Stage probe for the GPU investigation (L2, plan section 3.2, step 2). Test tooling only: the app never loads this file.
 * run-stage-probe.mjs starts one process per stage, so a GPU crash in one stage cannot affect the next. */
'use strict';

const { app, BrowserWindow, crashReporter } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const STAGE_TIMEOUT_MS = 60000;

function option(name) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : '';
}

const stage = option('stage');
const outPath = option('out');
const goneEvents = [];
let finished = false;

// Dumps stay on this PC and nothing is uploaded, as in gpu-diagnostics.ts (GPU_DIAGNOSTIC_CRASH_REPORTER).
crashReporter.start({ uploadToServer: false, submitURL: 'http://127.0.0.1:9/' });

function finish(record, exitCode) {
  if (finished) return;
  finished = true;
  writeFileSync(
    outPath,
    JSON.stringify({ ...record, childProcessGone: goneEvents }, null, 2),
    'utf8',
  );
  app.exit(exitCode);
}

app.on('child-process-gone', (_event, details) => {
  goneEvents.push({ type: details.type, reason: details.reason, exitCode: details.exitCode });
  if (details.type === 'GPU') {
    finish(
      { stage, ok: false, crashed: 'GPU', reason: details.reason, exitCode: details.exitCode },
      3,
    );
  }
});

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    finish(
      { stage, ok: false, crashed: 'renderer', reason: details.reason, exitCode: details.exitCode },
      3,
    );
  });
  const timer = setTimeout(
    () => finish({ stage, ok: false, error: 'stage timed out' }, 4),
    STAGE_TIMEOUT_MS,
  );
  try {
    await window.loadFile(join(__dirname, 'probe-page.html'));
    const result = await window.webContents.executeJavaScript(
      `window.runProbeStage(${JSON.stringify(stage)})`,
      true,
    );
    clearTimeout(timer);
    finish({ stage, ok: true, result }, 0);
  } catch (error) {
    clearTimeout(timer);
    finish({ stage, ok: false, error: error instanceof Error ? error.message : String(error) }, 2);
  }
}

if (!stage || !outPath) {
  console.error('usage: probe-main.cjs --stage=S0 --out=<file>');
  app.exit(64);
} else {
  main();
}
