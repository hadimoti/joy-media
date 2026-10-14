/* global process, setTimeout, clearTimeout, Buffer */
/**
 * Scenario helpers for the `render` / `benchmark` humanized e2e tests.
 *
 * Everything here drives the REAL built binary through the shared black-box
 * harness (`harness.ts`, which this file must not modify). Projects are built
 * the way a person would: `project create` + `timeline add-clip` for the happy
 * path, or a hand-written project JSON file when a test needs a shape the CLI
 * will not produce (odd frame rates, hostile ids, corrupt durations).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect } from 'vitest';
import {
  CLI_ROOT,
  describeRun,
  ensureCliBuilt,
  hasAnsi,
  stripAnsi,
  type RunResult,
  type Sandbox,
} from './harness.js';

// ---------------------------------------------------------------------------
// Event + manifest shapes (loose on purpose: tests assert what a user sees)
// ---------------------------------------------------------------------------

export interface RenderEventLine {
  type: string;
  projectId?: string;
  [key: string]: unknown;
}

export interface ManifestClip {
  clipId: string;
  trackId: string;
  frames: number;
  frameRange: { first: number; last: number };
  startUs: number | null;
  durationUs: number;
}

export interface RenderManifest {
  schemaVersion: number;
  format: string;
  mediaProduced: boolean;
  mediaFile: string | null;
  note: string;
  projectId: string;
  projectTitle: string;
  preset: string;
  spec: {
    id: string;
    container: string;
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    fps: number;
    extension: string;
  };
  composition: {
    id: string;
    width: number | null;
    height: number | null;
    fps: number | null;
    durationUs: number | null;
  };
  totalFrames: number;
  totalClips: number;
  durationMs: number;
  renderedAt: string;
  warnings: string[];
  clips: ManifestClip[];
}

// ---------------------------------------------------------------------------
// Building projects
// ---------------------------------------------------------------------------

export interface TimelineClipSpec {
  readonly durationSec: number;
  /** Omit for "starts at 0" (`--start 0` is rejected by the CLI today). */
  readonly startSec?: number;
  /** Default `track-v1`. */
  readonly track?: string;
}

export interface BuiltProject {
  readonly id: string;
  readonly title: string;
  readonly clips: ReadonlyArray<TimelineClipSpec & { readonly id: string; readonly track: string }>;
}

function mustSucceed(result: RunResult, what: string): RunResult {
  if (result.code !== 0) {
    throw new Error(`setup step failed (${what}):${describeRun(result)}`);
  }
  return result;
}

/** `project create` + one `timeline add-clip` per clip, through the real CLI. */
export async function buildProjectViaCli(
  sb: Sandbox,
  title: string,
  clips: readonly TimelineClipSpec[] = [],
): Promise<BuiltProject> {
  const created = mustSucceed(await sb.run(['project', 'create', title]), 'project create');
  const idMatch = /\((proj-[a-z0-9]+(?:-[a-z0-9]+)*)\)/.exec(created.out);
  if (!idMatch) throw new Error(`could not find a project id in:${describeRun(created)}`);
  const id = idMatch[1]!;

  const added: Array<TimelineClipSpec & { id: string; track: string }> = [];
  for (const clip of clips) {
    const track = clip.track ?? 'track-v1';
    const args = [
      'timeline',
      'add-clip',
      '--project',
      id,
      '--track',
      track,
      '--duration',
      String(clip.durationSec),
    ];
    if (clip.startSec !== undefined) args.push('--start', String(clip.startSec));
    const result = mustSucceed(await sb.run(args), `timeline add-clip ${JSON.stringify(clip)}`);
    const clipMatch = /clip (clip-[a-z0-9]+)/.exec(result.out);
    if (!clipMatch) throw new Error(`could not find a clip id in:${describeRun(result)}`);
    added.push({ ...clip, id: clipMatch[1]!, track });
  }
  return { id, title, clips: added };
}

export interface DocClip {
  readonly id: string;
  readonly startUs?: number | undefined;
  /** Anything goes: tests feed the renderer corrupt values on purpose. */
  readonly durationUs?: unknown;
}

export interface DocTrack {
  readonly id: string;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly family?: 'visual' | 'audio';
  readonly clips: readonly DocClip[];
}

export interface ProjectDocOptions {
  readonly id?: string;
  /** Leave the project without any `id` (a hand-edited / truncated document). */
  readonly omitId?: boolean;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  /** Frames per second as a rational, e.g. `{ num: 60000, den: 1001 }`. */
  readonly frameRate?: { num: number; den: number };
  readonly tracks?: readonly DocTrack[];
  readonly rootCompositionId?: string;
}

/** A project document in the shape `joy-media project export` writes (loadable via `--project file.json`). */
export function projectDoc(options: ProjectDocOptions = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    title: options.title ?? 'Hand written project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rootCompositionId: options.rootCompositionId ?? 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Main Composition',
        width: options.width ?? 1080,
        height: options.height ?? 1920,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: options.frameRate ?? { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: (options.tracks ?? []).map((track, order) => ({
          id: track.id,
          kind: 'video',
          family: track.family ?? 'visual',
          name: track.name ?? track.id,
          order,
          enabled: track.enabled ?? true,
          locked: false,
          clips: track.clips.map((clip) => ({
            id: clip.id,
            kind: 'video',
            assetId: 'asset-default',
            startUs: clip.startUs ?? 0,
            durationUs: clip.durationUs,
            sourceInUs: 0,
          })),
        })),
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
  };
  if (!options.omitId) doc.id = options.id ?? 'hand-written';
  return doc;
}

