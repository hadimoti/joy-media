#!/usr/bin/env node
/* global window */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { compareFrames, extractExportFrame } from '../compare.mjs';
import {
  parseCliArgs,
  parseLibraryAuditMarkdown,
  planParameterVariations,
  selectKeyframePlan,
} from './src/audit-metadata.mjs';
import { buildTransitionsMarkdownReport, writeLibraryReports } from './src/report.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const AUDIT_MD_PATH = resolve(REPO_ROOT, 'docs/qa/v1.1.1/LIBRARY-AUDIT.md');
const BROWSER_RUNNER_PATH = resolve(import.meta.dirname, 'src/browser-runner.ts');
const EXPORT_COMPARE_MAX_MEAN_DELTA = 12.0;

function printUsage() {
  console.log(
    [
      'Usage: node tooling/qa/libraries/run-library-tests.mjs [options]',
      '',
      'Options:',
      '  --kind filters|effects|transitions   Library panel kind to test (default: filters)',
      '  --items id1,id2                      Comma-separated subset of item ids to run',
      '  --limit N                            Max number of items to run after filtering',
      '  --out <dir>                          Directory for reports, renders, and exported clips',
      '  --face <path>                        Optional portrait photo for bottom-right quadrant',
      '  --pic1 <path>                        First clip picture for transitions (Left/From)',
      '  --pic2 <path>                        Second clip picture for transitions (Right/To)',
      '  -h, --help                           Show this help text',
    ].join('\n'),
  );
}

function resolveGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function readImageDataUrl(imagePath) {
  if (!imagePath) return undefined;
  const resolved = resolve(imagePath);
  if (!existsSync(resolved)) return undefined;
  const ext = extname(resolved).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const base64 = readFileSync(resolved).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function resolveFfmpegBin() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  return 'ffmpeg';
}

