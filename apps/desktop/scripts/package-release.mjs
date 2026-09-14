import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 * `scripts/copy-static.mjs` preload `.cjs` copy), plus the staged renderer from
 * `stageRenderer()`.
 *
 * The copy is laid out as `joy-media-unpacked/dist/{main,preload,store,...}` +
 * `joy-media-unpacked/renderer/`, mirroring `apps/desktop/dist/` + `apps/desktop/renderer/`
 * exactly (not flattened to `joy-media-unpacked/{main,renderer,...}`) because
 * `electron-entry.ts`'s packaged-mode renderer path is `join(__dirname, '..', '..',
 * 'renderer')` from the compiled `dist/main/electron-entry.js` — two directories up from
 * `main/` must land on the directory that has `renderer/` as a sibling. Flattening one level
 * out (verified against a real Electron launch, not just inspection) makes that arithmetic
 * land one directory too high and fail with `ERR_FILE_NOT_FOUND`.
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
    if (entry.name.endsWith('.json')) continue; // dev/release-plan evidence, not runtime
    await cp(resolve(desktopDistDir, entry.name), resolve(unpackedDistDir, entry.name), {
      recursive: true,
      filter: (source) => !/\.test\.(js|d\.ts)(\.map)?$/.test(source.replaceAll('\\', '/')),
    });
  }

  await cp(rendererStagingDir, resolve(unpackedDir, 'renderer'), { recursive: true });

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
  const blockedReasons = [
    ...(certificatePath === undefined
      ? ['JOY_MEDIA_WINDOWS_CERTIFICATE_PATH is not configured']
      : []),
    ...(releasePublicKey === undefined
      ? ['JOY_MEDIA_RELEASE_SIGNING_PUBLIC_KEY is not configured']
      : []),
    'owner-approved Windows packaging/signing toolchain is not enabled by this scaffold',
  ];
  const plan = {
    format: 'joy-media-release-plan/v1',
    appId: 'ir.joyteam.joy-media',
    platform: 'windows-x64',
    status: 'blocked',
    signing: 'owner-gated',
    reasons: blockedReasons,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(`Release packaging is blocked; wrote evidence plan to ${output}\n`);
  process.exitCode = 2;
}