/** Write `content` (object => JSON) into the sandbox working directory; returns the absolute path. */
export function writeSandboxFile(sb: Sandbox, name: string, content: unknown): string {
  const path = sb.path(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// Reading what a run produced
// ---------------------------------------------------------------------------

/** Every file under `dir` as sorted POSIX-style relative paths (`[]` if `dir` does not exist). */
export function listTree(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return found.sort();
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readManifest(path: string): RenderManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as RenderManifest;
}

/** A manifest minus the two fields that legitimately differ between identical renders. */
export function stableManifest(
  manifest: RenderManifest,
): Omit<RenderManifest, 'durationMs' | 'renderedAt'> {
  const { durationMs: _durationMs, renderedAt: _renderedAt, ...rest } = manifest;
  return rest;
}

/** Events minus timestamps/timings, for "same render, same story" comparisons. */
export function stableEvents(events: readonly RenderEventLine[]): unknown[] {
  return events.map((event) => {
    const { ts: _ts, durationMs: _durationMs, ...rest } = event;
    return rest;
  });
}

/** Frames the renderer allots a clip of `durationUs` at `fps` (at least one frame). */
export function expectedFrames(durationUs: number, fps = 30): number {
  return Math.max(1, Math.round((durationUs / 1_000_000) * fps));
}

// ---------------------------------------------------------------------------
// The `--json` contract an AI agent depends on
// ---------------------------------------------------------------------------

/**
 * Assert the NDJSON stream contract and return the parsed events:
 * stdout is only JSON objects (one per line, no banner / ANSI / progress bar),
 * every event has a `type`, the LAST event is `complete` or `error`, and the
 * process exit code agrees with it (`complete` <=> 0).
 */
export function expectNdjsonContract(
  result: RunResult,
  terminal: readonly string[] = ['complete', 'error'],
): RenderEventLine[] {
  const where = describeRun(result);
  expect(result.timedOut, `timed out${where}`).toBe(false);
  expect(hasAnsi(result.stdout), `ANSI escape codes on stdout${where}`).toBe(false);
  expect(result.stdout.includes('\r'), `carriage returns (progress bar) on stdout${where}`).toBe(
    false,
  );
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    expect(line.trimStart().startsWith('{'), `non-JSON line on stdout: ${line}${where}`).toBe(true);
  }
  const events = result.ndjson<RenderEventLine>();
  expect(events.length, `stdout has no events at all${where}`).toBeGreaterThan(0);
  for (const event of events) {
    expect(typeof event.type, `event without a type: ${JSON.stringify(event)}${where}`).toBe(
      'string',
    );
  }
  const last = events[events.length - 1]!;
  expect(terminal, `last event is "${last.type}"${where}`).toContain(last.type);
  if (last.type === 'complete') expect(result.code, where).toBe(0);
  if (last.type === 'error') expect(result.code, where).not.toBe(0);
  return events;
}

export function eventsOfType(events: readonly RenderEventLine[], type: string): RenderEventLine[] {
  return events.filter((event) => event.type === type);
}

// ---------------------------------------------------------------------------
// Things the shared harness cannot do (reported as harness limitations)
// ---------------------------------------------------------------------------

/**
 * Run the CLI with stdin left OPEN (the harness always closes it immediately),
 * to prove a command never waits for input. Resolves with the exit code, or
 * `'hung'` if the process had to be killed after `timeoutMs`.
 */
export function runWithOpenStdin(
  sb: Sandbox,
  args: readonly string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; outcome: 'exited' | 'hung'; stdout: string }> {
  ensureCliBuilt();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(CLI_ROOT, 'bin', 'joy-media.mjs'), ...args], {
      cwd: sb.cwd,
      env: sb.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', () => undefined);
    child.on('error', reject);
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        outcome: hung ? 'hung' : 'exited',
        stdout: Buffer.concat(out).toString('utf8'),
      });
    });
    // Deliberately never write to or end `child.stdin`.
  });
}

/** Send a signal as soon as the real binary emits its first output. */
export function runAndSignalAfterOutput(
  sb: Sandbox,
  args: readonly string[],
  signal: NodeJS.Signals,
  timeoutMs = 15_000,
): Promise<RunResult> {
  ensureCliBuilt();
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(CLI_ROOT, 'bin', 'joy-media.mjs'), ...args], {
      cwd: sb.cwd,
      env: sb.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let signalled = false;
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (!signalled) {
        signalled = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code, closedSignal) => {
      clearTimeout(killTimer);
      const rawOut = Buffer.concat(stdout).toString('utf8');
      const rawErr = Buffer.concat(stderr).toString('utf8');
      const out = stripAnsi(rawOut);
      const err = stripAnsi(rawErr);
      resolvePromise({
        args,
        code,
        signal: closedSignal,
        timedOut,
        stdout: rawOut,
        stderr: rawErr,
        durationMs: Date.now() - startedAt,
        out,
        err,
        all: stripAnsi(`${rawOut}\n${rawErr}`),
        json<T = unknown>(): T {
          return JSON.parse(rawOut) as T;
        },
        ndjson<T = unknown>(): T[] {
          return rawOut
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => JSON.parse(line) as T);
        },
      });
    });
    child.stdin.end();
  });
}
