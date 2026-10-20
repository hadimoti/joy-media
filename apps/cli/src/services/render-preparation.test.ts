import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { compileCaptionAss } from './captions-ass.js';
import { findChromiumExecutable, loadNotoSansArabicFaces } from '@joy-media/html-scene-runtime';
import {
  freezeRenderPreparation,
  readRenderPreparationFacts,
  readRenderPreparation,
  setRenderPreparationFactsProviderForTests,
  setRenderPreparationCommandRunnerForTests,
  setRenderPreparationChromiumProbeForTests,
  renderInputsDigest,
  validateRenderPreparation,
  projectHasTitles,
  resolveExecutable,
  setRenderPreparationSpawnForTests,
  type RenderPreparationFacts,
} from './render-preparation.js';
import type { CliProjectDocument } from '../utils/project-loader.js';

function failureCode(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected preparation to fail.');
}

const facts: RenderPreparationFacts = {
  libassProbe: {
    usable: true,
    executablePath: 'ffmpeg',
    canonicalFace: 'Noto Sans Arabic Arabic 400',
    log: '',
    libassVersion: '0.17',
    shaperVersion: '10.0',
    versionSource: 'canonical-caption-face-ass-probe',
  },
  libassAvailable: true,
  canonicalFaces: loadNotoSansArabicFaces(),
  chromium: {
    launchable: true,
    executablePath: 'chromium',
    executableSha256: `sha256:${'c'.repeat(64)}`,
    version: 'Chromium 140.0',
  },
  ffmpeg: {
    executablePath: 'ffmpeg',
    executableSha256: `sha256:${'f'.repeat(64)}`,
    version: 'ffmpeg version 7',
    buildConfiguration: '--enable-libass',
    requiredFilters: ['ass', 'subtitles'],
    libassVersion: '0.17',
    shaperVersion: 'harfbuzz 10',
    versionSource: 'canonical-caption-face-ass-probe',
  },
};

const project = {
  id: 'project',
  pluginData: {
    'joy.contentTemplates': {
      version: 1,
      instances: {
        title: { clipId: 'title-clip', lines: { primary: 'Sara' }, font: { weight: 700 } },
      },
    },
  },
  rootCompositionId: 'root',
  assets: { 'asset-title': { id: 'asset-title', kind: 'video', displayName: 'title.mp4' } },
  compositions: {
    root: {
      id: 'root',
      width: 1920,
      height: 1080,
      frameRate: { num: 30000, den: 1001 },
      tracks: [
        {
          id: 'title-track',
          name: 'Title',
          order: 0,
          kind: 'video',
          family: 'visual',
          enabled: true,
          clips: [
            {
              id: 'title-clip',
              kind: 'video',
              assetId: 'asset-title',
              startUs: 0,
              durationUs: 1_000_000,
            },
          ],
        },
      ],
    },
  },
} as unknown as CliProjectDocument;

