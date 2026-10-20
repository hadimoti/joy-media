/* global process, setTimeout, clearTimeout, Buffer */
/**
 * Humanized black-box harness for the JOY Media CLI.
 *
 * Every test drives the REAL built binary (`apps/cli/bin/joy-media.mjs`, or the
 * single-file bundle) as a child process, exactly the way a person at a
 * terminal or an AI agent in a tool loop would: argv in, stdout/stderr/exit
 * code out, in a throw-away HOME so nothing touches the developer's real
 * `~/.joy-media` database or provider keys.
 *
 * In-process `runCli()` tests cannot see process-level behaviour (exit codes,
 * stream hygiene, signal handling, startup warnings), which is where AI
 * callers get hurt first.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const CLI_ROOT = resolve(HERE, '..', '..');
export const REPO_ROOT = resolve(CLI_ROOT, '..', '..');
const BIN_ENTRY = join(CLI_ROOT, 'bin', 'joy-media.mjs');
const BUNDLE_ENTRY = join(CLI_ROOT, 'dist', 'joy-media-bundle.mjs');
const DIST_BIN = join(CLI_ROOT, 'dist', 'bin.js');

// ---------------------------------------------------------------------------
// Build management (tests run against dist/, so make sure it is fresh)
// ---------------------------------------------------------------------------

function newestMtime(dir: string, skip: ReadonlySet<string>): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, skip));
    } else if (/\.(ts|tsx|mjs|json)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function buildIsStale(): boolean {
  if (!existsSync(DIST_BIN) || !existsSync(BUNDLE_ENTRY)) return true;
  const builtAt = Math.min(statSync(DIST_BIN).mtimeMs, statSync(BUNDLE_ENTRY).mtimeMs);
  const skip = new Set(['node_modules', 'dist', '.git']);
  const watched = [
    join(CLI_ROOT, 'src'),
    join(REPO_ROOT, 'packages', 'joy-agent-engine', 'src'),
    join(REPO_ROOT, 'packages', 'project-schema', 'src'),
    join(REPO_ROOT, 'packages', 'project-persistence', 'src'),
    join(REPO_ROOT, 'packages', 'commands', 'src'),
    join(REPO_ROOT, 'packages', 'agent-tools', 'src'),
    join(REPO_ROOT, 'packages', 'motion-core', 'src'),
  ];
  // Test files do not affect the shipped binary.
  return watched.some((dir) => newestMtime(dir, new Set([...skip, 'humanized'])) > builtAt + 1);
}

let buildChecked = false;
let buildFailure: Error | undefined;

/**
 * Build `apps/cli` if `dist/` is missing or older than its sources.
 * Safe across parallel Vitest worker processes: an exclusive lock file makes
 * exactly one worker build while the others wait.
 */
