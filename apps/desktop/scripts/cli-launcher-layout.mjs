/**
 * The Windows CLI launcher contract (L8, F1). The launchers live in a `bin` folder, and only that
 * folder goes on the user PATH. The install root also holds `joy-media.exe` (the GUI), and Windows
 * tries `.EXE` before `.CMD`, so a bare `joy-media` on a PATH that lists the root opens the GUI.
 * Keeping the launchers in their own folder fixes that. The CLI runs on Electron's bundled Node, so
 * the launcher sets ELECTRON_RUN_AS_NODE and needs no Node on PATH.
 */

export const CLI_LAUNCHER_DIRECTORY = 'bin';
export const CLI_LAUNCHER_NAMES = ['joy.cmd', 'joy-media.cmd'];

/** The launcher script. It runs from `bin`, so the GUI binary and the bundle are one level up. */
export function cliLauncherContent() {
  return [
    '@echo off',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%~dp0..\\joy-media.exe" "%~dp0..\\resources\\app\\cli\\joy-media-bundle.mjs" %*',
    '',
  ].join('\n');
}

/** The folder that goes on the user PATH for an install at `installPath`. */
export function cliLauncherPathEntry(installPath) {
  return `${installPath}\\${CLI_LAUNCHER_DIRECTORY}`;
}
