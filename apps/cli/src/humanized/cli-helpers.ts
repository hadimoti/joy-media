/* global process, Buffer, setTimeout, clearTimeout */
/**
 * Extra black-box helpers for the CLI-shell contract tests (process lifecycle,
 * TTY/colour, local HTTP servers, fake tools on PATH). Built on `harness.ts`;
 * nothing here talks to the real internet.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { CLI_ROOT, ensureCliBuilt, stripAnsi, type Sandbox } from './harness.js';

export type Entry = 'bin' | 'bundle';
export const ENTRIES: readonly Entry[] = ['bin', 'bundle'];

export function entryPath(entry: Entry): string {
  return entry === 'bundle'
    ? join(CLI_ROOT, 'dist', 'joy-media-bundle.mjs')
    : join(CLI_ROOT, 'bin', 'joy-media.mjs');
}

// ---------------------------------------------------------------------------
// Local HTTP servers (stand-ins for the production edge)
// ---------------------------------------------------------------------------

export interface LocalServer {
  readonly url: string;
  /** Resolves when the first request arrives (i.e. the CLI is now waiting on us). */
  readonly firstHit: Promise<void>;
  hits(): number;
  close(): Promise<void>;
}

/**
 * Start a server on 127.0.0.1. Without a handler, requests are accepted and
 * NEVER answered: a hung network peer.
 */
export async function startServer(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LocalServer> {
  let hits = 0;
  let markHit: () => void = () => undefined;
  const firstHit = new Promise<void>((resolve) => {
    markHit = resolve;
  });
  const server = createServer((req, res) => {
    hits++;
    markHit();
    handler?.(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/ready`,
    firstHit,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A URL on a port nothing listens on: connections are refused immediately. */
export async function refusedUrl(): Promise<string> {
  const server = await startServer();
  const url = server.url;
  await server.close();
  return url;
}

// ---------------------------------------------------------------------------
// Fine-grained process control (the harness covers the common case)
// ---------------------------------------------------------------------------

export interface RawRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly out: string;
  readonly err: string;
}

export interface SpawnCliOptions {
  readonly entry?: Entry;
  /** Run this file instead of a shipped entry point. */
  readonly entryFile?: string;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Leave stdin as an open pipe that never delivers data or EOF. */
  readonly keepStdinOpen?: boolean;
  /** Close our read end of the child's stdout right away (`| head -0`). */
  readonly closeStdoutImmediately?: boolean;
  /** Called once the child exists, e.g. to send it a signal at the right moment. */
  readonly onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  readonly timeoutMs?: number;
}

export function spawnCli(
  sb: Sandbox,
  args: readonly string[],
  options: SpawnCliOptions = {},
): Promise<RawRun> {
  ensureCliBuilt();
  const file = options.entryFile ?? entryPath(options.entry ?? 'bin');
  return new Promise<RawRun>((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: options.cwd ?? sb.cwd,
      env: sb.env(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (options.closeStdoutImmediately) {
      child.stdout.destroy();
    } else {
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    }
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    if (!options.keepStdinOpen) child.stdin.end();
    options.onSpawn?.(child);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      resolve({ code, signal, stdout: out, stderr: err, out: stripAnsi(out), err: stripAnsi(err) });
    });
  });
}

export function describeRaw(args: readonly string[], r: RawRun): string {
  return `\n$ joy-media ${args.join(' ')}\n[exit ${r.code}${r.signal ? ` signal ${r.signal}` : ''}]\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`;
}

// ---------------------------------------------------------------------------
// Fake tools and files
// ---------------------------------------------------------------------------

/** Write an executable POSIX shell script (creating parent directories). */
export function writeExecutable(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

export const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Pseudo-terminal (util-linux `script`) for TTY-dependent behaviour
// ---------------------------------------------------------------------------

export const ptyAvailable: boolean =
  process.platform === 'linux' &&
  spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface PtyRun {
  readonly code: number | null;
  /** Everything written to the terminal (stdout and stderr when not redirected). */
  readonly terminal: string;
}

/**
 * Run the CLI on a pseudo-terminal. `redirect` is appended verbatim to the
 * shell command (e.g. `2>/path/err.txt` or `| cat`), so a single stream can be
 * taken off the TTY.
 */
export function runInPty(
  sb: Sandbox,
  args: readonly string[],
  options: { entry?: Entry; env?: Record<string, string | undefined>; redirect?: string } = {},
): Promise<PtyRun> {
  ensureCliBuilt();
  const command = [process.execPath, entryPath(options.entry ?? 'bin'), ...args]
    .map(shellQuote)
    .join(' ');
  const full = `${command} ${options.redirect ?? ''}`;
  return new Promise<PtyRun>((resolve, reject) => {
    const child = spawn('script', ['-qec', full, '/dev/null'], {
      cwd: sb.cwd,
      env: { ...sb.env(options.env), TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, terminal: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.end();
  });
}

/** Make `dir` exist and return it. */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