export function ensureCliBuilt(): void {
  if (buildFailure) throw buildFailure;
  if (buildChecked) return;
  if (!buildIsStale()) {
    buildChecked = true;
    return;
  }
  const lock = join(CLI_ROOT, 'dist', '.build.lock');
  mkdirSync(join(CLI_ROOT, 'dist'), { recursive: true });
  const deadline = Date.now() + 300_000;
  let lockFd: number | undefined;
  for (;;) {
    try {
      lockFd = openSync(lock, 'wx');
      writeFileSync(lockFd, `${process.pid}\n${Date.now()}\n`);
      closeSync(lockFd);
      lockFd = undefined;
      break;
    } catch (error) {
      if (lockFd !== undefined) {
        closeSync(lockFd);
        lockFd = undefined;
        try {
          unlinkSync(lock);
        } catch {
          /* lock already removed */
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 600_000) unlinkSync(lock);
      } catch {
        /* lock vanished: retry */
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for CLI build lock ${lock}`);
      sleepSync(250);
      if (!buildIsStale()) {
        buildChecked = true;
        return;
      }
    }
  }
  try {
    // Another worker may have completed between our first stale check and lock acquisition.
    if (buildIsStale()) {
      // Build with the checked-in toolchain directly so the harness does not depend on a
      // package-manager shim being available in worker process PATHs.
      const steps = [
        {
          command: process.execPath,
          args: [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'],
          cwd: CLI_ROOT,
        },
        {
          command: process.execPath,
          args: [join(CLI_ROOT, 'scripts', 'bundle.mjs')],
          cwd: CLI_ROOT,
        },
      ];
      for (const step of steps) {
        const res = spawnSync(step.command, step.args, { cwd: step.cwd, encoding: 'utf8' });
        if (res.status !== 0) {
          buildFailure = new Error(
            `CLI build failed (exit ${res.status}):
${res.stdout}
${res.stderr}`,
          );
          throw buildFailure;
        }
      }
    }
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
  buildChecked = true;
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Extra / overriding environment variables (`undefined` deletes a key). */
  env?: Record<string, string | undefined>;
  /** Text piped to stdin. Default: stdin is an immediately-closed pipe (non-TTY). */
  input?: string;
  /** Working directory. Default: the sandbox `cwd`. */
  cwd?: string;
  /** Kill the process after this many ms. Default 60s. */
  timeoutMs?: number;
  /** Which shipped entry point to execute. Default `bin` (what `pnpm cli` runs). */
  entry?: 'bin' | 'bundle';
  /** Signal to send after `signalAfterMs`. */
  signal?: NodeJS.Signals;
  signalAfterMs?: number;
}

export interface RunResult {
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** stdout with ANSI escape sequences removed. */
  readonly out: string;
  /** stderr with ANSI escape sequences removed. */
  readonly err: string;
  /** stdout + stderr, ANSI-stripped, for `toContain`-style human assertions. */
  readonly all: string;
  /** Parse the whole of stdout as ONE JSON document, with a useful error. */
  json<T = unknown>(): T;
  /** Parse stdout as newline-delimited JSON (blank lines ignored). */
  ndjson<T = unknown>(): T[];
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');
export const hasAnsi = (text: string): boolean => {
  ANSI_RE.lastIndex = 0;
  return ANSI_RE.test(text);
};

/** Provider credentials and config that must never leak from the dev machine. */
const SCRUBBED_ENV_KEYS = [
  'KILO_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ARK_API_KEY',
  'BYTEPLUS_API_KEY',
  'JOY_MEDIA_SQLITE_PATH',
  'JOY_CLI_DEBUG',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_OPTIONS',
  'NODE_NO_WARNINGS',
];

const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
];

export class Sandbox {
  /** Fake HOME (so `~/.joy-media` is private to this sandbox). */
  readonly home: string;
  /** Default working directory for runs (a "user's project folder"). */
  readonly cwd: string;
  private readonly root: string;
  private readonly baseEnv: Record<string, string>;

  constructor(label = 'sandbox') {
    this.root = mkdtempSync(join(tmpdir(), `joy-cli-${label}-`));
    this.home = join(this.root, 'home');
    this.cwd = join(this.root, 'work');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });

    const env: Record<string, string> = {};
    for (const key of PASSTHROUGH_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.HOME = this.home;
    env.USERPROFILE = this.home;
    env.APPDATA = join(this.home, 'AppData', 'Roaming');
    env.XDG_CONFIG_HOME = join(this.home, '.config');
    env.TMPDIR = join(this.root, 'tmp');
    mkdirSync(env.TMPDIR, { recursive: true });
    this.baseEnv = env;
  }

  /** Absolute path inside the sandbox working directory. */
  path(...parts: string[]): string {
    return join(this.cwd, ...parts);
  }

  /** `~/.joy-media` inside the sandbox HOME. */
  get joyDir(): string {
    return join(this.home, '.joy-media');
  }

  /** Environment a run would receive (useful for asserting on isolation). */
  env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const merged: Record<string, string | undefined> = { ...this.baseEnv };
    for (const key of SCRUBBED_ENV_KEYS) delete merged[key];
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  /** Run the CLI and resolve with everything a human would have seen. */
  run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    ensureCliBuilt();
    const entry = options.entry === 'bundle' ? BUNDLE_ENTRY : BIN_ENTRY;
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 60_000;

    return new Promise<RunResult>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: options.cwd ?? this.cwd,
        env: this.env(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      let signalTimer: ReturnType<typeof setTimeout> | undefined;
      if (options.signal) {
        signalTimer = setTimeout(() => child.kill(options.signal), options.signalAfterMs ?? 500);
      }

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        if (signalTimer) clearTimeout(signalTimer);
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        const result: RunResult = {
          args,
          code,
          signal,
          timedOut,
          stdout: out,
          stderr: err,
          durationMs: Date.now() - startedAt,
          out: stripAnsi(out),
          err: stripAnsi(err),
          all: stripAnsi(`${out}\n${err}`),
          json<T>(): T {
            try {
              return JSON.parse(out) as T;
            } catch (error) {
              throw new Error(
                `stdout of \`joy-media ${args.join(' ')}\` is not a single JSON document ` +
                  `(${(error as Error).message}).\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
              );
            }
          },
          ndjson<T>(): T[] {
            return out
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .map((line, index) => {
                try {
                  return JSON.parse(line) as T;
                } catch (error) {
                  throw new Error(
                    `stdout line ${index + 1} of \`joy-media ${args.join(' ')}\` is not JSON ` +
                      `(${(error as Error).message}): ${line}`,
                  );
                }
              });
          },
        };
        resolvePromise(result);
      });

      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
    });
  }

  cleanup(): void {
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Create a sandbox. Use with `afterEach`/`afterAll`:
 *
 *   const sb = useSandbox();           // inside describe(): creates per-test sandbox
 */
export function createSandbox(label?: string): Sandbox {
  return new Sandbox(label);
}

/** Human-readable failure context to attach to assertions. */
export function describeRun(result: RunResult): string {
  return `\n$ joy-media ${result.args.join(' ')}\n[exit ${result.code}${
    result.signal ? ` signal ${result.signal}` : ''
  }${result.timedOut ? ' TIMED OUT' : ''}]\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`;
}
