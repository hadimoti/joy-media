import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  bareImportSpecifiers,
  locateInstalledPackage,
  missingEntryPoints,
  readWorkspacePackages,
  thirdPartyRuntimeClosure,
  unresolvedThirdPartyImports,
  unresolvedWorkspaceImports,
  workspaceImportSpecifiers,
  workspaceRuntimeClosure,
} from './workspace-staging.mjs';

/** Every `.js`, `.mjs` and `.cjs` file under a folder, for the staged-import check below. */
async function listJavaScriptFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(path)));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/**
 * Release-plan gate for signed public releases (unchanged — see the `else` branch below). The
 * actual Windows signing certificate and packaging toolchain are owner-provided operations;
 * this script refuses to create a public release when either is absent. `package:dev` remains
 * the only unsigned local package command for that path.
 *
 * `--staging`/`--unpacked` is a different, non-public path: it stages a real, runnable copy of
 * the app (no certificate needed, nothing distributable) so `test:smoke-packaged` and manual
 * QA have something to launch. See `stageRenderer` and `assembleUnpacked` below.
 */
const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const editorWebDistDir = resolve(repoRoot, 'apps', 'editor-web', 'dist');
const workerDistDir = resolve(repoRoot, 'apps', 'worker', 'dist');
const rendererStagingDir = resolve(desktopRoot, 'renderer');
const desktopDistDir = resolve(desktopRoot, 'dist');
const unpackedDir = resolve(desktopDistDir, 'joy-media-unpacked');
const compiledMainEntry = resolve(desktopDistDir, 'main', 'electron-entry.js');

const output = resolve(desktopDistDir, 'joy-media-release-plan.json');
const isStagingUnpacked = process.argv.includes('--staging') || process.argv.includes('--unpacked');

/**
 * Copies the production editor-web build into `apps/desktop/renderer`, where
 * `electron-entry.ts`'s packaged-mode `protocol.handle(PACKAGED_RENDERER_SCHEME, ...)` reads
 * from (`join(__dirname, '..', '..', 'renderer')`, resolved from the compiled
 * `dist/main/electron-entry.js`). Requires `pnpm --filter @joy-media/editor-web build` to have
 * already produced `apps/editor-web/dist/index.html` and its assets.
 */
async function stageRenderer() {
  const indexHtml = resolve(editorWebDistDir, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(
      `${indexHtml} does not exist. Run 'pnpm --filter @joy-media/editor-web build' before ` +
        `packaging --staging/--unpacked.`,
    );
  }
  await rm(rendererStagingDir, { recursive: true, force: true });
  await mkdir(rendererStagingDir, { recursive: true });
  await cp(editorWebDistDir, rendererStagingDir, { recursive: true });
  process.stderr.write(`Staged production renderer into ${rendererStagingDir}\n`);
}

/**
 * Assembles a self-contained, unsigned copy of the app at
 * `apps/desktop/dist/joy-media-unpacked` — a production package manifest, the compiled main
 * entry, preload bridge, and store modules (copied from `apps/desktop/dist`, which
 * `pnpm --filter @joy-media/desktop build` must have already produced, including the
 * `scripts/copy-static.mjs` preload `.cjs` copy), the staged renderer from `stageRenderer()`,
 * and the compiled worker package (`apps/worker/dist`, from `pnpm --filter @joy-media/worker
 * build`) staged as `joy-media-unpacked/worker`.
 *
 * The copy is laid out as `joy-media-unpacked/dist/{main,preload,store,...}` +
 * `joy-media-unpacked/renderer/` + `joy-media-unpacked/worker/`, mirroring `apps/desktop/dist/`
 * + `apps/desktop/renderer/` exactly for the first two (not flattened to
 * `joy-media-unpacked/{main,renderer,...}`) because `electron-entry.ts`'s packaged-mode
 * renderer path is `join(__dirname, '..', '..', 'renderer')` from the compiled
 * `dist/main/electron-entry.js` — two directories up from `main/` must land on the directory
 * that has `renderer/` as a sibling. Flattening one level out (verified against a real
 * Electron launch, not just inspection) makes that arithmetic land one directory too high and
 * fail with `ERR_FILE_NOT_FOUND`. `worker-entry.ts`'s `resolveWorkerEntry` walks the same
 * `../../worker/index.js` path from `dist/main`, so `worker/` must sit at that same sibling
 * level too.
 */
