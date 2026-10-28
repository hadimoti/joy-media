/**
 * GPU acceptance wrapper (plan section 10d, G0 item 4a; OA3). It runs the export journey of export-semantics.spec.ts without
 * changing that file, and attaches a listener to every launch from the test side only:
 * - each launch is recorded, and whether it carried the encode-fallback argument;
 * - each GPU child-process exit is recorded, with its exit code and the normalised form (0xC0000409 style).
 *
 * The records are appended to the file named by JOY_MEDIA_GPU_ACCEPTANCE_OUT. tooling/diagnostics/run-default-export-repeat.ps1
 * sets that file outside the repository. Nothing here is part of the app or of the production build.
 */
import { appendFileSync } from 'node:fs';
import { _electron as electron } from '@playwright/test';
import './export-semantics.spec.js';

// Must match GPU_ENCODE_FALLBACK_ARGUMENT in apps/desktop/src/main/gpu-encode-fallback.ts.
const FALLBACK_ARGUMENT = '--joy-media-gpu-encode-fallback';
const recordPath = process.env['JOY_MEDIA_GPU_ACCEPTANCE_OUT'];

function record(entry: Record<string, unknown>): void {
  if (recordPath === undefined) return;
  appendFileSync(recordPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

if (recordPath !== undefined) {
  type Launch = typeof electron.launch;
  const launchOriginal: Launch = electron.launch.bind(electron);
  (electron as { launch: Launch }).launch = async (options) => {
    const args = options?.args ?? [];
    record({
      event: 'launch',
      fallbackArgument: args.some((argument) => argument.includes(FALLBACK_ARGUMENT)),
    });
    const app = await launchOriginal(options);
    // Installed straight after the launch, in the main process. The file path is passed in, so the listener writes it directly.
    await app.evaluate(({ app: electronApp }, file) => {
      const fs = process.getBuiltinModule('node:fs');
      electronApp.on('child-process-gone', (_event, details) => {
        if (details.type !== 'GPU') return;
        const exitCode = details.exitCode;
        const line = {
          time: new Date().toISOString(),
          event: 'gpu-child-process-gone',
          reason: details.reason,
          exitCode,
          exitCodeHex: `0x${(exitCode >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
        };
        fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
      });
    }, recordPath);
    return app;
  };
}
