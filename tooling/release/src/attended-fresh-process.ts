/**
 * The fresh-process persistence scenario (`project.persistence.fresh-process`).
 *
 * The first process starts in a new profile, creates a project, imports a clip, and exports the project
 * as an editable package. The second process starts in another new profile, imports that package, and
 * renders the imported project to an MP4 that ffprobe reads back. Neither profile is the owner's, and
 * nothing is copied from the owner's profile. This file does no I/O: the machine side is the
 * FreshProcessDriver implemented in tooling/release/attended/scenario-driver.mjs.
 */
import { Buffer } from 'node:buffer';
import {
  ATTENDED_RECEIPT_SCHEMA,
  REQUIRED_ATTENDED_CHECKS,
  validateAttendedReceipt,
  type AttendedArtifact,
  type AttendedCheck,
  type AttendedReceipt,
} from './attended-receipt.ts';
import {
  StepFailure,
  guardBlockers,
  readGuards,
  sha256Hex,
  type AppHandle,
  type GuardDriver,
  type GuardReadings,
  type MediaProbe,
  type ScenarioStep,
  type ScenarioVerdict,
} from './attended-scenario.ts';

export const FRESH_PROCESS_SCENARIO = 'project.persistence.fresh-process' as const;
export const PACKAGE_FILE_NAME = 'export-package.joyproject.json';
export const RENDER_FILE_NAME = 'export.mp4';

/** The browser storage keys the editor writes: the project catalog and the timeline and visual logs. */
export const CATALOG_KEY = 'joy-media.project-catalog.v1';
export const TIMELINE_LOG_KEY = 'joy-media.timeline-project-log.v1';
export const VISUAL_LOG_KEY = 'joy-media.visual-object-project-log.v1';

const PACKAGE_FORMAT = 'joy-media-project';

export interface FreshNames {
  readonly sourceTitle: string;
  readonly hostTitle: string;
  readonly clipName: string;
}

/** The names a run uses. They come from the run id, so two runs never share a project or a clip. */
export function freshNames(runId: string): FreshNames {
  const short = runId.replace(/[^0-9a-z]/giu, '').slice(0, 8);
  return {
    sourceTitle: `FreshProcess-${short}`,
    hostTitle: `FreshProcessHost-${short}`,
    clipName: `fresh-process-${short}.mp4`,
  };
}

/** A page of the editor, as the scenario uses it. The machine side maps each call onto the real UI. */
export interface FreshEditorPage {
  /** The library folder the app reports through the bridge. */
  libraryDirectory(): Promise<string>;
  /** Waits until the project library shows its New project control. */
  waitForLibrary(): Promise<void>;
  /** Creates a project with this name and waits until the editor's File menu is shown. */
  createProject(title: string): Promise<void>;
  /** Imports a clip into the open project and adds it to the timeline. */
  importClip(name: string, bytes: Uint8Array): Promise<void>;
  /** The timeline clips whose label starts with the clip name. */
  timelineClipCount(name: string): Promise<number>;
  /** File > Export Editable Project…; resolves with the package file the app produced. */
  exportEditablePackage(): Promise<Uint8Array>;
  /**
   * Gives the package to the open project's import control without the native chooser. Resolves with
   * the notice the app shows, or an empty text when it shows none.
   */
  importEditablePackage(name: string, bytes: Uint8Array): Promise<string>;
  /** The title of the project the editor has open, or null when none is open. */
  activeProjectTitle(): Promise<string | null>;
  /** The browser storage values for these keys, or null for a key that is absent. */
  readStorage(keys: readonly string[]): Promise<Readonly<Record<string, string | null>>>;
  /** Export MP4, then the download of the verified file; resolves with the MP4 bytes. */
  renderMp4(): Promise<Uint8Array>;
  /** The page's visible text and a screenshot, taken when a step fails so the failure can be read afterwards. */
  snapshot(): Promise<{ readonly text: string; readonly png: Uint8Array }>;
}