describe('RenderPreparationV1', () => {
  it('kills an aborted executable lookup and rejects when the child never closes', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: null;
      stderr: null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = null;
    child.stderr = null;
    child.kill = vi.fn(() => true);
    setRenderPreparationSpawnForTests(() => child as never);
    const controller = new AbortController();
    let resolved = false;
    const lookup = resolveExecutable('fake-ffmpeg', controller.signal).then((value) => {
      resolved = true;
      return value;
    });
    const rejection = expect(lookup).rejects.toThrow('failed to terminate');

    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(resolved).toBe(false);
    setRenderPreparationSpawnForTests(undefined);
    vi.useRealTimers();
  });

  it('activates title preparation from deck enablement instead of the raw track flag', () => {
    const active = {
      ...project,
      compositions: {
        root: {
          ...project.compositions.root,
          id: 'root',
          tracks: [
            {
              id: 'title-track',
              name: 'Title',
              order: 0,
              kind: 'video',
              family: 'visual',
              enabled: false,
              clips: [
                {
                  id: 'title-clip',
                  kind: 'video',
                  assetId: 'asset-title',
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
      assets: { 'asset-title': { id: 'asset-title', kind: 'video', displayName: 'title.mp4' } },
      timelineTrackDeck: {
        rows: [
          { compositionId: 'root', trackId: 'title-track', order: 0, enabled: true, locked: false },
        ],
      },
      pluginData: {
        ...project.pluginData,
        'joy.contentTemplates': {
          instances: { title: { clipId: 'title-clip', lines: { primary: 'Sara' } } },
        },
      },
    } as unknown as CliProjectDocument;
    expect(projectHasTitles(active)).toBe(true);

    const inactive = {
      ...active,
      timelineTrackDeck: {
        rows: [
          {
            compositionId: 'root',
            trackId: 'title-track',
            order: 0,
            enabled: false,
            locked: false,
          },
        ],
      },
    } as unknown as CliProjectDocument;
    expect(projectHasTitles(inactive)).toBe(false);
  });

  it('does not return a bare executable name when PATH lookup finds nothing', async () => {
    await expect(resolveExecutable('joy-media-missing-ffmpeg-test-binary')).rejects.toMatchObject({
      code: 'SETUP_REQUIRED',
    });
  });

  it('validates with the frozen Chromium path when discovery would select another executable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-chromium-pin-'));
    const executableA = join(directory, 'chrome-a.exe');
    const executableB = join(directory, 'chrome-b.exe');
    writeFileSync(executableA, 'chrome A');
    writeFileSync(executableB, 'chrome B');
    const frozenFacts: RenderPreparationFacts = {
      ...facts,
      chromium: {
        launchable: true,
        executablePath: executableA,
        executableSha256: `sha256:${createHash('sha256').update('chrome A').digest('hex')}`,
        version: 'Chromium 151.0',
      },
    };
    const preparation = freezeRenderPreparation(
      project,
      [{ op: 'instantiateTemplate' }],
      frozenFacts,
    );
    const saved = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    let requestedPath: string | undefined;
    const previousChromiumPath = process.env['JOY_CHROMIUM_PATH'];
    process.env['JOY_CHROMIUM_PATH'] = executableB;
    setRenderPreparationFactsProviderForTests(async (options) => {
      requestedPath = options.chromiumExecutablePath;
      return {
        ...frozenFacts,
        chromium: {
          ...frozenFacts.chromium,
          executablePath: options.chromiumExecutablePath ?? null,
        },
      };
    });
    try {
      await expect(validateRenderPreparation(saved)).resolves.toEqual(preparation);
      expect(requestedPath).toBe(executableA);
      expect(process.env['JOY_CHROMIUM_PATH']).toBe(executableB);
    } finally {
      setRenderPreparationFactsProviderForTests(undefined);
      if (previousChromiumPath === undefined) delete process.env['JOY_CHROMIUM_PATH'];
      else process.env['JOY_CHROMIUM_PATH'] = previousChromiumPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects when the executable at the frozen Chromium path changes bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-chromium-drift-'));
    const executableA = join(directory, 'chrome-a.exe');
    writeFileSync(executableA, 'chrome A');
    const frozenFacts: RenderPreparationFacts = {
      ...facts,
      chromium: {
        launchable: true,
        executablePath: executableA,
        executableSha256: `sha256:${createHash('sha256').update('chrome A').digest('hex')}`,
        version: 'Chromium 151.0',
      },
    };
    const preparation = freezeRenderPreparation(
      project,
      [{ op: 'instantiateTemplate' }],
      frozenFacts,
    );
    const saved = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    writeFileSync(executableA, 'changed bytes');
    setRenderPreparationFactsProviderForTests(async (options) => ({
      ...frozenFacts,
      chromium: {
        ...frozenFacts.chromium,
        executablePath: options.chromiumExecutablePath ?? null,
        executableSha256: `sha256:${createHash('sha256').update(readFileSync(executableA)).digest('hex')}`,
      },
    }));
    try {
      await expect(validateRenderPreparation(saved)).rejects.toMatchObject({
        code: 'RENDER_ENVIRONMENT_DRIFT',
      });
    } finally {
      setRenderPreparationFactsProviderForTests(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('detects changed media bytes as render environment drift', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-media-drift-'));
    const mediaPath = join(directory, 'source.mp4');
    writeFileSync(mediaPath, 'original media bytes');
    const mediaProject = {
      ...project,
      assets: { [mediaPath]: { id: mediaPath, kind: 'video' } },
      pluginData: {
        ...project.pluginData,
        'joy.contentTemplates': {
          instances: {
            title: { clipId: 'clip', lines: { primary: 'Sara' }, font: { weight: 700 } },
          },
        },
      },
      compositions: {
        root: {
          ...project.compositions.root,
          id: 'root',
          tracks: [
            {
              id: 'video',
              kind: 'video',
              enabled: true,
              clips: [
                {
                  id: 'clip',
                  kind: 'video',
                  assetId: mediaPath,
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
    } as unknown as CliProjectDocument;
    const preparation = freezeRenderPreparation(
      mediaProject,
      [{ op: 'instantiateTemplate' }],
      facts,
    );
    const saved = {
      ...mediaProject,
      pluginData: { ...mediaProject.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    writeFileSync(mediaPath, 'changed media bytes');
    try {
      await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
        code: 'RENDER_ENVIRONMENT_DRIFT',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('includes renderer-resolved --media-dir bytes in the preparation digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-media-dir-digest-'));
    const mediaPath = join(directory, 'clip.mp4');
    writeFileSync(mediaPath, 'original bytes');
    const mediaProject = {
      ...project,
      assets: { media: { id: 'media', kind: 'video', displayName: 'clip.mp4' } },
      compositions: {
        root: {
          ...project.compositions.root,
          tracks: [
            {
              id: 'video',
              kind: 'video',
              enabled: true,
              clips: [
                { id: 'clip', kind: 'video', assetId: 'media', startUs: 0, durationUs: 1_000_000 },
              ],
            },
          ],
        },
      },
    } as unknown as CliProjectDocument;
    try {
      const before = renderInputsDigest(mediaProject, directory);
      writeFileSync(mediaPath, 'changed bytes');
      expect(renderInputsDigest(mediaProject, directory)).not.toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('includes renderer-resolved path references without asset registry entries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-path-digest-'));
    const mediaPath = join(directory, 'unregistered.mp4');
    writeFileSync(mediaPath, 'first bytes');
    const mediaProject = {
      ...project,
      assets: {},
      pluginData: {
        ...project.pluginData,
        'joy.contentTemplates': {
          instances: {
            title: { clipId: 'clip', lines: { primary: 'Sara' }, font: { weight: 700 } },
          },
        },
      },
      compositions: {
        root: {
          ...project.compositions.root,
          tracks: [
            {
              id: 'video',
              name: 'Video',
              order: 0,
              kind: 'video',
              family: 'visual',
              enabled: true,
              clips: [
                {
                  id: 'clip',
                  kind: 'video',
                  assetId: 'unregistered.mp4',
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
    } as unknown as CliProjectDocument;
    try {
      const before = renderInputsDigest(mediaProject, directory);
      writeFileSync(mediaPath, 'changed bytes');
      expect(renderInputsDigest(mediaProject, directory)).not.toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('freezes and validates the same --media-dir input inventory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-prepared-media-dir-'));
    const mediaPath = join(directory, 'unregistered.mp4');
    writeFileSync(mediaPath, 'media bytes');
    const mediaProject = {
      ...project,
      assets: {},
      pluginData: {
        ...project.pluginData,
        'joy.contentTemplates': {
          instances: {
            title: { clipId: 'clip', lines: { primary: 'Sara' }, font: { weight: 700 } },
          },
        },
      },
      compositions: {
        root: {
          ...project.compositions.root,
          id: 'root',
          tracks: [
            {
              id: 'video',
              name: 'Video',
              order: 0,
              kind: 'video',
              family: 'visual',
              enabled: true,
              clips: [
                {
                  id: 'clip',
                  kind: 'video',
                  assetId: 'unregistered.mp4',
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
    } as unknown as CliProjectDocument;
    try {
      const preparation = freezeRenderPreparation(mediaProject, [], facts, directory);
      const saved = {
        ...mediaProject,
        pluginData: { ...mediaProject.pluginData, 'joy.renderPreparation': preparation },
      } as unknown as CliProjectDocument;
      await expect(validateRenderPreparation(saved, facts, undefined, directory)).resolves.toEqual(
        preparation,
      );
      await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
        code: 'RENDER_ENVIRONMENT_DRIFT',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a frozen title record without its Chromium executable path', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const { executablePath: _executablePath, ...chromiumWithoutPath } = preparation.chromium;
    const saved = {
      ...project,
      pluginData: {
        ...project.pluginData,
        'joy.renderPreparation': { ...preparation, chromium: chromiumWithoutPath },
      },
    } as unknown as CliProjectDocument;
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses unknown fields in a frozen preparation record', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = {
      ...project,
      pluginData: {
        ...project.pluginData,
        'joy.renderPreparation': { ...preparation, unexpected: true },
      },
    } as unknown as CliProjectDocument;

    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses a preparation record with a missing canonical face', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = {
      ...project,
      pluginData: {
        ...project.pluginData,
        'joy.renderPreparation': { ...preparation, fonts: preparation.fonts.slice(1) },
      },
    } as unknown as CliProjectDocument;

    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses changed bytes in an unselected canonical face', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    const selected = new Set(['Noto Sans Arabic:700:latin']);
    const unselectedIndex = facts.canonicalFaces.findIndex(
      (face) => !selected.has(`${face.family}:${face.weight}:${face.subset}`),
    );
    expect(unselectedIndex).toBeGreaterThanOrEqual(0);
    const directory = mkdtempSync(join(tmpdir(), 'joy-canonical-font-bytes-'));
    const fontPaths = facts.canonicalFaces.map((face, index) => {
      const path = join(directory, `${index}.woff2`);
      writeFileSync(path, face.bytes);
      return path;
    });
    try {
      const changedPath = fontPaths[unselectedIndex]!;
      const changedBytes = readFileSync(changedPath);
      changedBytes[0] = changedBytes[0]! ^ 0xff;
      writeFileSync(changedPath, changedBytes);
      setRenderPreparationFactsProviderForTests(async () => ({
        ...facts,
        canonicalFaces: facts.canonicalFaces.map((face, index) => {
          const bytes = readFileSync(fontPaths[index]!);
          return {
            ...face,
            bytes,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          };
        }),
      }));

      await expect(validateRenderPreparation(saved)).rejects.toMatchObject({
        code: 'RENDER_ENVIRONMENT_DRIFT',
      });
    } finally {
      setRenderPreparationFactsProviderForTests(undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('excludes a title on a track disabled by the normalized timeline deck', () => {
    const deckProject = {
      ...project,
      schemaVersion: 1,
      compositions: {
        root: {
          ...project.compositions.root,
          tracks: [
            {
              id: 'titles',
              kind: 'video',
              enabled: true,
              clips: [{ id: 'title-clip', kind: 'video', durationUs: 1_000_000 }],
            },
          ],
        },
      },
      timelineTrackDeck: {
        rows: [
          {
            compositionId: 'root',
            trackId: 'titles',
            order: 0,
            enabled: false,
            locked: false,
          },
        ],
      },
      pluginData: {
        ...project.pluginData,
        'joy.contentTemplates': {
          version: 1,
          instances: {
            title: { clipId: 'title-clip', lines: { primary: 'Sara' }, font: { weight: 700 } },
          },
        },
      },
    } as unknown as CliProjectDocument;

    expect(projectHasTitles(deckProject)).toBe(false);
  });

  it('uses the explicitly selected Chromium executable when probing at runtime', async () => {
    const priorExecutable = process.env['JOY_CHROMIUM_PATH'];
    process.env['JOY_CHROMIUM_PATH'] = join(tmpdir(), 'missing-explicit-joy-chromium.exe');
    try {
      const currentFacts = await readRenderPreparationFacts({ title: true, captions: false });
      expect(currentFacts.chromium.launchable).toBe(false);
    } finally {
      if (priorExecutable === undefined) delete process.env['JOY_CHROMIUM_PATH'];
      else process.env['JOY_CHROMIUM_PATH'] = priorExecutable;
    }
  });

  it('validates a title record against unchanged production probe facts', async () => {
    const environmentKeys = [
      'JOY_CHROMIUM_PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'LOCALAPPDATA',
    ] as const;
    const previousEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]] as const),
    );
    const chromiumExecutablePath = findChromiumExecutable();
    try {
      expect(chromiumExecutablePath).toBeDefined();
      process.env['JOY_CHROMIUM_PATH'] = chromiumExecutablePath;
      const frozenFacts = await readRenderPreparationFacts({
        title: true,
        captions: false,
        ...(chromiumExecutablePath ? { chromiumExecutablePath } : {}),
      });
      const preparation = freezeRenderPreparation(
        project,
        [{ op: 'instantiateTemplate' }],
        frozenFacts,
      );
      const preparedProject = {
        ...project,
        pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
      } as unknown as CliProjectDocument;
      const currentFacts = await readRenderPreparationFacts({
        title: true,
        captions: false,
        ...(chromiumExecutablePath ? { chromiumExecutablePath } : {}),
      });

      expect(currentFacts.chromium).toMatchObject({
        launchable: frozenFacts.chromium.launchable,
        executableSha256: frozenFacts.chromium.executableSha256,
        version: frozenFacts.chromium.version,
      });
      await expect(validateRenderPreparation(preparedProject, currentFacts)).resolves.toEqual(
        preparation,
      );
    } finally {
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a title record when the Chromium executable hash changes', async () => {
    const frozenFacts = await readRenderPreparationFacts({ title: true, captions: false });
    const preparation = freezeRenderPreparation(
      project,
      [{ op: 'instantiateTemplate' }],
      frozenFacts,
    );
    const preparedProject = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    const changedFacts: RenderPreparationFacts = {
      ...frozenFacts,
      chromium: {
        ...frozenFacts.chromium,
        executableSha256: 'sha256:changed-executable',
      },
    };

    await expect(validateRenderPreparation(preparedProject, changedFacts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
  });

  it('observes cancellation during asynchronous FFmpeg validation within 100 ms', async () => {
    // An existing absolute path skips the PATH lookup, which is a separate process with its own
    // 5 s limit. The probes themselves are the fake runner below, so nothing here executes it.
    const fakeFfmpeg = join(tmpdir(), `joy-fake-ffmpeg-${process.pid}-${Date.now()}`);
    writeFileSync(fakeFfmpeg, 'not executed: the command runner is faked');
    const priorFfmpeg = process.env['JOY_MEDIA_FFMPEG'];
    process.env['JOY_MEDIA_FFMPEG'] = fakeFfmpeg;
    let started = false;
    setRenderPreparationCommandRunnerForTests((_binary, _args, { signal }) => {
      started = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('probe aborted')), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    try {
      const validating = readRenderPreparationFacts({
        title: false,
        captions: false,
        signal: controller.signal,
      });
      // Only the probe's start is awaited here; the 100 ms bound below applies to cancellation.
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 30_000 });
      const startedAt = performance.now();
      controller.abort();
      await expect(validating).rejects.toThrow('aborted');
      expect(performance.now() - startedAt).toBeLessThan(100);
    } finally {
      setRenderPreparationCommandRunnerForTests(undefined);
      if (priorFfmpeg === undefined) delete process.env['JOY_MEDIA_FFMPEG'];
      else process.env['JOY_MEDIA_FFMPEG'] = priorFfmpeg;
      rmSync(fakeFfmpeg, { force: true });
    }
  });

  it('freezes renderer, font, coverage, composition, and input digests', () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    expect(preparation).toMatchObject({
      version: 'RenderPreparationV1',
      renderers: { title: 'chromium-scene-surface', caption: 'none' },
      composition: { width: 1920, height: 1080, fps: { num: 30000, den: 1001 } },
      coverage: { result: 'passed', checkedTextLength: 4 },
      fonts: expect.arrayContaining([
        {
          family: 'Noto Sans Arabic',
          weight: 700,
          subset: 'latin',
          length: expect.any(Number),
          sha256: expect.any(String),
        },
      ]),
    });
    expect(preparation.fonts[0]?.length).toBeGreaterThan(0);
    expect(preparation.fonts[0]?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preparation.fonts).toHaveLength(facts.canonicalFaces.length);
    expect(preparation.renderInputsDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const saved = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    };
    expect(readRenderPreparation(saved)).toEqual(preparation);
  });

  it('reports missing, malformed, and changed environment records with distinct codes', async () => {
    await expect(validateRenderPreparation(project)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_REQUIRED',
    });
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const preparedProject = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    const drifted = { ...preparedProject, title: 'changed' } as CliProjectDocument;
    await expect(validateRenderPreparation(drifted, facts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
    const malformed = {
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': {} },
    };
    await expect(
      validateRenderPreparation(malformed as unknown as CliProjectDocument, facts),
    ).rejects.toMatchObject({ code: 'RENDER_PREPARATION_INVALID' });
  });

  it('reports missing canonical faces and uncovered glyphs precisely', () => {
    expect(
      failureCode(() =>
        freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], {
          ...facts,
          canonicalFaces: [],
        }),
      ),
    ).toMatchObject({ code: 'FONT_UNAVAILABLE' });
    const emojiProject = structuredClone(project) as any;
    emojiProject.pluginData['joy.contentTemplates'].instances.title.lines.primary = '🚀';
    expect(
      failureCode(() =>
        freezeRenderPreparation(emojiProject, [{ op: 'instantiateTemplate' }], facts),
      ),
    ).toMatchObject({ code: 'FONT_UNSUPPORTED_GLYPH' });
  });

  it('freezes measured caption widths, hard breaks, and the ASS digest', async () => {
    const captionProject = {
      ...project,
      compositions: {
        root: {
          ...project.compositions.root,
          tracks: [
            {
              id: 'captions',
              enabled: true,
              clips: [
                {
                  id: 'caption-clip',
                  kind: 'caption',
                  captionDocumentId: 'caption-doc',
                  startUs: 0,
                  durationUs: 1_000_000,
                },
              ],
            },
          ],
        },
      },
      captionDocuments: {
        'caption-doc': {
          direction: 'ltr',
          words: {},
          segments: [{ startUs: 0, endUs: 1_000_000, textOverride: 'Hello world' }],
        },
      },
    } as unknown as CliProjectDocument;
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    expect(preparation.captions.cues[0]).toMatchObject({
      lines: ['Hello world'],
      measuredWidthsPx: [180],
    });
    expect(preparation.captions.assDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const saved = {
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    setRenderPreparationFactsProviderForTests(async () => ({ ...facts }));
    try {
      await expect(validateRenderPreparation(saved)).resolves.toEqual(preparation);
    } finally {
      setRenderPreparationFactsProviderForTests(undefined);
    }
  });

  it('prepares and validates a caption hard break that creates a measured blank line', async () => {
    const captionProject = makeCaptionProject();
    (captionProject.captionDocuments as any)['caption-doc'].segments[0].textOverride =
      'Hello\n\nworld';
    const measuredFacts = {
      ...facts,
      measureText: (text: string, size: number) => text.length * size,
    };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    expect(preparation.captions.cues[0]).toMatchObject({
      lines: ['Hello', '', 'world'],
      measuredWidthsPx: [300, 0, 300],
    });
    const saved = {
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    } as unknown as CliProjectDocument;
    setRenderPreparationFactsProviderForTests(async () => ({ ...measuredFacts }));
    try {
      await expect(validateRenderPreparation(saved)).resolves.toEqual(preparation);
    } finally {
      setRenderPreparationFactsProviderForTests(undefined);
    }
  });

  it('refuses frozen caption widths that overflow their recorded available width', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const saved = structuredClone({
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    const record = saved.pluginData['joy.renderPreparation'] as any;
    record.captions.cues[0].measuredWidthsPx[0] = record.captions.cues[0].maxWidthPx + 1;
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses missing or changed frozen caption measurement widths', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const makeSaved = () =>
      structuredClone({
        ...captionProject,
        pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
      }) as unknown as CliProjectDocument;
    const missingWidth = makeSaved();
    delete (missingWidth.pluginData['joy.renderPreparation'] as any).captions.cues[0]
      .measuredWidthsPx;
    await expect(validateRenderPreparation(missingWidth, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });

    const changedWidth = makeSaved();
    (
      changedWidth.pluginData['joy.renderPreparation'] as any
    ).captions.cues[0].measuredWidthsPx[0] += 1;
    await expect(validateRenderPreparation(changedWidth, facts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
  });

  it('refuses a changed Chromium file before invoking its probe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-chromium-before-probe-'));
    const executablePath = join(directory, 'chrome.exe');
    const ffmpegPath = join(directory, 'ffmpeg.exe');
    const previousFFmpegPath = process.env['JOY_MEDIA_FFMPEG'];
    writeFileSync(executablePath, 'changed chromium');
    writeFileSync(ffmpegPath, 'stable ffmpeg fixture');
    process.env['JOY_MEDIA_FFMPEG'] = ffmpegPath;
    let probes = 0;
    setRenderPreparationCommandRunnerForTests(async () => ({ status: 0, output: '' }));
    setRenderPreparationChromiumProbeForTests(async () => {
      probes += 1;
      return { version: 'Chromium should not run' };
    });
    try {
      await expect(
        readRenderPreparationFacts({
          title: true,
          captions: false,
          chromiumExecutablePath: executablePath,
          expectedChromiumSha256: 'sha256:recorded-chromium',
        }),
      ).rejects.toMatchObject({
        code: 'RENDER_ENVIRONMENT_DRIFT',
        message: expect.stringMatching(/chromium/i),
      });
      expect(probes).toBe(0);
    } finally {
      setRenderPreparationCommandRunnerForTests(undefined);
      setRenderPreparationChromiumProbeForTests(undefined);
      if (previousFFmpegPath === undefined) delete process.env['JOY_MEDIA_FFMPEG'];
      else process.env['JOY_MEDIA_FFMPEG'] = previousFFmpegPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a changed FFmpeg file before invoking any FFmpeg probe', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-ffmpeg-before-probe-'));
    const executablePath = join(directory, 'ffmpeg.exe');
    const previousFFmpegPath = process.env['JOY_MEDIA_FFMPEG'];
    writeFileSync(executablePath, 'changed ffmpeg');
    process.env['JOY_MEDIA_FFMPEG'] = executablePath;
    let probes = 0;
    setRenderPreparationCommandRunnerForTests(async () => {
      probes += 1;
      return { status: 0, output: '' };
    });
    try {
      await expect(
        readRenderPreparationFacts({
          title: false,
          captions: true,
          expectedFFmpegSha256: 'sha256:recorded-ffmpeg',
        }),
      ).rejects.toMatchObject({ code: 'RENDER_ENVIRONMENT_DRIFT' });
      expect(probes).toBe(0);
    } finally {
      setRenderPreparationCommandRunnerForTests(undefined);
      if (previousFFmpegPath === undefined) delete process.env['JOY_MEDIA_FFMPEG'];
      else process.env['JOY_MEDIA_FFMPEG'] = previousFFmpegPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records libass and HarfBuzz versions from the canonical ASS probe output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-render-ass-versions-'));
    const executablePath = join(directory, 'ffmpeg.exe');
    const previousFFmpegPath = process.env['JOY_MEDIA_FFMPEG'];
    writeFileSync(executablePath, 'fake ffmpeg');
    process.env['JOY_MEDIA_FFMPEG'] = executablePath;
    setRenderPreparationCommandRunnerForTests(async (_binary, args) => {
      if (args.includes('-buildconf'))
        return { status: 0, output: 'libass 99.0 HarfBuzz 99.0 --enable-libass' };
      if (args.includes('-filters')) return { status: 0, output: 'ass subtitles' };
      if (args.includes('-version')) return { status: 0, output: 'ffmpeg version fake' };
      return {
        status: 0,
        output:
          'libass source: 0.17.2\nUsing HarfBuzz 9.1.0\nfontselect: (Noto Sans Arabic) -> Noto Sans Arabic,\n',
      };
    });
    try {
      const current = await readRenderPreparationFacts({ title: false, captions: true });
      expect(current.ffmpeg).toMatchObject({
        libassVersion: '0.17.2',
        shaperVersion: '9.1.0',
        versionSource: 'canonical-caption-face-ass-probe',
      });
    } finally {
      setRenderPreparationCommandRunnerForTests(undefined);
      if (previousFFmpegPath === undefined) delete process.env['JOY_MEDIA_FFMPEG'];
      else process.env['JOY_MEDIA_FFMPEG'] = previousFFmpegPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses an older policy version as environment drift', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = structuredClone({
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    (saved.pluginData['joy.renderPreparation'] as any).versions.renderer = '0';
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_ENVIRONMENT_DRIFT',
    });
  });

  it('refuses an unavailable libass version in a caption record', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const saved = structuredClone({
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    (saved.pluginData['joy.renderPreparation'] as any).ffmpeg.libassVersion = 'unavailable';
    await expect(validateRenderPreparation(saved, measuredFacts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses a changed frozen cue even when its ASS digest is recomputed', async () => {
    const captionProject = makeCaptionProject();
    const measuredFacts = { ...facts, measureText: (_text: string, size: number) => size * 3 };
    const preparation = freezeRenderPreparation(
      captionProject,
      [{ op: 'addCaption' }],
      measuredFacts,
    );
    const saved = structuredClone({
      ...captionProject,
      pluginData: { ...captionProject.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    const record = saved.pluginData['joy.renderPreparation'] as any;
    record.captions.cues[0].lines[0] = 'Tampered cue';
    const ass = compileCaptionAss({
      width: 1920,
      height: 1080,
      fontFamily: 'Noto Sans Arabic',
      frameRate: { num: 30000, den: 1001 },
      fontSizePx: record.captions.fontSizePx,
      marginBottomPx: record.captions.placement.marginBottomPx,
      cues: record.captions.cues.map((cue: any) => ({ text: cue.lines.join('\n'), ...cue })),
    });
    record.captions.assDigest = `sha256:${createHash('sha256').update(Buffer.from(ass)).digest('hex')}`;
    await expect(validateRenderPreparation(saved, measuredFacts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });

  it('refuses selected font weights that disagree with frozen title instances', async () => {
    const preparation = freezeRenderPreparation(project, [{ op: 'instantiateTemplate' }], facts);
    const saved = structuredClone({
      ...project,
      pluginData: { ...project.pluginData, 'joy.renderPreparation': preparation },
    }) as unknown as CliProjectDocument;
    const selected = (saved.pluginData['joy.renderPreparation'] as any).fonts.find(
      (face: { subset: string; weight: number }) => face.subset === 'latin' && face.weight === 700,
    );
    selected.weight = 400;
    await expect(validateRenderPreparation(saved, facts)).rejects.toMatchObject({
      code: 'RENDER_PREPARATION_INVALID',
    });
  });
});

function makeCaptionProject(): CliProjectDocument {
  return {
    ...project,
    compositions: {
      root: {
        ...project.compositions.root,
        tracks: [
          {
            id: 'captions',
            enabled: true,
            clips: [
              {
                id: 'caption-clip',
                kind: 'caption',
                captionDocumentId: 'caption-doc',
                startUs: 0,
                durationUs: 1_000_000,
              },
            ],
          },
        ],
      },
    },
    captionDocuments: {
      'caption-doc': {
        direction: 'ltr',
        words: {},
        segments: [{ startUs: 0, endUs: 1_000_000, textOverride: 'Hello world' }],
      },
    },
  } as unknown as CliProjectDocument;
}