async function assembleUnpacked() {
  if (!existsSync(compiledMainEntry)) {
    throw new Error(
      `${compiledMainEntry} does not exist. Run 'pnpm --filter @joy-media/desktop build' before ` +
        `packaging --staging/--unpacked.`,
    );
  }
  if (!existsSync(resolve(rendererStagingDir, 'index.html'))) {
    throw new Error(`${rendererStagingDir} has no index.html — stageRenderer() must run first.`);
  }
  if (!existsSync(resolve(workerDistDir, 'index.js'))) {
    throw new Error(
      `${workerDistDir} has no index.js. Run 'pnpm --filter @joy-media/worker build' before ` +
        `packaging --staging/--unpacked.`,
    );
  }

  await rm(unpackedDir, { recursive: true, force: true });
  const unpackedDistDir = resolve(unpackedDir, 'dist');
  await mkdir(unpackedDistDir, { recursive: true });

  // Copy the compiled main/preload/store tree as-is (root-level modules + main/, preload/,
  // store/ subfolders), skipping test output and this script's own JSON evidence files.
  // `unpackedDir` lives inside `desktopDistDir` itself, and `fs.cp` refuses outright to copy a
  // directory into its own subdirectory (even with a filter excluding that subtree) — so copy
  // each top-level `dist/` entry individually instead of `desktopDistDir` as a whole.
  const distEntries = await readdir(desktopDistDir, { withFileTypes: true });
  for (const entry of distEntries) {
    if (entry.name === 'joy-media-unpacked') continue; // this run's own previous output
    if (entry.name === 'joy-media-win32-x64') continue; // standalone distribution directory
    if (entry.name === 'releases') continue; // release zip archives and checksums
    if (entry.name.endsWith('.json')) continue; // dev/release-plan evidence, not runtime
    await cp(resolve(desktopDistDir, entry.name), resolve(unpackedDistDir, entry.name), {
      recursive: true,
      filter: (source) => !/\.test\.(js|d\.ts)(\.map)?$/.test(source.replaceAll('\\', '/')),
    });
  }

  await cp(rendererStagingDir, resolve(unpackedDir, 'renderer'), { recursive: true });

  // Include the gl-transitions license alongside the files in the staged artifact.
  const glTransitionsLicenseSrc = resolve(
    repoRoot,
    'packages',
    'transition-shaders',
    'GL-TRANSITIONS-LICENSE',
  );
  const glTransitionsLicenseDest = resolve(
    unpackedDir,
    'renderer',
    'licenses',
    'third-party',
    'GL-TRANSITIONS-LICENSE',
  );
  await mkdir(dirname(glTransitionsLicenseDest), { recursive: true });
  await cp(glTransitionsLicenseSrc, glTransitionsLicenseDest);

  // Compiled worker package, staged as a sibling of dist/ and renderer/ so
  // `worker-entry.ts`'s `resolveWorkerEntry` finds it at `<mainDirname>/../../worker/index.js`.
  // Test output is excluded the same way the desktop dist copy above is.
  await cp(workerDistDir, resolve(unpackedDir, 'worker'), {
    recursive: true,
    filter: (source) => !/\.test\.(js|d\.ts)(\.map)?$/.test(source.replaceAll('\\', '/')),
  });

  // Stage the internal workspace packages that the desktop main process and the Worker import (and
  // that those packages import, transitively) into node_modules, so the packaged runtime resolves
  // them without repository-root node_modules symlinks. The list is derived from the package
  // manifests (workspace-staging.mjs): a fixed list drifted and shipped an app that could not start.
  const unpackedNodeModules = resolve(unpackedDir, 'node_modules');
  const workspacePackages = await readWorkspacePackages(repoRoot);
  const stagedRootPackages = ['@joy-media/desktop', '@joy-media/worker'].map((name) => {
    const workspacePackage = workspacePackages.get(name);
    if (workspacePackage === undefined)
      throw new Error(`Workspace package ${name} was not found under ${repoRoot}`);
    return workspacePackage;
  });
  const stagedPackages = workspaceRuntimeClosure(
    stagedRootPackages.map((workspacePackage) => workspacePackage.manifest),
    workspacePackages,
  );
  for (const workspacePackage of stagedPackages) {
    const dest = resolve(unpackedNodeModules, ...workspacePackage.name.split('/'));
    const distSrc = resolve(workspacePackage.dir, 'dist');
    if (!existsSync(distSrc)) {
      throw new Error(
        `${workspacePackage.name} has no dist folder at ${distSrc}. ` +
          `Run 'pnpm --filter ${workspacePackage.name} build' before packaging.`,
      );
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(resolve(workspacePackage.dir, 'package.json'), resolve(dest, 'package.json'));
    await cp(distSrc, resolve(dest, 'dist'), {
      recursive: true,
      filter: (source) => !/\.test\.(js|d\.ts)(\.map)?$/.test(source.replaceAll('\\', '/')),
    });
    const missing = missingEntryPoints(workspacePackage.manifest, dest);
    if (missing.length > 0) {
      throw new Error(
        `${workspacePackage.name} is missing ${missing.join(', ')} after staging. ` +
          `Run 'pnpm --filter ${workspacePackage.name} build' before packaging.`,
      );
    }
  }
  process.stderr.write(
    `Staged ${stagedPackages.length} workspace packages into ${unpackedNodeModules}: ` +
      `${stagedPackages.map((workspacePackage) => workspacePackage.name).join(', ')}\n`,
  );

  // The third-party packages that the staged code imports at runtime (the Worker's playwright-core),
  // with their own third-party dependencies, copied from the installed pnpm store. The packaged app
  // has no pnpm install of its own, so nothing else provides them. Without them the Worker exits at
  // start, and an export waits forever for it.
  const thirdPartyPackages = thirdPartyRuntimeClosure(
    [...stagedRootPackages, ...stagedPackages],
    locateInstalledPackage,
  );
  for (const thirdParty of thirdPartyPackages) {
    const dest = resolve(unpackedNodeModules, ...thirdParty.name.split('/'));
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(thirdParty.dir, dest, { recursive: true, dereference: true });
  }
  process.stderr.write(
    `Staged ${thirdPartyPackages.length} third-party runtime packages into ${unpackedNodeModules}: ` +
      `${thirdPartyPackages.map((thirdParty) => thirdParty.name).join(', ')}\n`,
  );

  // Every @joy-media import in the staged JavaScript must resolve inside the staged folder. Run
  // from inside the repository, Node finds a forgotten package by walking up to
  // apps/desktop/node_modules, so only this check, not a launch, proves the staging. The same goes
  // for every other package the staged JavaScript imports, which must be a built-in, the runtime's
  // `electron`, or a third-party package staged above.
  const importedWorkspaceSpecifiers = new Set();
  const importedBareSpecifiers = new Set();
  for (const folder of [
    resolve(unpackedDir, 'dist'),
    resolve(unpackedDir, 'worker'),
    resolve(unpackedNodeModules, '@joy-media'),
  ]) {
    for (const file of await listJavaScriptFiles(folder)) {
      const sourceText = await readFile(file, 'utf8');
      for (const specifier of workspaceImportSpecifiers(sourceText))
        importedWorkspaceSpecifiers.add(specifier);
      for (const specifier of bareImportSpecifiers(sourceText))
        importedBareSpecifiers.add(specifier);
    }
  }
  const unresolvedImports = unresolvedWorkspaceImports(
    [...importedWorkspaceSpecifiers].sort(),
    stagedPackages,
  );
  if (unresolvedImports.length > 0) {
    throw new Error(
      `The staged app imports workspace packages that were not staged: ${unresolvedImports.join(', ')}. ` +
        'Declare each one under "dependencies" in the package.json of the app or package that imports it.',
    );
  }
  const unresolvedBareImports = unresolvedThirdPartyImports(
    [...importedBareSpecifiers].sort(),
    thirdPartyPackages.map((thirdParty) => thirdParty.name),
  );
  if (unresolvedBareImports.length > 0) {
    throw new Error(
      `The staged app imports packages that were not staged: ${unresolvedBareImports.join(', ')}. ` +
        'Declare each one under "dependencies" in the package.json of the app or package that imports it, then run pnpm install.',
    );
  }

  // Preserve the project license and desktop-specific dependency notices in the unpacked package.
  await cp(resolve(repoRoot, 'LICENSE'), resolve(unpackedDir, 'LICENSE'));
  await cp(
    resolve(desktopRoot, 'THIRD_PARTY_NOTICES.md'),
    resolve(unpackedDir, 'THIRD_PARTY_NOTICES.md'),
  );

  const desktopPackageJson = JSON.parse(
    await readFile(resolve(desktopRoot, 'package.json'), 'utf8'),
  );
  const unpackedManifest = {
    name: desktopPackageJson.name,
    version: desktopPackageJson.version,
    private: true,
    type: desktopPackageJson.type,
    main: 'dist/main/electron-entry.js',
  };
  await writeFile(
    resolve(unpackedDir, 'package.json'),
    `${JSON.stringify(unpackedManifest, null, 2)}\n`,
    'utf8',
  );
  process.stderr.write(`Assembled unpacked release at ${unpackedDir}\n`);
}

if (isStagingUnpacked) {
  await stageRenderer();
  await assembleUnpacked();

  // Staging/unpacked builds are not a public release: no certificate or release-signing key is
  // required, and the plan is explicitly marked unpacked so nothing downstream mistakes it for a
  // signed, distributable artifact.
  const plan = {
    format: 'joy-media-release-plan/v1',
    appId: 'ir.joyteam.joy-media',
    platform: 'windows-x64',
    status: 'staging-unpacked',
    signing: 'unsigned',
    unpackedDir,
    reasons: [
      'staging/unpacked build requested via --staging/--unpacked; certificate and release-signing key checks are skipped',
      'not for distribution: unsigned, unpacked, staging-only artifact',
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(`Staging/unpacked release plan written to ${output}\n`);
  process.exitCode = 0;
} else {
  const certificatePath = process.env.JOY_MEDIA_WINDOWS_CERTIFICATE_PATH;
  const releasePublicKey = process.env.JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY;
  const missingReasons = [
    ...(certificatePath === undefined
      ? ['JOY_MEDIA_WINDOWS_CERTIFICATE_PATH is not configured']
      : []),
    ...(releasePublicKey === undefined
      ? ['JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY is not configured']
      : []),
    'owner-approved Windows packaging/signing toolchain is not enabled by this scaffold',
  ];
  // The owner chose to ship unsigned (no signing certificate exists for this build), so the plan says
  // "unsigned-release" rather than "blocked". This script still produces no release files: the installer
  // and the portable zip come from package-installer.mjs, so the exit code stays non-zero.
  const plan = {
    format: 'joy-media-release-plan/v1',
    appId: 'ir.joyteam.joy-media',
    platform: 'windows-x64',
    status: 'unsigned-release',
    signing: 'unsigned',
    reasons: [...missingReasons, 'unsigned release: the Windows binaries carry no code signature'],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(
    `Release plan is unsigned-release (no release files produced here); wrote plan to ${output}\n`,
  );
  process.exitCode = 2;
}
