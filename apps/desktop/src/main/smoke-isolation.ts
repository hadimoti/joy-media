import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Isolation for `--smoke` runs. A smoke run has to show that the app starts without touching the
 * user's real JOY Media data, without registering the `joy://` protocol and without changing
 * anything else in the Windows profile. This module plans where a smoke run keeps its data and
 * checks that the plan is safe. It imports nothing from Electron, so the rules are unit-tested.
 * electron-entry.ts applies the plan before it reads any data path.
 */

/** The command-line flag that selects an isolated smoke run. */
export const SMOKE_ARGUMENT = '--smoke';

const PROFILE_PREFIX = 'joy-media-smoke-';
const MARKER_FILE = 'smoke-profile.json';
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Everything one smoke run may write. Every path below is inside `root`. */
export interface SmokeProfile {
  /** The OS temp folder the run folder was created in, as reported before any override. */
  readonly tempRoot: string;
  readonly nonce: string;
  readonly root: string;
  readonly marker: string;
  readonly userData: string;
  readonly sessionData: string;
  readonly logs: string;
  readonly crashDumps: string;
  readonly downloads: string;
  readonly appData: string;
  readonly home: string;
  readonly localAppData: string;
  readonly temp: string;
  /** The default asset library a smoke run would use: under the run's home, never the real one. */
  readonly assetLibrary: string;
}

export interface PlanSmokeProfileInput {
  /** The OS temp folder, as Node reports it before any override. Must be absolute. */
  readonly tempRoot: string;
  /** 32 lowercase hex characters, unique per run. */
  readonly nonce: string;
  /** Real locations a smoke run must never write into: the user's app data, the install folder. */
  readonly protectedPaths: readonly string[];
}

export type SmokeCleanupResult =
  { readonly removed: true } | { readonly removed: false; readonly reason: string };

export class SmokeIsolationError extends Error {}

/** True when the command line selects a smoke run. Only the exact flag counts. */
export function isSmokeRun(argv: readonly string[]): boolean {
  return argv.includes(SMOKE_ARGUMENT);
}

/**
 * Set by smoke-supervisor.mjs: the nonce that names this run's profile folder, so the supervisor knows which folder to
 * clean up when the app has exited.
 */
export const SMOKE_NONCE_ENVIRONMENT = 'JOY_MEDIA_SMOKE_NONCE';

/**
 * Set to 1 by smoke-supervisor.mjs: an external process removes the profile once this process and the processes it
 * started have exited. This process cannot wait for its own exit, so it must not try to delete the profile itself.
 */
export const SMOKE_SUPERVISED_ENVIRONMENT = 'JOY_MEDIA_SMOKE_SUPERVISED';

/**
 * The run's nonce: the one the supervisor passed in, or a fresh one. A value that is set but malformed refuses the
 * run instead of choosing another folder without saying so.
 */
export function smokeNonceFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  fresh: () => string,
): string {
  const supplied = env[SMOKE_NONCE_ENVIRONMENT];
  if (supplied === undefined || supplied === '') return fresh();
  if (!NONCE_PATTERN.test(supplied)) {
    throw new SmokeIsolationError(`${SMOKE_NONCE_ENVIRONMENT} must be 32 lowercase hex characters`);
  }
  return supplied;
}

/** True when a supervisor removes this run's profile, so the app leaves it in place when it exits. */
export function isSupervisedSmokeRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SMOKE_SUPERVISED_ENVIRONMENT] === '1';
}

/**
 * Plans the profile for one run: a new folder directly under the temp root, named with the nonce.
 * Throws when the plan would touch a protected location, so a TEMP setting that points into the
 * user's data refuses the run instead of letting it write there.
 */
