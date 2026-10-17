import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { safeInstalledCliEnvironment } from './installed-cli-environment.mjs';

let stateDirectory;

afterEach(() => {
  if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true });
  stateDirectory = undefined;
});

test(
  'limits child PATH to Windows system tools and the selected media tools',
  { skip: process.platform !== 'win32' },
  () => {
    stateDirectory = mkdtempSync(join(tmpdir(), 'joy-media-acceptance-env-'));
    const env = safeInstalledCliEnvironment({
      stateDirectory,
      systemRoot: 'C:\\Windows',
      executablePaths: ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffprobe.exe'],
    });

    assert.deepEqual(env.PATH.split(';'), ['C:\\Windows\\System32', 'C:\\ffmpeg\\bin']);
    assert.equal(env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.USERPROFILE, join(stateDirectory, 'profile'));
  },
);

test(
  'rejects relative system roots or executable paths',
  { skip: process.platform !== 'win32' },
  () => {
    stateDirectory = mkdtempSync(join(tmpdir(), 'joy-media-acceptance-env-'));
    assert.throws(
      () =>
        safeInstalledCliEnvironment({
          stateDirectory,
          systemRoot: 'Windows',
          executablePaths: ['C:\\ffmpeg\\bin\\ffmpeg.exe'],
        }),
      /absolute/,
    );
    assert.throws(
      () =>
        safeInstalledCliEnvironment({
          stateDirectory,
          systemRoot: 'C:\\Windows',
          executablePaths: ['ffmpeg.exe'],
        }),
      /absolute/,
    );
  },
);