/** The machine side of the scenario. The guard readings come from GuardDriver. */
export interface FreshProcessDriver extends GuardDriver {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Creates a new, empty profile folder whose database names the given asset library. */
  seedProfile(profile: string, library: string): Promise<void>;
  /** A signature of the owner's Downloads folder: its files, their sizes and newest write. A run must leave it unchanged. */
  downloadsSignature(): Promise<string>;
  /** Starts the candidate app on a profile with a debug port. */
  launch(attempt: number, profile: string): Promise<AppHandle>;
  /** Waits for the editor page of the process and returns it. */
  attach(app: AppHandle): Promise<FreshEditorPage>;
  isAlive(app: AppHandle): Promise<boolean>;
  /** Closes the window, waits for every JOY process to exit, and disconnects the page. */
  close(app: AppHandle, page: FreshEditorPage | undefined): Promise<void>;
  /** The clip the first process imports, read from the repository's test fixtures. */
  readClipFixture(): Promise<Uint8Array>;
  /** Probes a file in the run folder by its name. */
  probeMedia(name: string): Promise<MediaProbe>;
  /** Probes the clip the first process imports, so the render's duration can be compared with it. */
  probeClip(): Promise<MediaProbe>;
  /** Writes a file into the run folder. */
  writeRunFile(name: string, bytes: Uint8Array): Promise<void>;
}

export interface FreshProcessInput {
  readonly runId: string;
  readonly candidateSha: string;
  readonly exeSha256: string;
  readonly unpackedDir: string;
  /** The scratch asset library, which both profiles must name. */
  readonly library: string;
  /** New folders for the two profiles. Neither exists when the run starts. */
  readonly sourceProfile: string;
  readonly freshProfile: string;
}

export interface FreshProcessReport {
  readonly scenario: typeof FRESH_PROCESS_SCENARIO;
  readonly runId: string;
  readonly candidateSha: string;
  readonly verdict: ScenarioVerdict;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly launches: number;
  readonly before: GuardReadings;
  readonly after: GuardReadings | undefined;
  readonly checks: readonly AttendedCheck[];
  readonly steps: readonly ScenarioStep[];
  readonly blockers: readonly string[];
  readonly receipt: AttendedReceipt | undefined;
}

