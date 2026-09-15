import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

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
  const tempUserData = mkdtempSync(join(tmpdir(), 'joy-media-smoke-'));
  console.log(
    `[smoke-standalone] Launching standalone executable: ${standaloneExe} --smoke --user-data-dir=${tempUserData}`,
  );
  const result = spawnSync(standaloneExe, ['--smoke', `--user-data-dir=${tempUserData}`], {
    cwd: resolve(desktopRoot, 'dist', 'joy-media-win32-x64'),
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 30000,
  });

  try {
    rmSync(tempUserData, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);

  const passed =
    result.status === 0 &&
    stdout.includes('[joy-desktop] packaged renderer smoke passed') &&
    !stderr.includes('[joy-desktop] packaged renderer smoke failed');

  if (passed) {
    console.log(
      '[smoke-standalone] Native joy-media.exe standalone smoke test PASSED with exit code 0!',
    );
    process.exitCode = 0;
  } else {
    process.stderr.write(stderr);
    fail(`[smoke-standalone] Standalone smoke test FAILED (status: ${result.status}).`);
  }
}
