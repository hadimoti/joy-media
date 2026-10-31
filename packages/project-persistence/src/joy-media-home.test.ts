import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJoyMediaHome } from './joy-media-home.js';

let originalJoyMediaHome: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let temporaryRoot = '';

beforeEach(() => {
  originalJoyMediaHome = process.env.JOY_MEDIA_HOME;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-media-home-test-'));
  process.env.HOME = temporaryRoot;
  process.env.USERPROFILE = temporaryRoot;
});

afterEach(() => {
  if (originalJoyMediaHome === undefined) delete process.env.JOY_MEDIA_HOME;
  else process.env.JOY_MEDIA_HOME = originalJoyMediaHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('getJoyMediaHome', () => {
  it('uses JOY_MEDIA_HOME when it is set', () => {
    const configuredHome = join(temporaryRoot, 'configured-home');
    process.env.JOY_MEDIA_HOME = configuredHome;

    expect(getJoyMediaHome()).toBe(configuredHome);
  });

  it('resolves a relative JOY_MEDIA_HOME against the current working directory', () => {
    process.env.JOY_MEDIA_HOME = 'relative-home/../configured-home';

    expect(getJoyMediaHome()).toBe(resolve(process.cwd(), 'relative-home/../configured-home'));
  });

  it('defaults to os.homedir() in a fresh process when unset or blank', () => {
    const moduleUrl = new URL('./joy-media-home.ts', import.meta.url).href;
    const script = [
      "import { homedir } from 'node:os';",
      "import { join } from 'node:path';",
      `import { getJoyMediaHome } from ${JSON.stringify(moduleUrl)};`,
      "process.stdout.write(JSON.stringify({ home: getJoyMediaHome(), expected: join(homedir(), '.joy-media') }));",
    ].join('\n');
    const runInFreshProcess = (configuredHome?: string) => {
      const childEnvironment = { ...process.env };
      if (configuredHome === undefined) delete childEnvironment.JOY_MEDIA_HOME;
      else childEnvironment.JOY_MEDIA_HOME = configuredHome;

      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        { encoding: 'utf8', env: childEnvironment },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as { home: string; expected: string };
    };

    const defaultResult = runInFreshProcess();
    expect(defaultResult.expected).toBe(join(temporaryRoot, '.joy-media'));
    expect(defaultResult.home).toBe(defaultResult.expected);

    const blankResult = runInFreshProcess('   ');
    expect(blankResult.expected).toBe(join(temporaryRoot, '.joy-media'));
    expect(blankResult.home).toBe(blankResult.expected);
  });
});
