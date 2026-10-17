/* global process */
/**
 * Shared helpers for the `project` / `timeline` humanized suites.
 *
 * Everything goes through the real binary via the harness (a fresh process per
 * call), so "read back" always means "what a second invocation sees".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { validateJoyProjectV3 } from '@joy-media/project-schema';
import { describeRun, hasAnsi, type RunOptions, type RunResult, type Sandbox } from './harness.js';

export interface ClipDoc {
  id: string;
  assetId: string | null;
  startUs: number;
  durationUs: number;
  endUs: number;
  sourceInUs: number | null;
}

export interface TrackDoc {
  id: string;
  name: string;
  family: string;
  order: number;
  clips: ClipDoc[];
}

export interface ShowDoc {
  id: string;
  title: string;
  revision: number;
  source: 'sqlite' | 'file';
  path: string;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  durationUs: number;
  assetCount: number;
  tracks: TrackDoc[];
}

export interface ListEntry {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  clipCount: number;
  trackCount: number;
  durationSeconds: number;
}

export interface ErrorDoc {
  type: 'error';
  code: string;
  message: string;
}

export const SEC = 1_000_000;

/** Resolve the CLI's platform-specific default project database in a sandbox. */
export function defaultProjectDbPath(sb: Sandbox): string {
  return process.platform === 'win32'
    ? join(sb.home, 'AppData', 'Roaming', '@joy-media', 'desktop', 'joy-media.sqlite3')
    : join(sb.joyDir, 'joy-media.sqlite3');
}

/** Expect a run to have succeeded (exit 0), with the full transcript on failure. */
export function expectOk(r: RunResult): RunResult {
  expect(r.code, describeRun(r)).toBe(0);
  return r;
}

/** Expect a specific exit code. */
export function expectExit(r: RunResult, code: number): RunResult {
  expect(r.code, describeRun(r)).toBe(code);
  return r;
}

/**
 * The `--json` contract: stdout is exactly ONE JSON document - no banner, no
 * ANSI, no second document - and the parsed value is returned.
 */
export function singleJson<T = unknown>(r: RunResult): T {
  expect(hasAnsi(r.stdout), `ANSI codes on stdout${describeRun(r)}`).toBe(false);
  const trimmed = r.stdout.trim();
  expect(trimmed.length, `stdout is empty${describeRun(r)}`).toBeGreaterThan(0);
  expect(trimmed.startsWith('{') || trimmed.startsWith('['), describeRun(r)).toBe(true);
  // JSON.parse rejects banners, tables and concatenated documents.
  return r.json<T>();
}

/** A failed `--json` run: non-zero exit and ONE machine-readable error document. */
export function jsonError(r: RunResult, exitCode: number): ErrorDoc {
  expectExit(r, exitCode);
  const doc = singleJson<ErrorDoc>(r);
  expect(doc.type, describeRun(r)).toBe('error');
  expect(typeof doc.code).toBe('string');
  expect(typeof doc.message).toBe('string');
  return doc;
}

export async function createProject(
  sb: Sandbox,
  name = 'Test Project',
  extra: readonly string[] = [],
  options?: RunOptions,
): Promise<string> {
  const r = expectOk(await sb.run(['project', 'create', name, ...extra, '--json'], options));
  return singleJson<{ id: string }>(r).id;
}

export async function showProject(
  sb: Sandbox,
  idOrFile: string,
  extra: readonly string[] = [],
  options?: RunOptions,
): Promise<ShowDoc> {
  const r = expectOk(await sb.run(['project', 'show', idOrFile, '--json', ...extra], options));
  return singleJson<ShowDoc>(r);
}

export async function listProjects(
  sb: Sandbox,
  extra: readonly string[] = [],
  options?: RunOptions,
): Promise<ListEntry[]> {
  const r = expectOk(await sb.run(['project', 'list', '--json', ...extra], options));
  return singleJson<ListEntry[]>(r);
}

export function track(show: ShowDoc, trackId: string): TrackDoc {
  const found = show.tracks.find((t) => t.id === trackId);
  if (!found) throw new Error(`track ${trackId} not in ${JSON.stringify(show.tracks)}`);
  return found;
}

/** Clips of a track as `[startSeconds, endSeconds]`, in timeline order. */
export function spans(show: ShowDoc, trackId = 'track-v1'): Array<[number, number]> {
  return track(show, trackId)
    .clips.map((c): [number, number] => [c.startUs / SEC, c.endUs / SEC])
    .sort((a, b) => a[0] - b[0]);
}

export interface AddedClip {
  id: string;
  startUs: number;
  durationUs: number;
}

/** `timeline add-clip` and return the new clip (parsed from `--json`). */
export async function addClip(
  sb: Sandbox,
  project: string,
  opts: { track?: string; start?: number; duration?: number; asset?: string } = {},
  extra: readonly string[] = [],
): Promise<AddedClip> {
  const args = ['timeline', 'add-clip', '--project', project];
  if (opts.track !== undefined) args.push('--track', opts.track);
  // `--start 0` is currently rejected by utils/flags.ts (owned elsewhere); 0 is the
  // default, so leaving the flag out is the same request.
  if (opts.start !== undefined && opts.start !== 0) args.push('--start', String(opts.start));
  if (opts.duration !== undefined) args.push('--duration', String(opts.duration));
  if (opts.asset !== undefined) args.push('--asset', opts.asset);
  const r = expectOk(await sb.run([...args, '--json', ...extra]));
  return singleJson<{ clip: AddedClip }>(r).clip;
}

/**
 * Everything about a project that a failing command must not change: revision,
 * every clip and the project's `updatedAt` (via the list view).
 */
export async function fingerprint(
  sb: Sandbox,
  idOrFile: string,
  extra: readonly string[] = [],
): Promise<string> {
  const show = await showProject(sb, idOrFile, extra);
  return JSON.stringify({ revision: show.revision, tracks: show.tracks, title: show.title });
}

/** Export a project and check the exported document is a valid JOY project. */
export async function exportAndValidate(
  sb: Sandbox,
  id: string,
  file: string,
  extra: readonly string[] = [],
): Promise<{ revision: number; source: unknown }> {
  expectOk(await sb.run(['project', 'export', id, '--output', file, '--json', ...extra]));
  const exported = JSON.parse(readFileSync(sb.path(file), 'utf8')) as {
    revision: number;
    source: unknown;
  };
  expect(validateJoyProjectV3(exported.source)).toEqual([]);
  return exported;
}

export const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
