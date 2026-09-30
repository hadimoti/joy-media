import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
const unpackedDir = resolve(desktopRoot, 'dist', 'joy-media-unpacked');
const requiredLicenseFiles = [
  resolve(unpackedDir, 'LICENSE'),
  resolve(unpackedDir, 'THIRD_PARTY_NOTICES.md'),
  resolve(unpackedDir, 'renderer', 'licenses', 'third-party', 'MPL-2.0.txt'),
  resolve(unpackedDir, 'renderer', 'licenses', 'fonts', 'OFL-1.1.txt'),
  resolve(unpackedDir, 'renderer', 'licenses', 'fonts', 'FONT-ATTRIBUTIONS.md'),
  resolve(unpackedDir, 'renderer', 'licenses', 'third-party', 'GL-TRANSITIONS-LICENSE'),
];

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
} else if (requiredLicenseFiles.some((path) => !existsSync(path))) {
  fail(
    'The unpacked release is missing one or more required project/dependency license files. ' +
      "Run 'pnpm --filter @joy-media/desktop package:unpacked' again.",
  );
} else {
  // Validate THIRD_PARTY_NOTICES.md references
  let noticeValid = true;
  const noticeContent = readFileSync(resolve(unpackedDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  for (let m; (m = linkPattern.exec(noticeContent)) !== null;) {
    const target = m[2];
    if (/^https?:\/\//i.test(target)) continue;
    const resolvedTarget = resolve(unpackedDir, target);
    const pathFromPackageRoot = relative(unpackedDir, resolvedTarget);
    if (
      pathFromPackageRoot === '..' ||
      pathFromPackageRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromPackageRoot)
    ) {
      fail(`THIRD_PARTY_NOTICES.md local link escapes package directory: ${target}`);
      noticeValid = false;
      continue;
    }
    if (!existsSync(resolvedTarget)) {
      fail(`THIRD_PARTY_NOTICES.md references missing local file: ${target}`);
      noticeValid = false;
    }
  }
  if (!noticeContent.includes('https://github.com/Vanilagy/mediabunny/tree/v1.55.7')) {
    fail(
      'THIRD_PARTY_NOTICES.md is missing the required upstream source URL ' +
        'https://github.com/Vanilagy/mediabunny/tree/v1.55.7',
    );
    noticeValid = false;
  }
  if (noticeValid) {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const tempUserData = mkdtempSync(join(tmpdir(), 'joy-media-smoke-pkg-'));
    const electronPath = /** @type {string} */ (require('electron'));
    const result = spawnSync(electronPath, ['.', '--smoke', `--user-data-dir=${tempUserData}`], {
      cwd: desktopRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
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
      process.stderr.write('test:smoke-packaged passed\n');
    } else {
      process.stderr.write(stderr);
      fail(`test:smoke-packaged failed (electron exited ${String(result.status)}).`);
    }
  }
}