export interface PackageExpectation {
  readonly sourceTitle: string;
  readonly clipName: string;
  /** SHA-256 of the clip that was imported. The embedded copy must match it byte for byte. */
  readonly clipSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects when the work takes longer than the limit, so a snapshot cannot hold up the end of a run. */
function withTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${limitMs / 1000} seconds`)),
      limitMs,
    );
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Runs one step of a check. Any error becomes a failure of that check, with its message. */
async function stage<T>(check: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(check, describeError(error));
  }
}

/**
 * The library folder from a `desktop.asset-library.get-settings` reply. The preload hands back the
 * reply's data, so the reply is the library's info itself, with its `directory` field.
 */
export function libraryDirectoryOf(reply: unknown): string {
  const directory =
    typeof reply === 'object' && reply !== null && 'directory' in reply
      ? (reply as { readonly directory: unknown }).directory
      : undefined;
  if (typeof directory !== 'string' || directory === '') {
    throw new Error('the app reported no library folder');
  }
  return directory;
}

/**
 * The problems with an editable package that was exported from the first process. The package must be
 * JSON in the app's format, carry the project under its title, and embed the imported clip with the same
 * bytes. Every media entry must be embedded, because a missing file would not reach the second profile.
 */
export function packageProblems(bytes: Uint8Array, expected: PackageExpectation): string[] {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    return [`the package is not JSON: ${describeError(error)}`];
  }
  return packageBlockers(value, expected);
}

export function packageBlockers(value: unknown, expected: PackageExpectation): string[] {
  if (!isRecord(value)) return ['the package is not a JSON object'];
  const blockers: string[] = [];
  if (value.format !== PACKAGE_FORMAT)
    blockers.push(`the package format is ${String(value.format)}`);
  if (value.schemaVersion !== 1) blockers.push('the package schema version is not 1');
  if (value.app !== 'JOY Studio') blockers.push('the package was not written by JOY Studio');
  const source = isRecord(value.source) ? value.source : undefined;
  if (source === undefined || typeof source.id !== 'string' || source.id.trim() === '') {
    blockers.push('the package has no source project id');
  }
  if (source?.title !== expected.sourceTitle) {
    blockers.push(`the package is titled ${String(source?.title)}, not ${expected.sourceTitle}`);
  }
  const documents = isRecord(value.documents) ? value.documents : undefined;
  if (documents === undefined || !isRecord(documents.timeline) || !isRecord(documents.visual)) {
    blockers.push('the package is missing its timeline or visual document');
  }
  if (!Array.isArray(value.media)) {
    blockers.push('the package has no media list');
    return blockers;
  }
  let clip: { readonly id: unknown; readonly dataBase64: unknown } | undefined;
  for (const entry of value.media) {
    if (!isRecord(entry) || !isRecord(entry.asset)) {
      blockers.push('a media entry is malformed');
      continue;
    }
    const label = String(entry.asset.displayName);
    if (entry.status !== 'embedded') blockers.push(`media ${label} is ${String(entry.status)}`);
    if (entry.asset.displayName === expected.clipName && entry.status === 'embedded') {
      clip = { id: entry.asset.id, dataBase64: entry.dataBase64 };
    }
  }
  if (clip === undefined || typeof clip.dataBase64 !== 'string') {
    blockers.push(`the package does not embed ${expected.clipName}`);
    return blockers;
  }
  const embedded = new Uint8Array(Buffer.from(clip.dataBase64, 'base64'));
  if (sha256Hex(embedded) !== expected.clipSha256) {
    blockers.push(`the embedded ${expected.clipName} is not the clip that was imported`);
  }
  if (
    typeof clip.id !== 'string' ||
    !JSON.stringify(documents?.timeline ?? null).includes(clip.id)
  ) {
    blockers.push('the timeline does not reference the embedded clip');
  }
  return blockers;
}

/**
 * The problems with a render. The file must be an MP4 with a video stream of real size and a positive
 * duration. An audio stream is not required here: the export-semantics scenario checks the sound.
 */
export function renderBlockers(probe: MediaProbe): string[] {
  const blockers: string[] = [];
  if (!probe.formatName.split(',').includes('mp4')) {
    blockers.push(`the render is ${probe.formatName || 'an unknown container'}, not MP4`);
  }
  if (probe.videoStreams < 1 || probe.video === undefined) {
    blockers.push('the render has no video stream');
  } else if (!(probe.video.width > 0 && probe.video.height > 0)) {
    blockers.push('the render video has no size');
  }
  if (!(probe.durationSeconds > 0)) blockers.push('the render duration is not positive');
  return blockers;
}

/** How far the render's duration may differ from the clip's, in seconds (one frame at 30 fps is 0.033). */
const RENDER_DURATION_TOLERANCE_SECONDS = 0.5;

/**
 * The problems with a render that does not match the clip it was made from. The imported project holds
 * that one clip, so the render lasts as long as the clip does, to within the tolerance.
 */
export function renderMatchesClip(render: MediaProbe, clip: MediaProbe): string[] {
  if (!(clip.durationSeconds > 0)) {
    return ['the imported clip has no positive duration to compare the render with'];
  }
  if (
    !(Math.abs(render.durationSeconds - clip.durationSeconds) <= RENDER_DURATION_TOLERANCE_SECONDS)
  ) {
    return [
      `the render lasts ${render.durationSeconds.toFixed(3)} s, not the imported clip's ${clip.durationSeconds.toFixed(3)} s`,
    ];
  }
  return [];
}

type Stores = Readonly<Record<string, string | null | undefined>>;

/** The documents a stored log holds: the payload of the newest snapshot of each project. */
function documentsIn(serialized: string | null | undefined): Record<string, unknown>[] {
  if (typeof serialized !== 'string') return [];
  let database: unknown;
  try {
    database = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!isRecord(database) || !isRecord(database.projects)) return [];
  const documents: Record<string, unknown>[] = [];
  for (const project of Object.values(database.projects)) {
    if (!isRecord(project) || !Array.isArray(project.snapshots)) continue;
    const latest: unknown = project.snapshots[project.snapshots.length - 1];
    if (isRecord(latest) && isRecord(latest.payload)) documents.push(latest.payload);
  }
  return documents;
}

