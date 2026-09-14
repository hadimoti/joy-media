import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * `test:smoke-packaged`: launches the real, compiled `dist/main/electron-entry.js` under a
 * real Electron binary with `NODE_ENV=production` and `--smoke`, and asserts (not just logs)
 * that it loaded `joy-media-app://renderer/index.html` and exited cleanly — the packaged-mode
 * counterpart to the dev-mode `test:smoke` added in wave 9, which never awaited its `loadURL`
 * call. Requires `pnpm --filter @joy-media/desktop build` (compiles the main process and, via
 * `scripts/copy-static.mjs`, the preload `.cjs` bridge) and `pnpm --filter @joy-media/desktop
 * package:unpacked` (stages `apps/desktop/renderer` from the built editor-web bundle) to have
 * already run.
 */
const require = createRequire(import.meta.url);
const desktopRoot = resolve(import.meta.dirname, '..');
const compiledMainEntry = resolve(desktopRoot, 'dist', 'main', 'electron-entry.js');
const rendererIndex = resolve(desktopRoot, 'renderer', 'index.html');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (!existsSync(compiledMainEntry)) {
  fail(
    `${compiledMainEntry} does not exist. Run 'pnpm --filter @joy-media/desktop build' before ` +
      `test:smoke-packaged.`,
  );
} else if (!existsSync(rendererIndex)) {
  fail(
    `${rendererIndex} does not exist. Run 'pnpm --filter @joy-media/desktop package:unpacked' ` +
      `before test:smoke-packaged.`,
  );
} else {
  const electronPath = /** @type {string} */ (require('electron'));
  const result = spawnSync(electronPath, ['.', '--smoke'], {
    cwd: desktopRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  const passed =
    result.status === 0 &&
    stdout.includes('[joy-desktop] packaged renderer smoke passed') &&
    !stderr.includes('[joy-desktop] packaged renderer smoke failed');
  if (passed) {
    process.stderr.write('test:smoke-packaged passed\n');
  } else {
    process.stderr.write(stderr);
    fail(`test:smoke-packaged failed (electron exited ${String(result.status)}).`);
  }
}
