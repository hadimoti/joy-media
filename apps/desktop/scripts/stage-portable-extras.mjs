// Adds the parts that the shipped portable build carries beside the unpacked app: the worker, the bundled CLI with its fonts, and
// the CLI launchers. The G1 kit calls this, so its app folder has the same layout as the shipped build, apart from the
// instrumentation. It uses the same helpers as package-installer.mjs, so the two layouts cannot drift apart.
// Usage: node stage-portable-extras.mjs <standalone folder that holds joy-media.exe> [--worker <joy-worker.exe>]

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageNotoSansArabicFonts } from './copy-cli-fonts.mjs';
import {
  CLI_LAUNCHER_DIRECTORY,
  CLI_LAUNCHER_NAMES,
  cliLauncherContent,
} from './cli-launcher-layout.mjs';

const args = process.argv.slice(2);
const standalone = args[0];
const workerIndex = args.indexOf('--worker');
const workerOption = workerIndex === -1 ? null : (args[workerIndex + 1] ?? null);
if (!standalone || !existsSync(resolve(standalone, 'joy-media.exe'))) {
  throw new Error('usage: node stage-portable-extras.mjs <folder that holds joy-media.exe>');
}
const appResources = resolve(standalone, 'resources', 'app');
if (!existsSync(appResources)) {
  throw new Error(`the unpacked app is missing from ${appResources}`);
}

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

// The worker is embedded only when it is named with --worker. A worker left in apps/worker/bin by an earlier build may come from
// another commit, so this script never picks one up by itself.
if (workerOption !== null) {
  if (!existsSync(workerOption)) {
    throw new Error(`the worker named by --worker is missing: ${workerOption}`);
  }
  await mkdir(resolve(appResources, 'worker'), { recursive: true });
  await cp(workerOption, resolve(appResources, 'worker', 'joy-worker.exe'));
  console.log('Embedded the joy-worker.exe named by --worker into resources/app/worker/');
} else {
  console.log('joy-worker.exe is not embedded (pass --worker <exe> to embed one).');
}

// The bundled CLI, and its Noto Sans Arabic fonts laid out beside it as the installer lays them out.
const cliRoot = resolve(repoRoot, 'apps', 'cli');
const bundle = spawnSync(process.execPath, [resolve(cliRoot, 'scripts', 'bundle.mjs')], {
  cwd: cliRoot,
  stdio: 'inherit',
  env: process.env,
});
if (bundle.status !== 0) {
  throw new Error(`Failed to bundle CLI: status ${bundle.status}`);
}
const cliDestination = resolve(appResources, 'cli');
await mkdir(cliDestination, { recursive: true });
await cp(
  resolve(cliRoot, 'dist', 'joy-media-bundle.mjs'),
  resolve(cliDestination, 'joy-media-bundle.mjs'),
);
const fonts = stageNotoSansArabicFonts({
  sourceDirectory: resolve(cliRoot, 'dist', 'fonts', 'noto-sans-arabic'),
  destinationDirectory: resolve(cliDestination, 'fonts', 'noto-sans-arabic'),
});
console.log(
  `Embedded ${fonts.length} verified Noto Sans Arabic font files into resources/app/cli/fonts/`,
);

// The launchers sit in their own folder, the only one on the user PATH (see cli-launcher-layout.mjs for why).
const launcherDirectory = resolve(standalone, CLI_LAUNCHER_DIRECTORY);
await mkdir(launcherDirectory, { recursive: true });
for (const name of CLI_LAUNCHER_NAMES) {
  await writeFile(resolve(launcherDirectory, name), cliLauncherContent(), 'utf8');
}
console.log(`Generated ${CLI_LAUNCHER_NAMES.join(' and ')} launchers in ${CLI_LAUNCHER_DIRECTORY}`);
