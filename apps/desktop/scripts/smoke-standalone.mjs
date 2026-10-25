import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { superviseSmoke } from './smoke-supervisor.mjs';

const desktopRoot = resolve(import.meta.dirname, '..');
const standaloneExe = resolve(desktopRoot, 'dist', 'joy-media-win32-x64', 'joy-media.exe');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!existsSync(standaloneExe)) {
  fail(
    `${standaloneExe} does not exist. Run 'pnpm --filter @joy-media/desktop package:installer' before test:smoke-standalone.`,
  );
} else {
  console.log(
    `[smoke-standalone] Launching standalone executable under the smoke supervisor: ${standaloneExe} --smoke`,
  );
  // The supervisor removes the run's profile after the app and its processes have exited.
  const result = await superviseSmoke({
    executable: standaloneExe,
    args: ['--smoke'],
    cwd: resolve(desktopRoot, 'dist', 'joy-media-win32-x64'),
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const stdout = result.stdout;
  const stderr = result.stderr;
  process.stdout.write(stdout);
  process.stdout.write(`[smoke-supervisor] ${JSON.stringify(result.summary)}\n`);

  const passed =
    result.exitCode === 0 &&
    stdout.includes('[joy-desktop] packaged renderer smoke passed') &&
    !stderr.includes('[joy-desktop] packaged renderer smoke failed');

  if (passed) {
    console.log(
      '[smoke-standalone] Native joy-media.exe standalone smoke test PASSED with exit code 0!',
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(stderr);
    fail(`[smoke-standalone] Standalone smoke test FAILED (status: ${result.exitCode}).`);
  }
}
