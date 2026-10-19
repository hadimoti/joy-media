import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ROOT, createSandbox, describeRun, type Sandbox } from './harness.js';
import { spawnCli } from './cli-helpers.js';
import { expectNdjsonContract, projectDoc, writeSandboxFile } from './render-helpers.js';

const hasFfmpeg = (): boolean =>
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const canDenyDirectoryWrites = process.platform !== 'win32' && process.getuid?.() !== 0;
const canCompileEnospcInjector =
  process.platform === 'linux' && spawnSync('cc', ['--version']).status === 0;

function absentProcessId(): number {
  for (let candidate = 2_147_483_647; candidate > 2_147_000_000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('could not find an absent process id for the stale-lock fixture');
}

describe.skipIf(!hasFfmpeg())('real render output recovery', () => {
  let sandbox: Sandbox | undefined;
  const hardCut = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-hard-cut.mkv',
  );
  const silent = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-silent.mp4',
  );

  beforeAll(() => {
    sandbox = createSandbox('render-recovery');
  });
  afterAll(() => sandbox?.cleanup());

  it('recovers a lock left by an exited render process', async () => {
    if (!sandbox) throw new Error('render recovery sandbox was not created');
    const project = writeSandboxFile(
      sandbox,
      'stale-lock.json',
      projectDoc({
        id: 'stale-output',
        title: 'Recover stale lock',
        durationUs: 1_000_000,
        tracks: [
          { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
        ],
      }),
    );
    const outDir = sandbox.path('stale-output');
    mkdirSync(outDir, { recursive: true });
    const lockPath = join(outDir, '.stale-output.mp4.render.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: absentProcessId(), startedAt: '2026-10-17T00:00:00.000Z' }),
      'utf8',
    );

    const result = await sandbox.run(['render', '--project', project, '--out', outDir, '--json']);

    expect(result.code, describeRun(result)).toBe(0);
    expect(expectNdjsonContract(result, ['complete']).at(-1)).toMatchObject({
      type: 'complete',
      mediaProduced: true,
    });
    expect(readFileSync(sandbox.path('stale-output', 'stale-output.mp4')).length).toBeGreaterThan(
      0,
    );
    expect(existsSync(lockPath)).toBe(false);
  }, 120_000);

  it.skipIf(process.platform !== 'win32')(
    'taskkill stops a Windows render tree without losing the last good pair and a fresh render recovers',
    async () => {
      if (!sandbox) throw new Error('render recovery sandbox was not created');
      const outDir = sandbox.path('windows-kill-output');
      mkdirSync(outDir, { recursive: true });
      const projectId = 'windows-kill-recovery';
      const goodProject = writeSandboxFile(
        sandbox,
        'windows-good.json',
        projectDoc({
          id: projectId,
          title: 'Last good render',
          durationUs: 1_000_000,
          tracks: [
            { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
          ],
        }),
      );
      const longMedia = sandbox.path('media', 'long.mp4');
      mkdirSync(sandbox.path('media'), { recursive: true });
      const generated = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=s=1280x720:r=30:d=30',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          longMedia,
        ],
        { encoding: 'utf8', timeout: 120_000, windowsHide: true },
      );
      expect(generated.status, generated.stderr).toBe(0);

      const goodRender = await sandbox.run([
        'render',
        '--project',
        goodProject,
        '--out',
        outDir,
        '--json',
      ]);
      expect(goodRender.code, describeRun(goodRender)).toBe(0);
      const mediaPath = join(outDir, `${projectId}.mp4`);
      const manifestPath = `${mediaPath}.manifest.json`;
      const lastGoodMedia = readFileSync(mediaPath);
      const lastGoodManifest = readFileSync(manifestPath);
      const longProject = writeSandboxFile(
        sandbox,
        'windows-long.json',
        projectDoc({
          id: projectId,
          title: 'Interrupted long render',
          durationUs: 30_000_000,
          tracks: [
            { id: 'video-1', clips: [{ id: 'long', assetId: longMedia, durationUs: 30_000_000 }] },
          ],
        }),
      );

      let foundPartial = false;
      let killError: Error | undefined;
      const killedRender = await spawnCli(
        sandbox,
        ['render', '--project', longProject, '--out', outDir, '--json'],
        {
          timeoutMs: 120_000,
          onSpawn: (child) => {
            void (async () => {
              const deadline = Date.now() + 30_000;
              while (Date.now() < deadline) {
                foundPartial = readdirSync(outDir).some((entry) => entry.endsWith('.partial'));
                if (foundPartial) break;
                await new Promise((resolveWait) => setTimeout(resolveWait, 10));
              }
              if (!foundPartial || child.pid === undefined) {
                throw new Error('Windows render did not expose a staged output before exit.');
              }
              execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 15_000,
              });
            })().catch((error: unknown) => {
              killError = error instanceof Error ? error : new Error(String(error));
            });
          },
        },
      );
      expect(killError).toBeUndefined();
      expect(foundPartial).toBe(true);
      expect(killedRender.code).not.toBe(0);
      expect(readFileSync(mediaPath)).toEqual(lastGoodMedia);
      expect(readFileSync(manifestPath)).toEqual(lastGoodManifest);

      const recovered = await sandbox.run([
        'render',
        '--project',
        longProject,
        '--out',
        outDir,
        '--json',
      ]);
      expect(recovered.code, describeRun(recovered)).toBe(0);
      expect(expectNdjsonContract(recovered, ['complete']).at(-1)).toMatchObject({
        type: 'complete',
        mediaProduced: true,
      });
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        projectTitle: 'Interrupted long render',
      });
      expect(readdirSync(outDir).some((entry) => entry.endsWith('.partial'))).toBe(false);
      expect(existsSync(join(outDir, `.${projectId}.mp4.render.lock`))).toBe(false);
    },
    240_000,
  );

  it('restores the last good pair when a process exits between media and manifest promotion', async () => {
    if (!sandbox) throw new Error('render recovery sandbox was not created');
    const project = writeSandboxFile(
      sandbox,
      'interrupted-pair.json',
      projectDoc({
        id: 'interrupted-pair',
        title: 'Interrupted pair recovery',
        durationUs: 1_000_000,
        tracks: [
          { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
        ],
      }),
    );
    const outDir = sandbox.path('interrupted-pair');
    mkdirSync(outDir, { recursive: true });
    const mediaPath = join(outDir, 'interrupted-pair.mp4');
    const manifestPath = `${mediaPath}.manifest.json`;
    const stagedMediaPath = join(outDir, '.interrupted-pair.mp4.234.abc12345.partial');
    const stagedManifestPath = join(outDir, '.interrupted-pair.mp4.manifest.json.234.abc12345.tmp');
    const mediaBackup = join(outDir, '.interrupted-pair.mp4.234.abc12345.backup');
    const manifestBackup = join(outDir, '.interrupted-pair.mp4.manifest.json.234.abc12345.backup');
    const lockPath = join(outDir, '.interrupted-pair.mp4.render.lock');
    const oldMedia = Buffer.from('previous-good-media');
    const oldManifest = Buffer.from('{"mediaProduced":true,"revision":"previous"}\n');
    writeFileSync(mediaPath, Buffer.from('new-media-without-manifest'));
    writeFileSync(mediaBackup, oldMedia);
    writeFileSync(manifestBackup, oldManifest);
    writeFileSync(stagedManifestPath, '{"mediaProduced":true,"revision":"new"}\n');
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: absentProcessId(),
        startedAt: '2026-10-17T00:00:00.000Z',
        transaction: {
          phase: 'committing',
          mediaPath,
          stagedMediaPath,
          mediaBackup,
          hadMedia: true,
          manifestPath,
          stagedManifestPath,
          manifestBackup,
          hadManifest: true,
        },
      }),
      'utf8',
    );

    const result = await sandbox.run(['render', '--project', project, '--out', outDir, '--json'], {
      env: { JOY_MEDIA_FFMPEG: 'missing-ffmpeg-after-recovery' },
    });

    expect(result.code, describeRun(result)).toBe(1);
    expect(expectNdjsonContract(result, ['error']).at(-1)).toMatchObject({
      type: 'error',
      code: 'ffmpeg-missing',
    });
    expect(readFileSync(mediaPath)).toEqual(oldMedia);
    expect(readFileSync(manifestPath)).toEqual(oldManifest);
    expect(existsSync(mediaBackup)).toBe(false);
    expect(existsSync(manifestBackup)).toBe(false);
    expect(existsSync(stagedManifestPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  }, 120_000);

  it('removes an orphaned partial encode after its owner exits without touching the published pair', async () => {
    if (!sandbox) throw new Error('render recovery sandbox was not created');
    const project = writeSandboxFile(
      sandbox,
      'orphaned-encode.json',
      projectDoc({
        id: 'orphaned-encode',
        title: 'Orphaned encode recovery',
        durationUs: 1_000_000,
        tracks: [
          { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
        ],
      }),
    );
    const outDir = sandbox.path('orphaned-encode');
    mkdirSync(outDir, { recursive: true });
    const mediaPath = join(outDir, 'orphaned-encode.mp4');
    const manifestPath = `${mediaPath}.manifest.json`;
    const partialPath = join(outDir, '.orphaned-encode.mp4.234.abc12345.partial');
    const lockPath = join(outDir, '.orphaned-encode.mp4.render.lock');
    const oldMedia = Buffer.from('last-good-media');
    const oldManifest = Buffer.from('{"mediaProduced":true,"revision":"last-good"}\n');
    writeFileSync(mediaPath, oldMedia);
    writeFileSync(manifestPath, oldManifest);
    writeFileSync(partialPath, Buffer.from('half-rendered-video'));
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: absentProcessId(),
        startedAt: '2026-10-17T00:00:00.000Z',
        activePartialPath: partialPath,
        transaction: null,
      }),
      'utf8',
    );

    const result = await sandbox.run(['render', '--project', project, '--out', outDir, '--json'], {
      env: { JOY_MEDIA_FFMPEG: 'missing-ffmpeg-after-partial-cleanup' },
    });

    expect(result.code, describeRun(result)).toBe(1);
    expect(expectNdjsonContract(result, ['error']).at(-1)).toMatchObject({
      type: 'error',
      code: 'ffmpeg-missing',
    });
    expect(readFileSync(mediaPath)).toEqual(oldMedia);
    expect(readFileSync(manifestPath)).toEqual(oldManifest);
    expect(existsSync(partialPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  }, 120_000);

  it('does not publish media if the sidecar target becomes blocked during encoding', async () => {
    if (!sandbox) throw new Error('render recovery sandbox was not created');
    const project = writeSandboxFile(
      sandbox,
      'blocked-sidecar-race.json',
      projectDoc({
        id: 'blocked-sidecar-race',
        title: 'Blocked sidecar race',
        durationUs: 10_000_000,
        tracks: [
          {
            id: 'video-1',
            clips: Array.from({ length: 5 }, (_, index) => ({
              id: `clip-${index}`,
              assetId: hardCut,
              startUs: index * 2_000_000,
              durationUs: 2_000_000,
            })),
          },
        ],
      }),
    );
    const outDir = sandbox.path('blocked-sidecar-race');
    const render = sandbox.run(['render', '--project', project, '--out', outDir, '--json']);
    const deadline = Date.now() + 20_000;
    let partialExists = false;
    while (Date.now() < deadline) {
      try {
        partialExists = readdirSync(outDir).some((entry) => entry.endsWith('.partial'));
      } catch {
        partialExists = false;
      }
      if (partialExists) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(partialExists, 'render did not expose its staged media while encoding').toBe(true);
    const sidecarDirectory = join(outDir, 'blocked-sidecar-race.mp4.manifest.json');
    mkdirSync(sidecarDirectory);
    writeFileSync(join(sidecarDirectory, 'keep.txt'), 'keep', 'utf8');

    const result = await render;

    expect(result.code, describeRun(result)).toBe(1);
    const events = expectNdjsonContract(result, ['error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'output' });
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(existsSync(join(outDir, 'blocked-sidecar-race.mp4'))).toBe(false);
    expect(readdirSync(outDir).sort()).toEqual(['blocked-sidecar-race.mp4.manifest.json']);
    expect(readFileSync(join(sidecarDirectory, 'keep.txt'), 'utf8')).toBe('keep');
  }, 120_000);

  it.skipIf(!canDenyDirectoryWrites)(
    'preserves the last good media and manifest when output-directory write permission is lost',
    async () => {
      if (!sandbox) throw new Error('render recovery sandbox was not created');
      const projectId = 'permission-recovery';
      const goodProject = writeSandboxFile(
        sandbox,
        'permission-good.json',
        projectDoc({
          id: projectId,
          title: 'Last good render',
          durationUs: 1_000_000,
          tracks: [
            { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
          ],
        }),
      );
      const nextProject = writeSandboxFile(
        sandbox,
        'permission-next.json',
        projectDoc({
          id: projectId,
          title: 'Render after permission denial',
          durationUs: 1_000_000,
          tracks: [
            { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
          ],
        }),
      );
      const outDir = sandbox.path('permission-recovery');
      const firstRender = await sandbox.run([
        'render',
        '--project',
        goodProject,
        '--out',
        outDir,
        '--json',
      ]);
      expect(firstRender.code, describeRun(firstRender)).toBe(0);

      const mediaPath = join(outDir, `${projectId}.mp4`);
      const manifestPath = `${mediaPath}.manifest.json`;
      const lastGoodMedia = readFileSync(mediaPath);
      const lastGoodManifest = readFileSync(manifestPath);
      const ffmpegPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
      const slowFfmpegPath = sandbox.path('slow-ffmpeg.sh');
      writeFileSync(
        slowFfmpegPath,
        `#!/bin/sh\ncase " $* " in\n  *" -i "*) exec '${ffmpegPath}' -re "$@" ;;\n  *) exec '${ffmpegPath}' "$@" ;;\nesac\n`,
        { encoding: 'utf8', mode: 0o755 },
      );

      let permissionDenied = false;
      let sabotageError: Error | undefined;
      const failedRenderPromise = spawnCli(
        sandbox,
        ['render', '--project', nextProject, '--out', outDir, '--json'],
        {
          timeoutMs: 120_000,
          env: { JOY_MEDIA_FFMPEG: slowFfmpegPath },
          onSpawn: (child) => {
            void (async () => {
              const deadline = Date.now() + 20_000;
              while (Date.now() < deadline && child.exitCode === null) {
                if (readdirSync(outDir).some((entry) => entry.endsWith('.partial'))) {
                  chmodSync(outDir, 0o555);
                  permissionDenied = true;
                  return;
                }
                await new Promise((resolveWait) => setTimeout(resolveWait, 5));
              }
              throw new Error('render did not expose staged media before exiting');
            })().catch((error: unknown) => {
              sabotageError = error instanceof Error ? error : new Error(String(error));
            });
          },
        },
      );

      let failedRender: Awaited<typeof failedRenderPromise>;
      try {
        failedRender = await failedRenderPromise;
      } finally {
        chmodSync(outDir, 0o755);
      }

      expect(sabotageError).toBeUndefined();
      expect(permissionDenied).toBe(true);
      expect(failedRender.code, failedRender.stderr).toBe(1);
      const failedEvents = failedRender.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string; code?: string });
      expect(failedEvents.length, failedRender.stderr).toBeGreaterThan(0);
      expect(failedEvents.at(-1), failedRender.stderr + failedRender.stdout).toMatchObject({
        type: 'error',
        code: 'output',
      });
      expect(failedEvents.some((event) => event.type === 'complete')).toBe(false);
      expect(readFileSync(mediaPath)).toEqual(lastGoodMedia);
      expect(readFileSync(manifestPath)).toEqual(lastGoodManifest);

      const recovered = await sandbox.run([
        'render',
        '--project',
        nextProject,
        '--out',
        outDir,
        '--json',
      ]);
      expect(recovered.code, describeRun(recovered)).toBe(0);
      expect(expectNdjsonContract(recovered, ['complete']).at(-1)).toMatchObject({
        type: 'complete',
        mediaProduced: true,
      });
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        projectTitle: 'Render after permission denial',
      });
      expect(readdirSync(outDir).some((entry) => entry.endsWith('.partial'))).toBe(false);
      expect(existsSync(join(outDir, `.${projectId}.mp4.render.lock`))).toBe(false);
    },
    180_000,
  );

  it.skipIf(!canCompileEnospcInjector)(
    'preserves the last good output when a staged-media write returns ENOSPC',
    async () => {
      if (!sandbox) throw new Error('render recovery sandbox was not created');
      const projectId = 'enospc-recovery';
      const project = writeSandboxFile(
        sandbox,
        'enospc-recovery.json',
        projectDoc({
          id: projectId,
          title: 'ENOSPC recovery',
          durationUs: 1_000_000,
          tracks: [
            { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
          ],
        }),
      );
      const outDir = sandbox.path('enospc-recovery');
      const initial = await sandbox.run([
        'render',
        '--project',
        project,
        '--out',
        outDir,
        '--json',
      ]);
      expect(initial.code, describeRun(initial)).toBe(0);

      const mediaPath = join(outDir, `${projectId}.mp4`);
      const manifestPath = `${mediaPath}.manifest.json`;
      const lastGoodMedia = readFileSync(mediaPath);
      const lastGoodManifest = readFileSync(manifestPath);
      const injectorSource = sandbox.path('enospc-write-interposer.c');
      const injectorLibrary = sandbox.path('enospc-write-interposer.so');
      const injectedMarker = sandbox.path('enospc-write-intercepted');
      writeFileSync(
        injectorSource,
        `#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <unistd.h>

static ssize_t (*real_write)(int, const void *, size_t);
static ssize_t (*real_writev)(int, const struct iovec *, int);
static ssize_t (*real_pwrite)(int, const void *, size_t, off_t);
static ssize_t (*real_pwrite64)(int, const void *, size_t, off64_t);
static int marker_written;

static int is_staged_media(int fd) {
  char fd_path[64];
  char target[PATH_MAX];
  snprintf(fd_path, sizeof(fd_path), "/proc/self/fd/%d", fd);
  ssize_t length = readlink(fd_path, target, sizeof(target) - 1);
  if (length < 0) return 0;
  target[length] = '\\0';
  return strstr(target, ".partial") != NULL;
}

static void report_injection(void) {
  if (marker_written) return;
  marker_written = 1;
  const char *path = getenv("JOY_TEST_ENOSPC_MARKER");
  if (!path || !real_write) return;
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return;
  (void)real_write(fd, "ENOSPC", 6);
  close(fd);
}

ssize_t write(int fd, const void *buffer, size_t count) {
  if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
  if (is_staged_media(fd)) {
    report_injection();
    errno = ENOSPC;
    return -1;
  }
  return real_write(fd, buffer, count);
}

ssize_t writev(int fd, const struct iovec *iov, int count) {
  if (!real_writev) real_writev = dlsym(RTLD_NEXT, "writev");
  if (is_staged_media(fd)) {
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    report_injection();
    errno = ENOSPC;
    return -1;
  }
  return real_writev(fd, iov, count);
}

ssize_t pwrite(int fd, const void *buffer, size_t count, off_t offset) {
  if (!real_pwrite) real_pwrite = dlsym(RTLD_NEXT, "pwrite");
  if (is_staged_media(fd)) {
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    report_injection();
    errno = ENOSPC;
    return -1;
  }
  return real_pwrite(fd, buffer, count, offset);
}

ssize_t pwrite64(int fd, const void *buffer, size_t count, off64_t offset) {
  if (!real_pwrite64) real_pwrite64 = dlsym(RTLD_NEXT, "pwrite64");
  if (is_staged_media(fd)) {
    if (!real_write) real_write = dlsym(RTLD_NEXT, "write");
    report_injection();
    errno = ENOSPC;
    return -1;
  }
  return real_pwrite64(fd, buffer, count, offset);
}
`,
        'utf8',
      );
      execFileSync('cc', [
        '-shared',
        '-fPIC',
        '-O2',
        '-o',
        injectorLibrary,
        injectorSource,
        '-ldl',
      ]);

      const failed = await sandbox.run(
        ['render', '--project', project, '--out', outDir, '--json'],
        { env: { LD_PRELOAD: injectorLibrary, JOY_TEST_ENOSPC_MARKER: injectedMarker } },
      );
      expect(existsSync(injectedMarker)).toBe(true);
      const events = expectNdjsonContract(failed, ['error']);
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'encode-failed' });
      expect((events.at(-1)?.['message'] as string | undefined) ?? '').toMatch(
        /No space left on device/i,
      );
      expect(readFileSync(mediaPath)).toEqual(lastGoodMedia);
      expect(readFileSync(manifestPath)).toEqual(lastGoodManifest);

      const recovered = await sandbox.run([
        'render',
        '--project',
        project,
        '--out',
        outDir,
        '--json',
      ]);
      expect(recovered.code, describeRun(recovered)).toBe(0);
      expect(expectNdjsonContract(recovered, ['complete']).at(-1)).toMatchObject({
        type: 'complete',
        mediaProduced: true,
      });
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        projectTitle: 'ENOSPC recovery',
      });
    },
    180_000,
  );

  it('rejects a concurrent render to the same output instead of cross-publishing media and metadata', async () => {
    if (!sandbox) throw new Error('render recovery sandbox was not created');
    const firstProject = writeSandboxFile(
      sandbox,
      'concurrent-first.json',
      projectDoc({
        id: 'concurrent-output',
        title: 'One second hard cut',
        durationUs: 1_000_000,
        tracks: [
          { id: 'video-1', clips: [{ id: 'hard-cut', assetId: hardCut, durationUs: 1_000_000 }] },
        ],
      }),
    );
    const secondProject = writeSandboxFile(
      sandbox,
      'concurrent-second.json',
      projectDoc({
        id: 'concurrent-output',
        title: 'Two second silent source',
        durationUs: 2_000_000,
        tracks: [
          { id: 'video-1', clips: [{ id: 'silent', assetId: silent, durationUs: 2_000_000 }] },
        ],
      }),
    );
    const outDir = sandbox.path('concurrent-output');
    const render = (projectPath: string) =>
      sandbox!.run(['render', '--project', projectPath, '--out', outDir, '--json']);

    const results = await Promise.all([render(firstProject), render(secondProject)]);
    const eventLists = results.map((result) => expectNdjsonContract(result, ['complete', 'error']));
    const completed = eventLists.filter((events) => events.at(-1)?.['type'] === 'complete');
    const failed = eventLists.filter((events) => events.at(-1)?.['type'] === 'error');
    const runDiagnostics = results.map(describeRun).join('\n--- second render ---\n');

    expect(
      [
        [1, 1],
        [2, 0],
      ],
      runDiagnostics,
    ).toContainEqual([completed.length, failed.length]);
    for (const failedRun of failed) {
      expect(failedRun.at(-1)).toMatchObject({ type: 'error', code: 'output' });
      expect(failedRun.some((event) => event.type === 'start')).toBe(false);
    }

    const manifest = JSON.parse(
      readFileSync(
        sandbox.path('concurrent-output', 'concurrent-output.mp4.manifest.json'),
        'utf8',
      ),
    ) as { projectTitle: string; media: { durationUs: number } };
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=nw=1:nk=1',
        sandbox.path('concurrent-output', 'concurrent-output.mp4'),
      ],
      { encoding: 'utf8' },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const decodedDurationUs = Number.parseFloat(probe.stdout) * 1_000_000;
    expect(Math.abs(decodedDurationUs - manifest.media.durationUs)).toBeLessThanOrEqual(50_000);
    const expectedDurationUs =
      manifest.projectTitle === 'One second hard cut' ? 1_000_000 : 2_000_000;
    expect(['One second hard cut', 'Two second silent source']).toContain(manifest.projectTitle);
    expect(Math.abs(decodedDurationUs - expectedDurationUs)).toBeLessThanOrEqual(50_000);
  }, 120_000);
});
