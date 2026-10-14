/**
 * The AI-ready CLI contract, enforced against the REAL binary (both shipped
 * entry points). These are the things a tool loop or a script relies on:
 *
 *   exit 0 ok · 1 runtime failure · 2 usage error · 130 SIGINT · 143 SIGTERM
 *   a clean run has EMPTY stderr; `--json` stdout is only JSON, never ANSI
 *   typos and missing values are usage errors with a "did you mean" hint
 *   `--help` works per command; nothing blocks on a non-TTY stdin
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENTRIES,
  describeRaw,
  entryPath,
  ptyAvailable,
  refusedUrl,
  runInPty,
  spawnCli,
  startServer,
} from './cli-helpers.js';
import { createSandbox, describeRun, hasAnsi, type Sandbox } from './harness.js';
import { defaultProjectDbPath } from './project-helpers.js';

const COMMANDS = [
  'agent',
  'project',
  'timeline',
  'worker',
  'render',
  'benchmark',
  'doctor',
  'help',
];
const OFFLINE = { JOY_MEDIA_EDGE_URL: 'off' };

/** A minimal project file the timeline/render commands accept via `--project file.json`. */
function writeProjectFile(sb: Sandbox, name = 'demo.json'): string {
  const path = sb.path(name);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      id: 'proj-demo',
      title: 'Demo',
      rootCompositionId: 'root',
      assets: {},
      compositions: {
        root: {
          id: 'root',
          name: 'Main',
          width: 1080,
          height: 1920,
          frameRate: { num: 30, den: 1 },
          durationUs: 10_000_000,
          tracks: [
            { id: 'track-v1', kind: 'video', name: 'V1', order: 0, enabled: true, clips: [] },
          ],
        },
      },
    }),
  );
  return path;
}

function clipsIn(path: string): Array<{ startUs: number; durationUs: number }> {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const project = doc.project ?? doc;
  return project.compositions.root.tracks[0].clips;
}

let sb: Sandbox;
beforeEach(() => {
  sb = createSandbox('contract');
});
afterEach(() => sb.cleanup());

describe('stderr is empty on a clean run (so any stderr means trouble)', () => {
  for (const entry of ENTRIES) {
    it(`no startup noise from node:sqlite via ${entry}`, async () => {
      for (const args of [
        ['--version'],
        ['--help'],
        ['help'],
        ['project', 'list'],
        ['project', '--help'],
        ['worker', 'status'],
        ['doctor'],
      ]) {
        const r = await sb.run(args, { entry, env: OFFLINE });
        expect(r.code, describeRun(r)).toBe(0);
        expect(r.stderr, describeRun(r)).toBe('');
      }
    }, 30_000);

    it(`other warnings still reach stderr via ${entry}`, async () => {
      const canary = sb.path('canary.cjs');
      writeFileSync(
        canary,
        "process.emitWarning('Canary feature is experimental', 'ExperimentalWarning');\n" +
          "process.emitWarning('canary deprecation', 'DeprecationWarning', 'DEP_CANARY');\n",
      );
      const r = await sb.run(['project', 'list'], {
        entry,
        env: { NODE_OPTIONS: `--require ${JSON.stringify(canary)}` },
      });
      expect(r.code, describeRun(r)).toBe(0);
      expect(r.err).toContain('Canary feature is experimental');
      expect(r.err).toContain('canary deprecation');
      expect(r.err).not.toContain('SQLite is an experimental feature');
    });
  }
});

