import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Worker launchers', () => {
  it.runIf(process.platform === 'win32')(
    'defaults whitespace-only JOY_MEDIA_HOME in run-worker.bat and keeps related defaults',
    () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-media-run-worker-bat-test-'));
      try {
        const launcherPath = join(temporaryRoot, 'run-worker.bat');
        const shimDirectory = join(temporaryRoot, 'bin');
        const capturePath = join(temporaryRoot, 'captured-environment.txt');
        const nodeShimPath = join(shimDirectory, 'node.cmd');
        mkdirSync(shimDirectory, { recursive: true });
        copyFileSync(resolve(process.cwd(), 'run-worker.bat'), launcherPath);
        writeFileSync(
          nodeShimPath,
          [
            '@echo off',
            '> "%JOY_MEDIA_TEST_CAPTURE%" echo HOME=%JOY_MEDIA_HOME%',
            '>> "%JOY_MEDIA_TEST_CAPTURE%" echo STATE=%JOY_MEDIA_WORKER_STATE_PATH%',
            '>> "%JOY_MEDIA_TEST_CAPTURE%" echo MODELS=%JOY_MEDIA_MODEL_ROOT%',
            'exit /b 0',
            '',
          ].join('\r\n'),
          'utf8',
        );

        const environment = { ...process.env };
        environment.JOY_MEDIA_HOME = '   ';
        environment.JOY_MEDIA_API_URL = 'http://127.0.0.1:8123';
        environment.JOY_MEDIA_WORKER_LOCAL_TOKEN = 'test';
        environment.JOY_MEDIA_TEST_CAPTURE = capturePath;
        environment.USERPROFILE = temporaryRoot;
        environment.PATH = `${shimDirectory};${process.env.PATH ?? ''}`;
        const captureEnvironment = (configuredHome?: string) => {
          const childEnvironment = { ...environment };
          delete childEnvironment.JOY_MEDIA_WORKER_STATE_PATH;
          if (configuredHome === undefined) delete childEnvironment.JOY_MEDIA_HOME;
          else childEnvironment.JOY_MEDIA_HOME = configuredHome;

          const result = spawnSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/c', `call ${launcherPath}`],
            { cwd: temporaryRoot, encoding: 'utf8', env: childEnvironment, timeout: 15_000 },
          );
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
          return readFileSync(capturePath, 'utf8').trim().split(/\r?\n/u);
        };

        const home = join(temporaryRoot, '.joy-media');
        const expected = [
          `HOME=${home}`,
          `STATE=${join(home, 'worker-state.json')}`,
          `MODELS=${join(temporaryRoot, 'JOY', 'models')}`,
        ];
        expect(captureEnvironment()).toEqual(expected);
        expect(captureEnvironment('   ')).toEqual(expected);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'passes the computed JOY_MEDIA_HOME to the worker child',
    () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-media-sea-bootstrap-test-'));
      try {
        const entryPoint = join(temporaryRoot, 'capture-home.cjs');
        const capturePath = join(temporaryRoot, 'captured-home.txt');
        let invocation = 0;
        writeFileSync(
          entryPoint,
          "require('node:fs').writeFileSync(process.env.JOY_MEDIA_TEST_CAPTURE, process.env.JOY_MEDIA_HOME ?? '<unset>', 'utf8');\n",
          'utf8',
        );

        const environment = { ...process.env };
        delete environment.JOY_MEDIA_HOME;
        environment.HOME = temporaryRoot;
        environment.USERPROFILE = temporaryRoot;
        environment.JOY_MEDIA_API_URL = 'http://127.0.0.1:8123';
        environment.JOY_MEDIA_WORKER_ROOT = temporaryRoot;
        environment.JOY_MEDIA_WORKER_ENTRYPOINT = entryPoint;
        environment.JOY_MEDIA_WORKER_STATE_PATH = join(temporaryRoot, 'state', 'worker-state.json');
        environment.JOY_MEDIA_NODE_PATH = process.execPath;
        environment.JOY_MEDIA_TEST_CAPTURE = capturePath;

        const runBootstrap = (configuredHome?: string) => {
          const childEnvironment = { ...environment };
          if (configuredHome === undefined) delete childEnvironment.JOY_MEDIA_HOME;
          else childEnvironment.JOY_MEDIA_HOME = configuredHome;
          childEnvironment.JOY_MEDIA_WORKER_PIPE = `\\\\.\\pipe\\joy-media-sea-test-${process.pid}-${Date.now()}-${invocation++}`;

          const result = spawnSync(
            process.execPath,
            [resolve(process.cwd(), 'scripts/worker-sea-bootstrap.cjs')],
            { cwd: process.cwd(), encoding: 'utf8', env: childEnvironment, timeout: 15_000 },
          );
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
          return readFileSync(capturePath, 'utf8');
        };

        expect(runBootstrap()).toBe(join(temporaryRoot, '.joy-media'));
        expect(runBootstrap('relative-home/../configured-home')).toBe(
          resolve(process.cwd(), 'relative-home/../configured-home'),
        );
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );
});
