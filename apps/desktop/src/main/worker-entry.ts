import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The command+args `createWorkerSupervisor` (see `worker-supervisor.ts`) should spawn. */
export interface WorkerEntryCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ResolveWorkerEntryOptions {
  /** `__dirname` of the compiled `electron-entry.js` (i.e. `.../dist/main`) — every candidate
   * location below is computed relative to it, the same way `window.ts`'s packaged renderer
   * path is. */
  readonly mainDirname: string;
  /** `process.execPath` — Electron/Node's own binary, used both to run the compiled worker
   * entry directly and to host the `tsx` loader in dev. */
  readonly execPath: string;
  /** Overridable only for tests; defaults to `node:fs`'s `existsSync`. */
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Resolves what to spawn for the local AI worker, checking in order:
 *
 * 1. Packaged/unpacked layout: `<mainDirname>/../../worker/index.js` — the compiled worker
 *    entry `package-release.mjs --unpacked` stages as a sibling of `dist/` and `renderer/`
 *    inside `joy-media-unpacked/` (see that script's `assembleUnpacked` and
 *    `copy-static.mjs`'s worker-staging step).
 * 2. Repo dev layout with a prior worker build: `<mainDirname>/../../../worker/dist/index.js`,
 *    i.e. `apps/worker/dist/index.js` from `pnpm --filter @joy-media/worker build`.
 * 3. Repo dev layout with no build yet: falls back to running `apps/worker/src/index.ts`
 *    directly through the `tsx` loader resolved from `apps/worker`'s own `node_modules` (the
 *    desktop package does not depend on `tsx` itself, so it must be resolved from there).
 *
 * Both compiled candidates are run with `node <entry.js>` — no shell, no `.cmd`/`.ps1` shim
 * resolution — matching how `worker-supervisor.ts`'s `spawn` is always called directly.
 */
export function resolveWorkerEntry(options: ResolveWorkerEntryOptions): WorkerEntryCommand {
  const { mainDirname, execPath, fileExists = existsSync } = options;

  const unpackedEntry = join(mainDirname, '..', '..', 'worker', 'index.js');
  if (fileExists(unpackedEntry)) {
    return { command: execPath, args: [unpackedEntry] };
  }

  const workerRoot = join(mainDirname, '..', '..', '..', 'worker');
  const compiledEntry = join(workerRoot, 'dist', 'index.js');
  if (fileExists(compiledEntry)) {
    return { command: execPath, args: [compiledEntry] };
  }

  const tsxCli = join(workerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const devEntry = join(workerRoot, 'src', 'index.ts');
  return { command: execPath, args: [tsxCli, devEntry] };
}
