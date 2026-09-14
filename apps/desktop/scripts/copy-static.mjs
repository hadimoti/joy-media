import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * `tsc -b` only emits compiled output for `src/**\/*.ts`; the hand-written CommonJS preload
 * bridge (`src/preload/*.cjs`, kept out of the ESM build on purpose — see preload.cjs's own
 * doc comment) is never copied into `dist/` on its own. `electron-entry.ts` unconditionally
 * loads `dist/preload/preload.cjs` as the window's preload script, so without this step every
 * packaged/production launch (`package:unpacked`, `test:smoke-packaged`) would either crash or
 * silently run with no `window.joyDesktop` bridge. Run after `tsc -b`, never instead of it.
 *
 * A sandboxed Electron preload script's `require()` only resolves `electron` and a small set
 * of Node built-ins — not arbitrary relative files on disk (confirmed the hard way: shipping
 * `preload.cjs` and `ipc-channels.cjs` as two separate files in `dist/preload` made every
 * packaged launch fail with `preload-error: module not found: ./ipc-channels.cjs`, caught by
 * `test:smoke-packaged`'s real sandboxed `BrowserWindow`, never by `preload.test.ts`, which
 * only ever `require()`s `ipc-channels.cjs` directly from plain Node). So this step inlines
 * `ipc-channels.cjs`'s `IPC_CHANNELS` array literal into the copied `preload.cjs`, producing a
 * single self-contained file with no relative `require` left in it. `src/preload/ipc-channels.cjs`
 * itself stays the one source of truth `preload.test.ts` checks against `ipc.ts`.
 */
const desktopRoot = resolve(import.meta.dirname, '..');
const srcPreloadDir = resolve(desktopRoot, 'src', 'preload');
const distPreloadDir = resolve(desktopRoot, 'dist', 'preload');

const require = createRequire(import.meta.url);
/** @type {{ IPC_CHANNELS: readonly string[] }} */
const { IPC_CHANNELS } = require(resolve(srcPreloadDir, 'ipc-channels.cjs'));

const preloadSource = await readFile(resolve(srcPreloadDir, 'preload.cjs'), 'utf8');
const requireLine = "const { IPC_CHANNELS } = require('./ipc-channels.cjs');";
if (!preloadSource.includes(requireLine)) {
  throw new Error(
    `src/preload/preload.cjs no longer contains the expected line:\n  ${requireLine}\n` +
      'Update copy-static.mjs to match before shipping a packaged build.',
  );
}
const inlinedPreload = preloadSource.replace(
  requireLine,
  `const IPC_CHANNELS = Object.freeze(${JSON.stringify(IPC_CHANNELS)});`,
);

await mkdir(distPreloadDir, { recursive: true });
await writeFile(resolve(distPreloadDir, 'preload.cjs'), inlinedPreload, 'utf8');
process.stdout.write(`Wrote self-contained preload bridge into ${distPreloadDir}\n`);