describe('flag parsing: mistakes are usage errors (exit 2), never silently dropped', () => {
  it('a human fat-fingers --projct and is told what they probably meant', async () => {
    const r = await sb.run(['timeline', 'add-clip', '--projct', 'demo.json']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Unknown option --projct\. Did you mean --project\?/);
    expect(r.err).toMatch(/joy-media timeline --help/);
    expect(r.stdout).toBe('');
  });

  it('a trailing --name without a value is an error and creates nothing', async () => {
    const r = await sb.run(['project', 'create', '--name']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/--name requires a value/);
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
  });

  it('an option never swallows the next option as its value', async () => {
    const r = await sb.run(['render', '--project', '--json']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/--project requires a value but got the option "--json"/);
  });

  for (const entry of ENTRIES) {
    it(`negative numbers reach the validator (--start -3 / --start=-3) via ${entry}`, async () => {
      for (const args of [
        ['timeline', 'add-clip', '--project', 'p', '--start', '-3'],
        ['timeline', 'add-clip', '--project', 'p', '--start=-3'],
      ]) {
        const r = await sb.run(args, { entry });
        expect(r.code, describeRun(r)).toBe(2);
        expect(r.err).toMatch(/Invalid value for --start: value must be >= 0 \(received: -3\)/);
      }
    });
  }

  it('switches do not take values (--json=false is rejected, not treated as true)', async () => {
    const r = await sb.run(['doctor', '--json=false'], { env: OFFLINE });
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/--json is a switch and does not take a value/);
    expect(r.stdout).toBe('');
  });

  it('-project (one dash) is caught instead of becoming --project "roject"', async () => {
    const r = await sb.run(['timeline', 'add-clip', '-project', 'demo.json']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Unknown option -project\. Did you mean --project\?/);
  });

  it('an empty numeric value is an error, not "use the default"', async () => {
    const r = await sb.run(['project', 'create', 'Wide', '--width', '']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/--width requires a numeric value/);
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
  });

  it('a bare negative number explains how to pass it', async () => {
    const r = await sb.run(['project', 'create', '-5']);
    expect(r.code, describeRun(r)).toBe(2);
    expect(r.err).toMatch(/Unknown option -5\..*after "--"/);
  });

  it('every flag a command reads is accepted (long, short and --flag=value forms)', async () => {
    const r = await sb.run([
      'help',
      '--project',
      'p',
      '--apply',
      '--name',
      'n',
      '--provider',
      'openrouter',
      '--model',
      'm',
      '--api-key',
      'k',
      '--base-url',
      'http://127.0.0.1:1',
      '--url',
      'http://127.0.0.1:1',
      '--output',
      'o.json',
      '--width',
      '1920',
      '--height',
      '1080',
      '--fps',
      '30',
      '--track',
      't',
      '--clip',
      'c',
      '--asset',
      'a',
      '--start',
      '0',
      '--duration',
      '1.5',
      '--end',
      '2',
      '--at',
      '0',
      '--scale',
      '2',
      '--sqlite-path',
      'db.sqlite3',
      '--preset',
      'mp4',
      '--out',
      'renders',
      '--concurrency',
      '2',
      '--json',
      '--system',
      '--media-engine',
      '-p',
      'p',
      '-n',
      'n',
      '-m',
      'm',
      '-u',
      'http://127.0.0.1:1',
      '-o',
      'o.json',
      '--sqlite-path=db.sqlite3',
      '--start=0.5',
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.stderr, describeRun(r)).toBe('');
  });

  it('--help and --version still win over a typo', async () => {
    const version = await sb.run(['project', 'list', '--projct', '--version']);
    expect(version.code, describeRun(version)).toBe(0);
    expect(version.out).toMatch(/JOY Media CLI v\d+\.\d+\.\d+/);
    const help = await sb.run(['project', '--projct', '--help']);
    expect(help.code, describeRun(help)).toBe(0);
    expect(help.out).toMatch(/Usage: joy-media project/);
  });
});