function encodePngFramesToMp4(framesDir, mp4Path, fps = 30) {
  const ffmpegBin = resolveFfmpegBin();
  const res = spawnSync(
    ffmpegBin,
    [
      '-y',
      '-framerate',
      String(fps),
      '-i',
      join(framesDir, 'frame-%03d.png'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      '-movflags',
      '+faststart',
      mp4Path,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed (${res.status}): ${res.stderr}`);
  }
}

function buildWorkspaceAliases() {
  const packagesDir = resolve(REPO_ROOT, 'packages');
  const aliases = {
    '@joy-media/renderer-pixi/browser': resolve(packagesDir, 'renderer-pixi/src/browser.ts'),
  };
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
    const srcIndex = join(packagesDir, entry.name, 'src/index.ts');
    if (!existsSync(pkgJsonPath) || !existsSync(srcIndex)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (typeof pkg.name === 'string') {
      aliases[pkg.name] = srcIndex;
    }
  }
  return aliases;
}

async function startHarnessViteServer() {
  const editorRequire = createRequire(resolve(REPO_ROOT, 'apps/editor-web/package.json'));
  const { createServer } = await import(pathToFileURL(editorRequire.resolve('vite')).href);
  const browserRunnerFsUrl = `/@fs/${BROWSER_RUNNER_PATH.replaceAll('\\', '/')}`;
  const server = await createServer({
    configFile: resolve(REPO_ROOT, 'apps/editor-web/vite.config.ts'),
    root: resolve(REPO_ROOT, 'apps/editor-web'),
    resolve: {
      alias: buildWorkspaceAliases(),
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      open: false,
      fs: { allow: [REPO_ROOT] },
    },
    logLevel: 'error',
    plugins: [
      {
        name: 'joy-library-harness-entry',
        configureServer(viteServer) {
          viteServer.middlewares.use('/__library-harness.html', async (_req, res, next) => {
            try {
              const rawHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Joy Library Harness</title></head>
<body>
<script type="module" src="${browserRunnerFsUrl}"></script>
</body>
</html>`;
              const html = await viteServer.transformIndexHtml('/__library-harness.html', rawHtml);
              res.statusCode = 200;
              res.setHeader('content-type', 'text/html; charset=utf-8');
              res.end(html);
            } catch (err) {
              next(err);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('Could not bind Vite dev server port');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/__library-harness.html`,
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const auditMap = parseLibraryAuditMarkdown(readFileSync(AUDIT_MD_PATH, 'utf8'));
  const faceDataUrl = readImageDataUrl(options.facePath);

  const OWNER_ASSETS_DIR = resolve(REPO_ROOT, '../joy-media-temps/fable-plan/assets-from-owner');
  const altOwnerAssets = 'C:/Users/HadiMoti/Desktop/joy-media-temps/fable-plan/assets-from-owner';
  const defaultPic1 = existsSync(join(OWNER_ASSETS_DIR, 'transition-preview-pic1.jpg'))
    ? join(OWNER_ASSETS_DIR, 'transition-preview-pic1.jpg')
    : join(altOwnerAssets, 'transition-preview-pic1.jpg');
  const defaultPic2 = existsSync(join(OWNER_ASSETS_DIR, 'transition-preview-pic2.jpg'))
    ? join(OWNER_ASSETS_DIR, 'transition-preview-pic2.jpg')
    : join(altOwnerAssets, 'transition-preview-pic2.jpg');
  const pic1DataUrl = readImageDataUrl(options.pic1Path || defaultPic1);
  const pic2DataUrl = readImageDataUrl(options.pic2Path || defaultPic2);

  console.log(`Starting Vite server for library harness (${options.kind})...`);
  const { server, url } = await startHarnessViteServer();

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const runtimeConsoleErrors = [];
    const runtimePageErrors = [];
    let settledStartup = false;
    page.on('console', (msg) => {
      console.log(`[browser ${msg.type()}]`, msg.text());
      if (msg.type() === 'error') {
        runtimeConsoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      runtimePageErrors.push(err.message);
      console.error('[browser pageerror]', err.message);
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !settledStartup) {
        console.error(`[browser HTTP ${res.status()}] ${res.url()}`);
      }
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__JOY_LIBRARY_HARNESS__), {
      timeout: 30_000,
    });
    settledStartup = true;

    const initResult = await page.evaluate((arg) => window.__JOY_LIBRARY_HARNESS__.init(arg), {
      faceDataUrl,
      pic1DataUrl,
      pic2DataUrl,
    });

    const knownFramePath = join(outDir, 'known-test-frame-1080p.png');
    writeFileSync(knownFramePath, Buffer.from(initResult.knownChartPngBase64, 'base64'));
    const beforePreviewPath = join(outDir, 'before-540p.png');
    writeFileSync(beforePreviewPath, Buffer.from(initResult.beforePngBase64, 'base64'));

    const allIdsForKind =
      options.kind === 'filters'
        ? initResult.filters
        : options.kind === 'effects'
          ? initResult.effects
          : initResult.transitions;
    let selectedIds = [...allIdsForKind];
    if (options.items) {
      const missing = options.items.filter((id) => !allIdsForKind.includes(id));
      if (missing.length > 0) {
        throw new Error(
          `Unknown ${options.kind} item id(s): ${missing.join(', ')}. Available: ${allIdsForKind.join(', ')}`,
        );
      }
      selectedIds = options.items;
    }
    if (options.limit !== undefined) {
      selectedIds = selectedIds.slice(0, options.limit);
    }

    const descriptorMap = new Map(initResult.descriptors.map((d) => [d.id, d]));
    const itemReports = [];

    if (options.kind === 'transitions') {
      for (const id of selectedIds) {
        const consoleStart = runtimeConsoleErrors.length;
        const pageErrStart = runtimePageErrors.length;
        const descriptor = descriptorMap.get(id) || {
          id,
          label: id,
          category: 'transitions',
          options: ['duration'],
        };

        console.log(`Testing [transitions] ${id} (${descriptor.label})...`);
        const browserResult = await page.evaluate(
          (payload) => window.__JOY_LIBRARY_HARNESS__.testTransition(payload),
          { id },
        );

        const itemDir = join(outDir, 'transitions', id.replace(/[:/]/g, '_'));
        mkdirSync(itemDir, { recursive: true });

        const pFrames = [
          { key: '000', pct: 0, timeSec: 1.0, b64: browserResult.preview.p0Base64 },
          { key: '025', pct: 25, timeSec: 1.25, b64: browserResult.preview.p25Base64 },
          { key: '050', pct: 50, timeSec: 1.5, b64: browserResult.preview.p50Base64 },
          { key: '075', pct: 75, timeSec: 1.75, b64: browserResult.preview.p75Base64 },
          { key: '100', pct: 100, timeSec: 2.0, b64: browserResult.preview.p100Base64 },
        ];

        for (const pf of pFrames) {
          writeFileSync(join(itemDir, `preview-${pf.key}.png`), Buffer.from(pf.b64, 'base64'));
        }

        const exportPath = join(itemDir, 'export.mp4');
        if (browserResult.exportArtifact.mp4Base64) {
          writeFileSync(exportPath, Buffer.from(browserResult.exportArtifact.mp4Base64, 'base64'));
        } else if (browserResult.exportArtifact.framesPngBase64) {
          const framesDir = join(itemDir, 'frames');
          mkdirSync(framesDir, { recursive: true });
          browserResult.exportArtifact.framesPngBase64.forEach((b64, idx) => {
            writeFileSync(
              join(framesDir, `frame-${String(idx + 1).padStart(3, '0')}.png`),
              Buffer.from(b64, 'base64'),
            );
          });
          encodePngFramesToMp4(framesDir, exportPath, 20);
        }

        const compareDir = join(itemDir, 'compare');
        mkdirSync(compareDir, { recursive: true });
        const pointComparisons = [];
        let exportAllPointsMatch = true;
        let sumDelta = 0;
        let maxDelta = 0;

        for (const pf of pFrames) {
          const previewFramePath = join(itemDir, `preview-${pf.key}.png`);
          const exportFramePath = join(itemDir, `export-${pf.key}.png`);

          if (browserResult.exportArtifact.directFramesPngBase64?.[String(pf.pct)]) {
            writeFileSync(
              exportFramePath,
              Buffer.from(
                browserResult.exportArtifact.directFramesPngBase64[String(pf.pct)],
                'base64',
              ),
            );
          } else if (existsSync(exportPath)) {
            await extractExportFrame(exportPath, pf.timeSec, exportFramePath, {
              width: 960,
              height: 540,
            });
          }

          if (existsSync(exportFramePath)) {
            const cmp = await compareFrames(
              previewFramePath,
              exportFramePath,
              join(compareDir, pf.key),
            );
            const matches = cmp.meanAbsoluteChannelDelta <= EXPORT_COMPARE_MAX_MEAN_DELTA;
            if (!matches) exportAllPointsMatch = false;
            sumDelta += cmp.meanAbsoluteChannelDelta;
            if (cmp.maxChannelDelta > maxDelta) maxDelta = cmp.maxChannelDelta;
            pointComparisons.push({
              percent: pf.pct,
              delta: cmp.meanAbsoluteChannelDelta,
              maxDelta: cmp.maxChannelDelta,
              status: cmp.status,
              ok: matches,
            });
          } else {
            exportAllPointsMatch = false;
            pointComparisons.push({
              percent: pf.pct,
              delta: 999,
              maxDelta: 999,
              status: 'missing-frame',
              ok: false,
            });
          }
        }

        const meanDelta = sumDelta / pFrames.length;
        const exportComparison = {
          ok: exportAllPointsMatch && !browserResult.exportArtifact.error,
          exportMode: browserResult.exportArtifact.mode,
          points: pointComparisons,
          meanDelta,
          maxDelta,
          error:
            browserResult.exportArtifact.error ??
            (exportAllPointsMatch
              ? undefined
              : 'Export comparison exceeded delta threshold on one or more points'),
        };

        const itemConsoleErrors = runtimeConsoleErrors.slice(consoleStart);
        const itemPageErrors = runtimePageErrors.slice(pageErrStart);

        const failureReasons = [];
        if (!browserResult.preview.passed) {
          failureReasons.push(
            'Preview frames did not properly transition from clip A to clip B (frame 0 must equal A, frame 100 must equal B, and an intermediate frame must differ from both)',
          );
        }
        if (!exportComparison.ok) {
          failureReasons.push(`Export comparison failed: ${exportComparison.error}`);
        }
        if (!browserResult.optionsResults.duration.passed) {
          failureReasons.push('Duration option variation did not alter rendering');
        }
        if (
          browserResult.optionsResults.direction &&
          !browserResult.optionsResults.direction.passed
        ) {
          failureReasons.push('Direction option variation did not alter rendering');
        }
        if (browserResult.optionsResults.colour && !browserResult.optionsResults.colour.passed) {
          failureReasons.push('Colour option variation did not alter rendering');
        }
        if (browserResult.optionsResults.easing && !browserResult.optionsResults.easing.passed) {
          failureReasons.push('Easing option variation did not alter rendering');
        }
        if (!browserResult.audioCrossfade.passed) {
          failureReasons.push(
            `Audio crossfade failed: ${browserResult.audioCrossfade.reason ?? 'level jump or power deviation'}`,
          );
        }
        if (browserResult.edgeCases) {
          const ec = browserResult.edgeCases;
          if (!ec.clipShorterThanDuration.passed) {
            failureReasons.push(
              `Edge case clipShorterThanDuration failed: ${ec.clipShorterThanDuration.details}`,
            );
          }
          if (!ec.firstAndLastClip.passed) {
            failureReasons.push(
              `Edge case firstAndLastClip failed: ${ec.firstAndLastClip.details}`,
            );
          }
          if (!ec.differentSizeAndFramerate.passed) {
            failureReasons.push(
              `Edge case differentSizeAndFramerate failed: ${ec.differentSizeAndFramerate.details}`,
            );
          }
          if (!ec.lifecycle.passed) {
            failureReasons.push(`Edge case lifecycle failed: ${ec.lifecycle.details}`);
          }
        }
        if (itemConsoleErrors.length > 0 || itemPageErrors.length > 0) {
          failureReasons.push(
            `Captured ${itemConsoleErrors.length} console errors and ${itemPageErrors.length} page errors`,
          );
        }

        itemReports.push({
          id: browserResult.id,
          label: browserResult.label,
          category: browserResult.category,
          passed: failureReasons.length === 0,
          failureReasons,
          preview: browserResult.preview,
          exportComparison,
          optionsResults: browserResult.optionsResults,
          audioCrossfade: browserResult.audioCrossfade,
          perf1080p: browserResult.perf1080p,
          edgeCases: browserResult.edgeCases,
          consoleErrors: itemConsoleErrors,
          pageErrors: itemPageErrors,
          artifacts: {
            previewFrames: pFrames.map((pf) => join(itemDir, `preview-${pf.key}.png`)),
            exportPath,
          },
        });
      }
    } else {
      for (const id of selectedIds) {
        const consoleStart = runtimeConsoleErrors.length;
        const pageErrStart = runtimePageErrors.length;
        const descriptor = descriptorMap.get(id);
        if (!descriptor) {
          throw new Error(`Descriptor missing for ${id}`);
        }
        const auditEntry = auditMap.get(id);
        const paramVariations = planParameterVariations(descriptor);
        const keyframePlan = selectKeyframePlan(descriptor, auditEntry);

        console.log(`Testing [${options.kind}] ${id} (${descriptor.label})...`);
        const browserResult = await page.evaluate(
          (payload) => window.__JOY_LIBRARY_HARNESS__.testItem(payload),
          { id, paramVariations, keyframePlan },
        );

        const itemDir = join(outDir, options.kind, id);
        mkdirSync(itemDir, { recursive: true });
        const previewPath = join(itemDir, 'preview.png');
        writeFileSync(previewPath, Buffer.from(browserResult.previewPngBase64, 'base64'));

        const exportPath = join(itemDir, 'export.mp4');
        const exportFramePath = join(itemDir, 'export-frame.png');
        const compareDir = join(itemDir, 'compare');
        mkdirSync(compareDir, { recursive: true });

        let exportComparison;
        if (browserResult.exportArtifact.error) {
          exportComparison = {
            ok: false,
            exportMode: browserResult.exportArtifact.mode,
            ffmpegBackendNative: browserResult.ffmpegBackendNative,
            error: browserResult.exportArtifact.error,
          };
        } else {
          if (browserResult.exportArtifact.mp4Base64) {
            writeFileSync(
              exportPath,
              Buffer.from(browserResult.exportArtifact.mp4Base64, 'base64'),
            );
          } else if (browserResult.exportArtifact.framesPngBase64) {
            const framesDir = join(itemDir, 'frames');
            mkdirSync(framesDir, { recursive: true });
            browserResult.exportArtifact.framesPngBase64.forEach((b64, idx) => {
              writeFileSync(
                join(framesDir, `frame-${String(idx + 1).padStart(3, '0')}.png`),
                Buffer.from(b64, 'base64'),
              );
            });
            encodePngFramesToMp4(framesDir, exportPath, 30);
          } else {
            throw new Error(`No export artifact produced for ${id}`);
          }

          extractExportFrame(exportPath, 1.0, exportFramePath, { width: 960, height: 540 });
          const cmp = await compareFrames(previewPath, exportFramePath, compareDir);
          const exportMatchesPreview =
            cmp.meanAbsoluteChannelDelta <= EXPORT_COMPARE_MAX_MEAN_DELTA;
          exportComparison = {
            ok: exportMatchesPreview,
            exportMode: browserResult.exportArtifact.mode,
            ffmpegBackendNative: browserResult.ffmpegBackendNative,
            ffmpegFilterGraphPresent: browserResult.ffmpegFilterGraphPresent,
            auditExportFlag: auditEntry?.exportFlag ?? 'unknown',
            strictCompareStatus: cmp.status,
            meanAbsoluteChannelDelta: cmp.meanAbsoluteChannelDelta,
            maxChannelDelta: cmp.maxChannelDelta,
            differingChannels: cmp.differingChannels,
            totalChannels: cmp.totalChannels,
            sideBySidePath: cmp.sideBySide,
            error: exportMatchesPreview
              ? undefined
              : `Export delta ${cmp.meanAbsoluteChannelDelta.toFixed(2)} exceeds ${EXPORT_COMPARE_MAX_MEAN_DELTA}`,
          };
        }

        const itemConsoleErrors = runtimeConsoleErrors.slice(consoleStart);
        const itemPageErrors = runtimePageErrors.slice(pageErrStart);

        const failureReasons = [];
        if (!browserResult.preview.passed) {
          failureReasons.push(
            browserResult.preview.isBlankFrame
              ? 'Preview rendered blank/uniform frame'
              : `Preview identical to Before (meanAbsDiff=${browserResult.preview.vsBeforeMeanDiff.toFixed(3)})`,
          );
        }
        if (!exportComparison.ok) {
          failureReasons.push(`Export comparison failed: ${exportComparison.error}`);
        }
        const failedParams = browserResult.paramChecks.filter((p) => !p.passed);
        if (failedParams.length > 0) {
          failureReasons.push(
            `Parameter sweep had no rendered change for: ${failedParams.map((p) => p.key).join(', ')}`,
          );
        }
        if (!browserResult.resetUndoRedo.passed) {
          failureReasons.push(`Reset/Undo/Redo failed: ${browserResult.resetUndoRedo.reason}`);
        }
        if (!browserResult.keyframes.passed) {
          failureReasons.push(
            `Keyframes mid frame did not differ from both ends (startΔ=${browserResult.keyframes.midVsStartMeanDiff.toFixed(3)}, endΔ=${browserResult.keyframes.midVsEndMeanDiff.toFixed(3)})`,
          );
        }
        if (itemConsoleErrors.length > 0 || itemPageErrors.length > 0) {
          failureReasons.push(
            `Captured ${itemConsoleErrors.length} console errors and ${itemPageErrors.length} page errors`,
          );
        }

        itemReports.push({
          id: browserResult.id,
          label: browserResult.label,
          category: browserResult.category,
          passed: failureReasons.length === 0,
          failureReasons,
          preview: browserResult.preview,
          exportComparison,
          paramChecks: browserResult.paramChecks,
          resetUndoRedo: browserResult.resetUndoRedo,
          keyframes: browserResult.keyframes,
          perf1080p: browserResult.perf1080p,
          consoleErrors: itemConsoleErrors,
          pageErrors: itemPageErrors,
          artifacts: {
            previewPath,
            exportPath,
            exportFramePath,
          },
        });
      }
    }

    await page.evaluate(() => window.__JOY_LIBRARY_HARNESS__.cleanup());

    const reportPayload = {
      kind: options.kind,
      generatedAt: new Date().toISOString(),
      gitCommit: resolveGitCommit(),
      previewResolution: { width: 960, height: 540 },
      benchmarkResolution: { width: 1920, height: 1080 },
      exportDurationSec: options.kind === 'transitions' ? 3 : 2,
      exportFps: options.kind === 'transitions' ? 20 : 30,
      offlineCapability: initResult.offlineCapability,
      knownTestFramePath: knownFramePath,
      beforePreviewPath,
      items: itemReports,
    };

    const { jsonPath, markdownPath } = writeLibraryReports(outDir, options.kind, reportPayload);
    if (options.kind === 'transitions') {
      const docPath = resolve(REPO_ROOT, 'docs/qa/v1.1.1/TRANSITIONS.md');
      const md = buildTransitionsMarkdownReport(reportPayload);
      writeFileSync(docPath, md, 'utf8');
      console.log(`Documented report written: ${docPath}`);
    }
    const failed = itemReports.filter((item) => !item.passed);
    console.log('');
    console.log(
      `Library test run finished: ${itemReports.length - failed.length}/${itemReports.length} passed.`,
    );
    console.log(`Markdown report: ${markdownPath}`);
    console.log(`JSON report:     ${jsonPath}`);

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
