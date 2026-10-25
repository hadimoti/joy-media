/**
 * POSIX-only render recovery cases from render-recovery.e2e.test.ts: loss of output-directory write
 * permission, and an ENOSPC injector. Windows cannot express these conditions, so the Windows
 * lifecycle step does not run this file. The Linux CLI suite runs it.
 */
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

describe.skipIf(!hasFfmpeg())('real render output recovery on POSIX', () => {
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

  beforeAll(() => {
    sandbox = createSandbox('render-recovery-posix');
  });
  afterAll(() => sandbox?.cleanup());

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
});