describe('timeline positions start at 0:00', () => {
  it('timeline add-clip --start 0 is accepted and lands at the very start', async () => {
    const file = writeProjectFile(sb);
    const r = await sb.run([
      'timeline',
      'add-clip',
      '--project',
      file,
      '--start',
      '0',
      '--duration',
      '2',
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(clipsIn(file)).toEqual([expect.objectContaining({ startUs: 0, durationUs: 2_000_000 })]);
  });

  it('trim --start 0 and split --at 0 are judged by the command, not rejected as flags', async () => {
    const file = writeProjectFile(sb);
    await sb.run(['timeline', 'add-clip', '--project', file, '--start', '1', '--duration', '4']);
    const clipId = (clipsIn(file)[0] as unknown as { id: string }).id;
    const trim = await sb.run([
      'timeline',
      'trim',
      '--project',
      file,
      '--clip',
      clipId,
      '--start',
      '0',
      '--end',
      '3',
    ]);
    expect(trim.code, describeRun(trim)).toBe(0);
    expect(clipsIn(file)[0]).toEqual(
      expect.objectContaining({ startUs: 0, durationUs: 3_000_000 }),
    );
    // 0s is a legal VALUE; splitting exactly at a clip edge is a runtime error (1), not usage (2).
    const split = await sb.run([
      'timeline',
      'split',
      '--project',
      file,
      '--clip',
      clipId,
      '--at',
      '0',
    ]);
    expect(split.code, describeRun(split)).toBe(1);
    expect(split.err).toMatch(/outside clip range/);
  });

  it('a negative position and a zero duration get accurate messages', async () => {
    const neg = await sb.run(['timeline', 'add-clip', '--project', 'p', '--at', '-0.5']);
    expect(neg.code, describeRun(neg)).toBe(2);
    expect(neg.err).toMatch(/--at: value must be >= 0 \(received: -0\.5\)/);
    const zero = await sb.run(['timeline', 'add-clip', '--project', 'p', '--duration', '0']);
    expect(zero.code, describeRun(zero)).toBe(2);
    expect(zero.err).toMatch(/--duration: value must be >= 0\.001 \(received: 0\)/);
  });
});

describe('help: an AI agent can discover every command', () => {
  it('every command answers --help and -h with its own usage on stdout, exit 0', async () => {
    for (const command of COMMANDS) {
      for (const flag of ['--help', '-h']) {
        const r = await sb.run([command, flag]);
        expect(r.code, describeRun(r)).toBe(0);
        expect(r.out, describeRun(r)).toContain(`Usage: joy-media ${command}`);
        expect(r.stderr, describeRun(r)).toBe('');
      }
    }
  });

  it('help <command> prints the same thing as <command> --help', async () => {
    for (const command of ['project', 'worker', 'doctor']) {
      const a = await sb.run(['help', command]);
      const b = await sb.run([command, '--help']);
      expect(a.code).toBe(0);
      expect(a.stdout).toBe(b.stdout);
    }
  });

  it('--help never runs the command it describes', async () => {
    const r = await sb.run(['project', 'create', 'Should Not Exist', '--help']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
  });

  it('help for an unknown command suggests the closest one', async () => {
    const r = await sb.run(['help', 'projct']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/Unknown command "projct"\. Did you mean "project"\?/);
  });

  it('the global help documents --json and the exit codes', async () => {
    const r = await sb.run(['--help']);
    expect(r.out).toMatch(/--json/);
    expect(r.out).toMatch(/0 ok · 1 failure · 2 usage error · 130 interrupted/);
    for (const command of COMMANDS) expect(r.out).toContain(command);
  });
});

describe('dispatcher ergonomics', () => {
  it('flags may come before the command, with --flag=value syntax', async () => {
    const db = sb.path('early.sqlite3');
    const r = await sb.run([`--sqlite-path=${db}`, 'project', 'create', 'Early']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(existsSync(db)).toBe(true);

    const doc = await sb.run(['--json', 'doctor'], { env: OFFLINE });
    expect(doc.code, describeRun(doc)).toBe(0);
    expect(doc.json<{ checks: unknown[] }>().checks.length).toBeGreaterThan(0);
  });

  it('"--" ends option parsing so a title may start with a dash', async () => {
    const db = sb.path('dash.sqlite3');
    const r = await sb.run(['project', 'create', '--sqlite-path', db, '--', '--not-a-flag', '-5']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toContain('--not-a-flag -5');
  });

  it('a repeated flag: the last one wins', async () => {
    const first = sb.path('first.sqlite3');
    const last = sb.path('last.sqlite3');
    const r = await sb.run([
      'project',
      'create',
      'Twice',
      '--sqlite-path',
      first,
      '--sqlite-path',
      last,
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(existsSync(last)).toBe(true);
    expect(existsSync(first)).toBe(false);
  });

  it('--version wins wherever it appears and has a JSON form', async () => {
    const r = await sb.run(['project', 'create', 'Nope', '--version']);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out.trim()).toMatch(/^JOY Media CLI v\d+\.\d+\.\d+$/);
    expect(existsSync(defaultProjectDbPath(sb))).toBe(false);
    const j = await sb.run(['--version', '--json']);
    expect(j.json()).toEqual({
      name: 'joy-media',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });

  it('commands are case-sensitive, but the error points at the right one', async () => {
    const r = await sb.run(['PROJECT', 'list']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/Unknown command "PROJECT"\. Did you mean "project"\?/);
    const typo = await sb.run(['projct', 'list']);
    expect(typo.err).toMatch(/Did you mean "project"\?/);
    const nonsense = await sb.run(['zzzzzz']);
    expect(nonsense.err).not.toMatch(/Did you mean/);
  });

  it('a failing command explains itself in ONE stderr line (no "Process exiting" echo)', async () => {
    const r = await sb.run(['frobnicate']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err.trim().split('\n'), describeRun(r)).toHaveLength(1);
  });

  it('an empty-string command is reported, not crashed on', async () => {
    const r = await sb.run(['']);
    expect(r.code, describeRun(r)).toBe(1);
    expect(r.err).toMatch(/Unknown command ""/);
  });

  it('unicode arguments survive the round trip', async () => {
    const title = 'Café 日本語 🎬 ñandú';
    const r = await sb.run(['project', 'create', title, '--sqlite-path', sb.path('u.sqlite3')]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toContain(title);
  });

  it('a huge argv is handled', async () => {
    const words = Array.from({ length: 5000 }, (_, i) => `w${i}`);
    const r = await sb.run([
      'project',
      'create',
      ...words,
      '--sqlite-path',
      sb.path('big.sqlite3'),
    ]);
    expect(r.code, describeRun(r)).toBe(0);
    expect(r.out).toContain('w4999');
  });

  it('JOY_CLI_DEBUG adds exit diagnostics on stderr without polluting stdout', async () => {
    const args = ['project', 'list', '--typo'];
    const quiet = await sb.run(args);
    expect(quiet.code, describeRun(quiet)).toBe(2);
    expect(quiet.err).not.toMatch(/^\s+at /m);

    const debug = await sb.run(args, { env: { JOY_CLI_DEBUG: '1' } });
    expect(debug.code, describeRun(debug)).toBe(2);
    expect(debug.err).toMatch(/Process exiting with code 2/);
    expect(debug.err).not.toMatch(/^\s+at /m);
    expect(debug.stdout, describeRun(debug)).toBe('');
  });

  // Owner: utils/project-loader.ts / timeline-cmd.ts. A project file without
  // `compositions` surfaces as a raw TypeError.
  it('a malformed project file gets a clear error, not a raw TypeError', async () => {
    const bad = sb.path('bad.json');
    writeFileSync(bad, JSON.stringify({ id: 'x', rootCompositionId: 'root' }));
    const r = await sb.run(['timeline', 'add-clip', '--project', bad]);
    expect(r.err).not.toMatch(/Cannot read properties of undefined/);
  });
});

describe('colour: only for terminals, and decided per stream', () => {
  it('piped output carries no ANSI by default', async () => {
    const r = await sb.run(['help']);
    expect(hasAnsi(r.stdout)).toBe(false);
    const e = await sb.run(['frobnicate']);
    expect(hasAnsi(e.stderr)).toBe(false);
  });

  it('FORCE_COLOR=1 forces colour on a pipe; FORCE_COLOR=0 keeps it off', async () => {
    const forced = await sb.run(['help'], { env: { FORCE_COLOR: '1' } });
    expect(hasAnsi(forced.stdout), describeRun(forced)).toBe(true);
    const off = await sb.run(['help'], { env: { FORCE_COLOR: '0' } });
    expect(hasAnsi(off.stdout)).toBe(false);
  });

  it('--json output is never coloured, even with FORCE_COLOR', async () => {
    const r = await sb.run(['doctor', '--json'], { env: { ...OFFLINE, FORCE_COLOR: '1' } });
    expect(hasAnsi(r.stdout) || hasAnsi(r.stderr), describeRun(r)).toBe(false);
    expect(() => r.json()).not.toThrow();
  });

  it.runIf(ptyAvailable)('NO_COLOR is honoured on a real terminal', async () => {
    const coloured = await runInPty(sb, ['help']);
    expect(hasAnsi(coloured.terminal), coloured.terminal).toBe(true);
    const plain = await runInPty(sb, ['help'], { env: { NO_COLOR: '1' } });
    expect(hasAnsi(plain.terminal), plain.terminal).toBe(false);
  });

  it.runIf(ptyAvailable)('stdout on a terminal does not colour a redirected stderr', async () => {
    const errFile = sb.path('stderr.txt');
    const r = await runInPty(sb, ['frobnicate'], { redirect: `2>${errFile}` });
    expect(r.code).toBe(1);
    const stderr = readFileSync(errFile, 'utf8');
    expect(stderr).toMatch(/Unknown command/);
    expect(hasAnsi(stderr), JSON.stringify(stderr)).toBe(false);
  });

  it.runIf(ptyAvailable)('stderr on a terminal is coloured even when stdout is piped', async () => {
    const r = await runInPty(sb, ['frobnicate'], { redirect: '| cat' });
    expect(r.terminal).toMatch(/Unknown command/);
    expect(hasAnsi(r.terminal), JSON.stringify(r.terminal)).toBe(true);
  });
});

describe('process lifecycle', () => {
  for (const entry of ENTRIES) {
    it(`a reader that hangs up early (| head) is not a crash via ${entry}`, async () => {
      const args = ['benchmark', '--media-engine', '--json'];
      const r = await spawnCli(sb, args, { entry, closeStdoutImmediately: true });
      expect(r.code, describeRaw(args, r)).toBe(0);
      expect(r.stderr, describeRaw(args, r)).not.toMatch(/EPIPE|Unexpected error|^\s+at /m);
    });

    it.skipIf(process.platform === 'win32')(
      `SIGINT during a hung network call exits 130, cleanly, via ${entry}`,
      async () => {
        const edge = await startServer(); // accepts, never answers
        try {
          const args = ['doctor'];
          const r = await spawnCli(sb, args, {
            entry,
            env: { JOY_MEDIA_EDGE_URL: edge.url },
            onSpawn: (child) => void edge.firstHit.then(() => child.kill('SIGINT')),
          });
          expect(r.code, describeRaw(args, r)).toBe(130);
          expect(r.err).toMatch(/Received SIGINT/);
          expect(r.err).not.toMatch(/^\s+at /m);
        } finally {
          await edge.close();
        }
      },
    );

    it.skipIf(process.platform === 'win32')(`SIGTERM exits 143 via ${entry}`, async () => {
      const edge = await startServer();
      try {
        const args = ['doctor', '--json'];
        const r = await spawnCli(sb, args, {
          entry,
          env: { JOY_MEDIA_EDGE_URL: edge.url },
          onSpawn: (child) => void edge.firstHit.then(() => child.kill('SIGTERM')),
        });
        expect(r.code, describeRaw(args, r)).toBe(143);
        expect(r.err).toMatch(/Received SIGTERM/);
      } finally {
        await edge.close();
      }
    });
  }

  it('non-interactive commands never wait on an open, silent stdin', async () => {
    const refused = await refusedUrl();
    for (const args of [['help'], ['project', 'list'], ['worker', 'status'], ['doctor']]) {
      const r = await spawnCli(sb, args, {
        keepStdinOpen: true,
        env: { JOY_MEDIA_EDGE_URL: refused },
        timeoutMs: 30_000,
      });
      expect(r.code, describeRaw(args, r)).toBe(0);
    }
  });

  // Owner: commands/agent-cmd.ts / agent/repl.ts. `joy-media agent` defaults to
  // the interactive REPL, which prints a prompt to stdout and blocks forever on
  // an open non-TTY stdin (typical for tool runners). It should refuse (exit 2)
  // or treat a non-TTY stdin as a script and stop at EOF.
  it('`joy-media agent` without a TTY does not hang a tool loop', async () => {
    const r = await spawnCli(sb, ['agent'], { keepStdinOpen: true, timeoutMs: 5_000 });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/TTY/);
  });

  it('the launcher works from an install path containing "#"', async () => {
    const install = sb.path('tools#1', 'joy-media');
    mkdirSync(join(install, 'bin'), { recursive: true });
    mkdirSync(join(install, 'dist'), { recursive: true });
    copyFileSync(entryPath('bin'), join(install, 'bin', 'joy-media.mjs'));
    // The single-file bundle is self-contained, so it can stand in for dist/bin.js.
    copyFileSync(entryPath('bundle'), join(install, 'dist', 'bin.js'));
    const args = ['--version'];
    const r = await spawnCli(sb, args, { entryFile: join(install, 'bin', 'joy-media.mjs') });
    expect(r.code, describeRaw(args, r)).toBe(0);
    expect(r.out).toMatch(/JOY Media CLI v/);
  });
});
