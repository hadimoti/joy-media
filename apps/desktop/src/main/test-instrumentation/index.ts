/**
 * Test-only instrumentation for the GPU investigation (plan section 10d, G0 item 2; OA3). It is staged only by
 * `package-release.mjs --instrumented`. `electron-entry.ts` loads it only when this folder exists, so a default or release
 * package never runs it and never names its files. It must run before the app is ready: it sets Chromium switches, and the
 * test-only user-data switch moves the user-data folder.
 */
import { app, crashReporter } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installGpuDiagnostics } from './gpu-diagnostics.js';
import { GpuEventLog, nodeGpuEventFileSystem } from './gpu-event-log.js';

/** Test-only switch: the user-data folder for this launch. A G1 session keeps all its data in one folder this way. */
export const TEST_USER_DATA_SWITCH = '--joy-media-test-user-data=';

/** The folder named by the test-only switch, or undefined when the switch is absent or names no folder. */
export function testUserDataFromArgv(argv: readonly string[]): string | undefined {
  const value = argv
    .find((arg) => arg.startsWith(TEST_USER_DATA_SWITCH))
    ?.slice(TEST_USER_DATA_SWITCH.length);
  return value ? value : undefined;
}

/** Appends one line to a file in the user-data folder. Diagnostics never stop the app from starting. */
function appendUserDataLine(file: string, line: string): void {
  try {
    const folder = app.getPath('userData');
    mkdirSync(folder, { recursive: true });
    appendFileSync(join(folder, file), `${line}\n`);
  } catch {
    // Diagnostics must never stop the app from starting.
  }
}

/** Wires every test-only hook. electron-entry.ts calls this once, before the app is ready. */
export function installTestInstrumentation(argv: readonly string[]): void {
  const userData = testUserDataFromArgv(argv);
  if (userData !== undefined) app.setPath('userData', userData);

  const gpuEvents = new GpuEventLog(() => app.getPath('userData'), nodeGpuEventFileSystem);
  app.on('child-process-gone', (_event, details) => {
    gpuEvents.record(details, new Date());
  });

  installGpuDiagnostics(
    {
      commandLine: app.commandLine,
      crashReporter,
      onChildProcessGone: (listener) =>
        app.on('child-process-gone', (_event, details) => listener(details)),
      onReady: (callback) => void app.whenReady().then(callback),
      gpuState: async () => ({
        info: await app.getGPUInfo('complete'),
        features: app.getGPUFeatureStatus(),
      }),
      log: (line) => appendUserDataLine('gpu-diagnostics.jsonl', line),
    },
    argv,
  );
}