export function planSmokeProfile(input: PlanSmokeProfileInput): SmokeProfile {
  if (!path.isAbsolute(input.tempRoot)) {
    throw new SmokeIsolationError('the smoke temp root must be an absolute path');
  }
  if (!NONCE_PATTERN.test(input.nonce)) {
    throw new SmokeIsolationError('the smoke nonce must be 32 lowercase hex characters');
  }
  const tempRoot = path.resolve(input.tempRoot);
  const root = path.join(tempRoot, `${PROFILE_PREFIX}${input.nonce}`);
  for (const protectedPath of input.protectedPaths) {
    // The temp root may sit inside an install folder that is only read; that is allowed. What is
    // not allowed is a temp root inside protected data, or a run folder that overlaps one.
    if (isInside(tempRoot, protectedPath) || overlaps(root, protectedPath)) {
      throw new SmokeIsolationError(`the smoke profile would overlap ${protectedPath}`);
    }
  }
  const home = path.join(root, 'home');
  return {
    tempRoot,
    nonce: input.nonce,
    root,
    marker: path.join(root, MARKER_FILE),
    userData: path.join(root, 'user-data'),
    sessionData: path.join(root, 'session-data'),
    logs: path.join(root, 'logs'),
    crashDumps: path.join(root, 'crash-dumps'),
    downloads: path.join(root, 'downloads'),
    appData: path.join(root, 'app-data'),
    home,
    localAppData: path.join(root, 'local-app-data'),
    temp: path.join(root, 'temp'),
    assetLibrary: path.join(home, 'joy-media-assets'),
  };
}

/**
 * Environment variables that Node and Chromium read for profile and temp locations. Redirecting
 * them is a second layer: it catches a library that builds a path from them instead of from Electron.
 */
export function smokeEnvironment(profile: SmokeProfile): Readonly<Record<string, string>> {
  return {
    USERPROFILE: profile.home,
    HOME: profile.home,
    APPDATA: profile.appData,
    LOCALAPPDATA: profile.localAppData,
    TEMP: profile.temp,
    TMP: profile.temp,
  };
}

/** The `app.setPath` overrides a smoke run applies, as [name, folder] pairs. */
export function smokePathOverrides(profile: SmokeProfile): readonly (readonly [string, string])[] {
  return [
    ['userData', profile.userData],
    ['sessionData', profile.sessionData],
    ['logs', profile.logs],
    ['crashDumps', profile.crashDumps],
    ['downloads', profile.downloads],
    ['temp', profile.temp],
    ['appData', profile.appData],
  ];
}

/** True when two paths name the same folder. Case follows the host platform's rules. */
export function sameLocation(first: string, second: string): boolean {
  return path.relative(path.resolve(first), path.resolve(second)) === '';
}

/**
 * Creates the run folder, every folder the run may use, and the marker that lets cleanup prove
 * the folder is its own. The run folder itself is created without `recursive`, so an existing
 * folder is an error: a smoke run never reuses or adopts a folder that it did not just create.
 */
export function createSmokeProfile(profile: SmokeProfile): void {
  mkdirSync(profile.root);
  for (const directory of smokeDirectories(profile)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(profile.marker, `${JSON.stringify({ nonce: profile.nonce })}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

/**
 * Deletes the run folder and only that. The folder must be the child of the temp root that the plan
 * named, and its marker must carry the same nonce. Anything else stays in place and is reported.
 */
export function removeSmokeProfile(profile: SmokeProfile): SmokeCleanupResult {
  const expectedName = `${PROFILE_PREFIX}${profile.nonce}`;
  if (
    path.basename(profile.root) !== expectedName ||
    !sameLocation(path.dirname(profile.root), profile.tempRoot)
  ) {
    return { removed: false, reason: 'the profile folder is not the one this run created' };
  }
  if (!markerMatches(profile)) {
    return { removed: false, reason: 'the profile marker is missing or belongs to another run' };
  }
  try {
    rmSync(profile.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return { removed: false, reason: `deleting the profile failed: ${detail}` };
  }
  return existsSync(profile.root)
    ? { removed: false, reason: 'the profile folder is still present after deletion' }
    : { removed: true };
}

/** Every folder a smoke run uses. Electron requires an overridden folder to exist first. */
function smokeDirectories(profile: SmokeProfile): readonly string[] {
  return [
    profile.userData,
    profile.sessionData,
    profile.logs,
    profile.crashDumps,
    profile.downloads,
    profile.appData,
    profile.home,
    profile.localAppData,
    profile.temp,
  ];
}

function markerMatches(profile: SmokeProfile): boolean {
  if (!existsSync(profile.marker)) return false;
  try {
    const marker = JSON.parse(readFileSync(profile.marker, 'utf8')) as { nonce?: unknown };
    return marker.nonce === profile.nonce;
  } catch {
    return false;
  }
}

function overlaps(first: string, second: string): boolean {
  return isInside(first, second) || isInside(second, first);
}

/** True when `child` is `parent` or lies below it. */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