/** The asset ids a document uses: clips on its tracks, its timeline items, and its visual objects. */
function referencedAssetIds(document: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') ids.add(value);
  };
  if (isRecord(document.compositions)) {
    for (const composition of Object.values(document.compositions)) {
      if (!isRecord(composition) || !Array.isArray(composition.tracks)) continue;
      for (const track of composition.tracks) {
        if (!isRecord(track) || !Array.isArray(track.clips)) continue;
        for (const clip of track.clips) if (isRecord(clip)) add(clip.assetId);
      }
    }
  }
  if (isRecord(document.universalTimeline) && Array.isArray(document.universalTimeline.items)) {
    for (const item of document.universalTimeline.items) {
      if (isRecord(item) && isRecord(item.source)) add(item.source.id);
    }
  }
  if (isRecord(document.visualObjects)) {
    for (const element of Object.values(document.visualObjects)) {
      if (isRecord(element)) add(element.assetId);
    }
  }
  return ids;
}

/** The display names of a document's assets, keyed by asset id. */
function assetNamesIn(document: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  if (!isRecord(document.assets)) return names;
  for (const asset of Object.values(document.assets)) {
    if (isRecord(asset) && typeof asset.id === 'string' && typeof asset.displayName === 'string') {
      names.set(asset.id, asset.displayName);
    }
  }
  return names;
}

function storeHas(value: string | null | undefined, text: string): boolean {
  return typeof value === 'string' && value.includes(text);
}

/** The problems with the first process's saved state: the timeline names the clip, the catalog the project. */
export function sourceStoreBlockers(stores: Stores, names: FreshNames): string[] {
  const blockers: string[] = [];
  if (!storeHas(stores[TIMELINE_LOG_KEY], names.clipName)) {
    blockers.push(`the source profile's saved timeline does not hold ${names.clipName}`);
  }
  if (!storeHas(stores[CATALOG_KEY], names.sourceTitle)) {
    blockers.push(`the source profile's saved catalog does not hold ${names.sourceTitle}`);
  }
  return blockers;
}

/**
 * The problems with the second process's saved state. The catalog must hold the imported project, and
 * the stored timeline must reference an asset that is named after the imported clip.
 */
export function freshStoreBlockers(stores: Stores, names: FreshNames): string[] {
  const blockers: string[] = [];
  if (!storeHas(stores[CATALOG_KEY], names.sourceTitle)) {
    blockers.push(`the fresh profile's catalog does not hold ${names.sourceTitle}`);
  }
  const referenced = new Set<string>();
  const assetNames = new Map<string, string>();
  for (const document of [
    ...documentsIn(stores[TIMELINE_LOG_KEY]),
    ...documentsIn(stores[VISUAL_LOG_KEY]),
  ]) {
    for (const id of referencedAssetIds(document)) referenced.add(id);
    for (const [id, name] of assetNamesIn(document)) assetNames.set(id, name);
  }
  const named = [...assetNames].some(([id, name]) => name === names.clipName && referenced.has(id));
  if (!named)
    blockers.push(`the fresh profile does not store a timeline clip of ${names.clipName}`);
  return blockers;
}

function normalizeDirectory(path: string): string {
  return path.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
}

interface Session {
  readonly app: AppHandle;
  page: FreshEditorPage | undefined;
  closed: boolean;
}

interface LaunchedProcess {
  readonly session: Session;
  readonly page: FreshEditorPage;
}

interface Downloads {
  readonly signature?: string;
  readonly error?: string;
}

