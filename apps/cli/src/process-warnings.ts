/* global process */
/**
 * Side-effect module: MUST be the first import of the CLI entry point (`bin.ts`).
 *
 * `node:sqlite` prints "ExperimentalWarning: SQLite is an experimental feature"
 * on every run. AI callers treat any stderr as a problem signal, so this one
 * known, harmless warning is dropped. Every other warning still prints.
 *
 * Why patch `process.emit` rather than `process.emitWarning`: ESM builtins are
 * loaded while the module graph is LINKED, before any module body (this one
 * included) runs, so `emitWarning` has already been called by then. The
 * warning is only *delivered* on a later tick via `process.emit('warning')`,
 * which this filter intercepts. Works for the tsc output (`dist/bin.js`) and
 * the esbuild single-file bundle alike.
 */

type Emit = typeof process.emit;

const FILTER_FLAG = Symbol.for('joy-media.cli.sqlite-warning-filter');

export function isSqliteExperimentalWarning(warning: unknown): boolean {
  return (
    warning instanceof Error &&
    warning.name === 'ExperimentalWarning' &&
    /SQLite is an experimental feature/.test(warning.message)
  );
}

export function installSqliteWarningFilter(): void {
  const host = process as unknown as Record<symbol, unknown>;
  if (host[FILTER_FLAG]) return;
  host[FILTER_FLAG] = true;
  const originalEmit = process.emit;
  process.emit = function filteredEmit(this: NodeJS.Process, event: string | symbol, ...args) {
    if (event === 'warning' && isSqliteExperimentalWarning(args[0])) return false;
    return (originalEmit as (...a: unknown[]) => boolean).call(this, event, ...args);
  } as Emit;
}

installSqliteWarningFilter();