async function readDownloads(driver: FreshProcessDriver): Promise<Downloads> {
  try {
    return { signature: await driver.downloadsSignature() };
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** The required checks in contract order. A check that was never reached is reported as not run. */
function orderedChecks(
  results: ReadonlyMap<string, AttendedCheck>,
  required: readonly string[],
): AttendedCheck[] {
  return required.map((name): AttendedCheck => {
    const found = results.get(name);
    return found ?? { name, status: 'not-run', detail: 'not reached' };
  });
}

function buildFreshReceipt(
  input: FreshProcessInput,
  before: GuardReadings,
  after: GuardReadings,
  times: { readonly startedAt: string; readonly finishedAt: string },
  checks: readonly AttendedCheck[],
  artifacts: readonly AttendedArtifact[],
): AttendedReceipt {
  return {
    schema: ATTENDED_RECEIPT_SCHEMA,
    scenario: {
      id: FRESH_PROCESS_SCENARIO,
      status: 'passed',
      firstAttemptPassed: true,
      retries: 0,
    },
    candidateSha: input.candidateSha,
    app: { exeSha256: input.exeSha256, unpackedDir: input.unpackedDir },
    run: {
      id: input.runId,
      attempt: 1,
      startedAt: times.startedAt,
      finishedAt: times.finishedAt,
      operator: 'owner-at-pc',
      mode: 'scripted',
      manual: false,
    },
    guards: {
      joyKeyBefore: before.joyKeySha256,
      joyKeyAfter: after.joyKeySha256,
      ownerLibraryFilesBefore: before.ownerLibraryFiles,
      ownerLibraryFilesAfter: after.ownerLibraryFiles,
      installedFolderTouched: false,
    },
    checks: checks.map((check) => ({ name: check.name, status: 'passed', detail: check.detail })),
    artifacts,
  };
}

function freshReport(parts: {
  readonly verdict: ScenarioVerdict;
  readonly input: FreshProcessInput;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly launches: number;
  readonly before: GuardReadings;
  readonly after: GuardReadings | undefined;
  readonly results: ReadonlyMap<string, AttendedCheck>;
  readonly required: readonly string[];
  readonly steps: readonly ScenarioStep[];
  readonly blockers: readonly string[];
  readonly receipt: AttendedReceipt | undefined;
}): FreshProcessReport {
  return {
    scenario: FRESH_PROCESS_SCENARIO,
    runId: parts.input.runId,
    candidateSha: parts.input.candidateSha,
    verdict: parts.verdict,
    startedAt: parts.startedAt,
    finishedAt: parts.finishedAt,
    launches: parts.launches,
    before: parts.before,
    after: parts.after,
    checks: orderedChecks(parts.results, parts.required),
    steps: parts.steps,
    blockers: parts.blockers,
    receipt: parts.receipt,
  };
}

/**
 * Runs the fresh-process persistence scenario once. The result is a report. It carries a receipt only
 * when every required check passed, the guards held at every point, the Downloads folder was left as it
 * was, and the receipt passes the contract.
 */
export async function runFreshProcessPersistence(
  driver: FreshProcessDriver,
  input: FreshProcessInput,
): Promise<FreshProcessReport> {
  const required = REQUIRED_ATTENDED_CHECKS[FRESH_PROCESS_SCENARIO];
  const names = freshNames(input.runId);
  const startedAt = driver.now().toISOString();
  const results = new Map<string, AttendedCheck>();
  const steps: ScenarioStep[] = [];
  const note = (step: string, detail: string): void => {
    steps.push({ at: driver.now().toISOString(), step, detail });
  };
  const pass = (name: string, detail: string): void => {
    results.set(name, { name, status: 'passed', detail });
    note(name, detail);
  };

  // Before anything starts: the guards must hold, and the Downloads folder must be readable so that a
  // change to it can be seen at the end.
  const beforeReading = await readGuards(driver);
  const before = beforeReading.guards;
  const downloadsBefore = await readDownloads(driver);
  const refusals = [
    ...beforeReading.readErrors,
    ...guardBlockers(before, 'before launch', undefined, beforeReading.unread),
  ];
  if (downloadsBefore.error !== undefined) {
    refusals.push(`could not read the Downloads folder: ${downloadsBefore.error}`);
  }
  if (refusals.length > 0) {
    note('refused', refusals.join('; '));
    return freshReport({
      verdict: 'refused',
      input,
      startedAt,
      finishedAt: driver.now().toISOString(),
      launches: 0,
      before,
      after: undefined,
      results,
      required,
      steps,
      blockers: refusals,
      receipt: undefined,
    });
  }

  const sessions: Session[] = [];
  /**
   * Writes the text of the page that is still open, and a screenshot, into the run folder when a step fails.
   * A snapshot that cannot be taken is noted and does not change the verdict.
   */
  const captureFailure = async (check: string): Promise<void> => {
    const open = [...sessions]
      .reverse()
      .find((session) => !session.closed && session.page !== undefined);
    if (open?.page === undefined) return;
    try {
      const snapshot = await withTimeout(open.page.snapshot(), 45_000);
      const stem = `failure-${check}`;
      await driver.writeRunFile(`${stem}.txt`, Buffer.from(snapshot.text, 'utf8'));
      await driver.writeRunFile(`${stem}.png`, snapshot.png);
      note(
        'failure-snapshot',
        `the page text and a screenshot were written as ${stem}.txt and ${stem}.png`,
      );
    } catch (error) {
      note('failure-snapshot', `not written: ${describeError(error)}`);
    }
  };
  const closeErrors: string[] = [];
  const artifacts: AttendedArtifact[] = [];
  let launches = 0;
  let fatal: string | undefined;

  const launchOne = async (profile: string): Promise<LaunchedProcess> => {
    launches += 1;
    const app = await driver.launch(launches, profile);
    const session: Session = { app, page: undefined, closed: false };
    sessions.push(session);
    const page = await driver.attach(app);
    session.page = page;
    return { session, page };
  };

  try {
    // First process: a new profile, a project with one imported clip, and an editable package of it.
    const clip = await stage('editable-project-exported', () => driver.readClipFixture());
    await stage('editable-project-exported', () =>
      driver.seedProfile(input.sourceProfile, input.library),
    );
    const source = await stage('editable-project-exported', () => launchOne(input.sourceProfile));
    await stage('editable-project-exported', () => source.page.waitForLibrary());
    // The first process must also run on the scratch library, so no write can reach the owner's library.
    const sourceLibrary = await stage('editable-project-exported', () =>
      source.page.libraryDirectory(),
    );
    if (normalizeDirectory(sourceLibrary) !== normalizeDirectory(input.library)) {
      throw new StepFailure(
        'editable-project-exported',
        `the source profile's library is ${sourceLibrary}, not ${input.library}`,
      );
    }
    await stage('editable-project-exported', () => source.page.createProject(names.sourceTitle));
    await stage('editable-project-exported', () => source.page.importClip(names.clipName, clip));
    const clipCount = await stage('editable-project-exported', () =>
      source.page.timelineClipCount(names.clipName),
    );
    if (clipCount !== 1) {
      throw new StepFailure(
        'editable-project-exported',
        `the timeline holds ${clipCount} clips named ${names.clipName}, not 1`,
      );
    }
    const packageBytes = await stage('editable-project-exported', () =>
      source.page.exportEditablePackage(),
    );
    await stage('editable-project-exported', () =>
      driver.writeRunFile(PACKAGE_FILE_NAME, packageBytes),
    );
    const problems = packageProblems(packageBytes, {
      sourceTitle: names.sourceTitle,
      clipName: names.clipName,
      clipSha256: sha256Hex(clip),
    });
    if (problems.length > 0) {
      throw new StepFailure('editable-project-exported', problems.join('; '));
    }
    const sourceStores = await stage('editable-project-exported', () =>
      source.page.readStorage([TIMELINE_LOG_KEY, CATALOG_KEY]),
    );
    const sourceProblems = sourceStoreBlockers(sourceStores, names);
    if (sourceProblems.length > 0) {
      throw new StepFailure('editable-project-exported', sourceProblems.join('; '));
    }
    artifacts.push({
      name: PACKAGE_FILE_NAME,
      path: PACKAGE_FILE_NAME,
      sha256: sha256Hex(packageBytes),
      bytes: packageBytes.byteLength,
    });
    pass(
      'editable-project-exported',
      `${names.sourceTitle} with ${names.clipName} exported as ${PACKAGE_FILE_NAME} ` +
        `(${packageBytes.byteLength} bytes); the source profile's saved state holds both`,
    );

    // The first process ends before the second starts. The guards must hold in between.
    source.session.closed = true;
    await stage('editable-project-exported', () => driver.close(source.session.app, source.page));
    const between = await readGuards(driver);
    const betweenProblems = [
      ...between.readErrors,
      ...guardBlockers(between.guards, 'between the launches', before, between.unread),
    ];
    if (betweenProblems.length > 0) {
      throw new StepFailure(
        'fresh-profile-started',
        `not started again: ${betweenProblems.join('; ')}`,
      );
    }

    // Second process: a new profile that starts with no copy of the project.
    await stage('fresh-profile-started', () =>
      driver.seedProfile(input.freshProfile, input.library),
    );
    const fresh = await stage('fresh-profile-started', () => launchOne(input.freshProfile));
    await stage('fresh-profile-started', () => fresh.page.waitForLibrary());
    const libraryNow = await stage('fresh-profile-started', () => fresh.page.libraryDirectory());
    if (normalizeDirectory(libraryNow) !== normalizeDirectory(input.library)) {
      throw new StepFailure(
        'fresh-profile-started',
        `the fresh profile's library is ${libraryNow}, not ${input.library}`,
      );
    }
    const freshCatalog = await stage('fresh-profile-started', () =>
      fresh.page.readStorage([CATALOG_KEY]),
    );
    if (storeHas(freshCatalog[CATALOG_KEY], names.sourceTitle)) {
      throw new StepFailure(
        'fresh-profile-started',
        'the fresh profile already holds the source project before the import',
      );
    }
    await stage('fresh-profile-started', () => fresh.page.createProject(names.hostTitle));
    pass(
      'fresh-profile-started',
      `a new profile started on the scratch library ${libraryNow}; host project ${names.hostTitle} is open`,
    );

    // Import the package into the fresh profile, then check the imported project and its clip.
    const notice = await stage('project-imported-in-fresh-profile', () =>
      fresh.page.importEditablePackage(PACKAGE_FILE_NAME, packageBytes),
    );
    // The app reports a failed import or a file that needs relinking in its notice. An empty notice is not
    // a failure: the app's notice is a toast that may be gone already, so the open project is checked instead.
    if (notice.includes('Project import failed') || notice.includes('relinking')) {
      throw new StepFailure(
        'project-imported-in-fresh-profile',
        `the app reported "${notice}" instead of an import with all media available`,
      );
    }
    const openTitle = await stage('project-imported-in-fresh-profile', () =>
      fresh.page.activeProjectTitle(),
    );
    if (openTitle !== names.sourceTitle) {
      throw new StepFailure(
        'project-imported-in-fresh-profile',
        `the open project is ${openTitle ?? 'none'}, not ${names.sourceTitle}`,
      );
    }
    const importedClips = await stage('project-imported-in-fresh-profile', () =>
      fresh.page.timelineClipCount(names.clipName),
    );
    if (importedClips !== 1) {
      throw new StepFailure(
        'project-imported-in-fresh-profile',
        `the imported timeline holds ${importedClips} clips named ${names.clipName}, not 1`,
      );
    }
    pass(
      'project-imported-in-fresh-profile',
      `imported ${names.sourceTitle} as the open project, with one ${names.clipName} clip on the timeline; ` +
        (notice === '' ? 'the app showed no notice' : `the app said "${notice}"`),
    );

    // Render the imported project in this process, then probe the MP4 with ffprobe.
    const rendered = await stage('export-from-fresh-profile-probed', () => fresh.page.renderMp4());
    await stage('export-from-fresh-profile-probed', () =>
      driver.writeRunFile(RENDER_FILE_NAME, rendered),
    );
    const probe = await stage('export-from-fresh-profile-probed', () =>
      driver.probeMedia(RENDER_FILE_NAME),
    );
    const clipProbe = await stage('export-from-fresh-profile-probed', () => driver.probeClip());
    const renderProblems = [...renderBlockers(probe), ...renderMatchesClip(probe, clipProbe)];
    if (renderProblems.length > 0) {
      throw new StepFailure('export-from-fresh-profile-probed', renderProblems.join('; '));
    }
    artifacts.push({
      name: RENDER_FILE_NAME,
      path: RENDER_FILE_NAME,
      sha256: sha256Hex(rendered),
      bytes: rendered.byteLength,
    });
    pass(
      'export-from-fresh-profile-probed',
      `the app verified an MP4 rendered from the imported project: ${probe.video?.width}x${probe.video?.height} ` +
        `video stream, ${probe.durationSeconds.toFixed(3)} s, the imported clip's ${clipProbe.durationSeconds.toFixed(3)} s`,
    );

    // The fresh profile's saved state must hold the imported project. A failure here fails the import
    // check, though the render has already been recorded.
    const freshStores = await stage('project-imported-in-fresh-profile', () =>
      fresh.page.readStorage([TIMELINE_LOG_KEY, VISUAL_LOG_KEY, CATALOG_KEY]),
    );
    const storeProblems = freshStoreBlockers(freshStores, names);
    if (storeProblems.length > 0) {
      results.set('project-imported-in-fresh-profile', {
        name: 'project-imported-in-fresh-profile',
        status: 'failed',
        detail: storeProblems.join('; '),
      });
      note('project-imported-in-fresh-profile', `failed: ${storeProblems.join('; ')}`);
    } else {
      pass(
        'project-imported-in-fresh-profile',
        `imported ${names.sourceTitle} as the open project; the fresh profile's saved state holds the project and a ${names.clipName} clip; ` +
          (notice === '' ? 'the app showed no notice' : `the app said "${notice}"`),
      );
    }

    // Close the second process. A close that fails is a blocker, reported with the other closes below.
    fresh.session.closed = true;
    try {
      await driver.close(fresh.session.app, fresh.page);
    } catch (error) {
      closeErrors.push(`process ${fresh.session.app.pid} did not close: ${describeError(error)}`);
    }
  } catch (error) {
    if (error instanceof StepFailure) {
      results.set(error.check, { name: error.check, status: 'failed', detail: error.message });
      note(error.check, `failed: ${error.message}`);
      await captureFailure(error.check);
    } else {
      fatal = describeError(error);
      note('error', fatal);
    }
  } finally {
    for (const session of sessions) {
      if (session.closed) continue;
      session.closed = true;
      try {
        await driver.close(session.app, session.page);
      } catch (error) {
        closeErrors.push(`process ${session.app.pid} did not close: ${describeError(error)}`);
      }
    }
  }

  const afterReading = await readGuards(driver);
  const after = afterReading.guards;
  const blockers: string[] = [];
  if (fatal !== undefined) blockers.push(fatal);
  blockers.push(...closeErrors, ...afterReading.readErrors);
  blockers.push(...guardBlockers(after, 'after the run', before, afterReading.unread));
  const downloadsAfter = await readDownloads(driver);
  if (downloadsAfter.error !== undefined) {
    blockers.push(`could not read the Downloads folder after the run: ${downloadsAfter.error}`);
  } else if (downloadsAfter.signature !== downloadsBefore.signature) {
    blockers.push('the Downloads folder changed during the run');
  }

  const checks = orderedChecks(results, required);
  const allPassed = checks.every((check) => check.status === 'passed');
  let receipt: AttendedReceipt | undefined;
  if (allPassed && blockers.length === 0 && artifacts.length === 2) {
    const candidate = buildFreshReceipt(
      input,
      before,
      after,
      { startedAt, finishedAt: driver.now().toISOString() },
      checks,
      artifacts,
    );
    const problems = validateAttendedReceipt(candidate, {
      scenarioId: FRESH_PROCESS_SCENARIO,
      candidateSha: input.candidateSha,
    });
    if (problems.length === 0) {
      receipt = candidate;
    } else {
      blockers.push(...problems.map((problem) => `receipt refused: ${problem}`));
    }
  }

  return freshReport({
    verdict: receipt === undefined ? 'failed' : 'passed',
    input,
    startedAt,
    finishedAt: driver.now().toISOString(),
    launches,
    before,
    after,
    results,
    required,
    steps,
    blockers,
    receipt,
  });
}
