/**
 * The first scripted attended scenario: restart, save and export.
 *
 * What it proves: a project saved through the editor's own document channel survives a restart of
 * the candidate app on the same profile, and a render job made from that project finishes and gives
 * back an MP4 that ffprobe accepts, with the preset's size, the timeline's duration, one video and
 * one audio stream, and the worker's frame rate and frame count.
 *
 * What it does not prove: the export input is an MP4 that the script encodes with ffmpeg, not the
 * browser's own recording, and the save is the editor's document channel, not a click in the UI.
 * The browser compositor and the picture are not checked here. The semantics scenario covers them.
 *
 * This module does no I/O. A driver supplies the machine, the app, the bridge and the files, so the
 * same logic runs in tests with a fake driver and in an attended run with the real one.
 */

import { createHash } from 'node:crypto';
import {
  ATTENDED_RECEIPT_SCHEMA,
  JOY_KEY_EXPECTED_SHA256,
  REQUIRED_ATTENDED_CHECKS,
  validateAttendedReceipt,
  type AttendedArtifact,
  type AttendedCheck,
  type AttendedReceipt,
} from './attended-receipt.ts';

export const RESTART_SAVE_EXPORT = 'desktop.app.restart-save-export' as const;

/** The editor fixes its export frame rate (apps/editor-web/src/App.tsx). */
export const EXPORT_FRAME_RATE = 30;

/** Originals up to this size go in one bridge message. The editor chunks anything larger. */
export const SINGLE_SHOT_UPLOAD_LIMIT_BYTES = 60 * 1024 * 1024;

/** How long an export job may stay queued or running before the run fails and cancels it. */
export const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
export const EXPORT_POLL_MS = 2000;

/** The name of the derivative this scenario writes into the run folder. */
export const EXPORT_FILE_NAME = 'export.mp4';

/** Frame rates within this distance of the expected one are the same rate (the worker's tolerance). */
const FRAME_RATE_TOLERANCE = 0.01;

export type ExportPreset =
  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';

export interface AppHandle {
  readonly pid: number;
  readonly attempt: number;
}

export interface DerivativeBytes {
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** The editor page as the scenario sees it: the bridge, plus the two byte transfers the bridge needs. */
export interface EditorPage {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  uploadOriginal(assetId: string, bytes: Uint8Array): Promise<void>;
  fetchDerivative(jobId: string): Promise<DerivativeBytes>;
}

export interface StageSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly frameCount: number;
  readonly durationUs: number;
}

/**
 * The fields of a probe that this scenario reads. Counts are of streams of each kind. A frame rate or
 * a frame count the probe could not read is left out, and then the scenario refuses the export.
 */
export interface MediaProbe {
  readonly formatName: string;
  readonly durationSeconds: number;
  readonly videoStreams: number;
  readonly audioStreams: number;
  readonly video?: { readonly codec: string; readonly width: number; readonly height: number };
  readonly audioCodec?: string;
  readonly frameRate?: number;
  readonly frames?: number;
}

/** The readings the guards are made of. Every scenario takes them before, between and after its launches. */
export interface GuardDriver {
  /** SHA-256 of the joy:// registration key as reg.exe exports it. */
  joyKeySha256(): Promise<string>;
  /** JOY Media processes on the machine, whichever build they come from, including the app's children. */
  joyProcessCount(): Promise<number>;
  /** Files under the owner's default asset library. */
  ownerLibraryFileCount(): Promise<number>;
  /** A signature of the installed JOY Media folder that changes when any file in it changes. */
  installedFolderSignature(): Promise<string>;
}

export interface ScenarioDriver extends GuardDriver {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Starts the candidate app on the run profile with a debug port. */
  launch(attempt: number): Promise<AppHandle>;
  /** Waits for the editor page that exposes the bridge. */
  attach(app: AppHandle): Promise<EditorPage>;
  isAlive(app: AppHandle): Promise<boolean>;
  /**
   * Closes the window through the bridge when a page is given, then waits until the launcher process
   * and every JOY process are gone, and disconnects the page. Throws when they are still there.
   */
  close(app: AppHandle, page: EditorPage | undefined): Promise<void>;
  /** Encodes a staged MP4 into the run folder and returns its bytes. */
  stageVideo(spec: StageSpec): Promise<{ readonly bytes: Uint8Array }>;
  /** Probes a file in the run folder by its name. */
  probeMedia(name: string): Promise<MediaProbe>;
  /** Writes a file into the run folder. */
  writeRunFile(name: string, bytes: Uint8Array): Promise<void>;
}

export interface CompositionShape {
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
}

/** The project document as the editor stores it. Only the fields this scenario reads are typed. */
export interface JoyDocument {
  readonly title: string;
  readonly updatedAt: string;
  readonly rootCompositionId: string;
  readonly exportPreset?: ExportPreset;
  readonly compositions: Readonly<Record<string, CompositionShape>>;
  readonly universalTimeline: {
    readonly items: readonly { readonly startUs: number; readonly durationUs: number }[];
  };
}

export interface StoredProject {
  readonly projectId: string;
  readonly revisionId: string;
  readonly document: JoyDocument;
}

export interface ExportExpectation {
  readonly preset: ExportPreset;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly frameCount: number;
}

export interface JobView {
  readonly id: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly error?: string;
  readonly derivative?: {
    readonly sha256: string;
    readonly bytes: number;
    readonly mimeType: string;
  };
}

export interface ScenarioInput {
  readonly runId: string;
  readonly candidateSha: string;
  readonly projectId: string;
  readonly exeSha256: string;
  readonly unpackedDir: string;
}

export interface GuardReadings {
  readonly joyKeySha256: string;
  readonly joyProcesses: number;
  readonly ownerLibraryFiles: number;
  readonly installedFolder: string;
}

/** The guard readings, by name. */
export type GuardField = keyof GuardReadings;

export interface ScenarioStep {
  readonly at: string;
  readonly step: string;
  readonly detail: string;
}

export type ScenarioVerdict = 'passed' | 'failed' | 'refused';

export interface ScenarioReport {
  readonly scenario: typeof RESTART_SAVE_EXPORT;
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

/** A check that failed on purpose. The message is the reason the owner reads. */
export class StepFailure extends Error {
  readonly check: string;

  constructor(check: string, message: string) {
    super(message);
    this.check = check;
  }
}

interface Session {
  readonly app: AppHandle;
  page: EditorPage | undefined;
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The worker's frame count for a duration (apps/worker/src/export-job.ts). */
export function frameCountFor(durationUs: number, frameRate: number): number {
  return Math.max(1, Math.round((durationUs / 1_000_000) * frameRate));
}

/** The pixel size each preset exports at (packages/export-core/src/index.ts). */
export function dimensionsForPreset(
  preset: ExportPreset,
  fallback: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  switch (preset) {
    case 'reels-1080':
    case 'shorts-1080':
      return { width: 1080, height: 1920 };
    case 'youtube-1080':
      return { width: 1920, height: 1080 };
    case 'high-bitrate':
      return { width: Math.max(fallback.width, 1920), height: Math.max(fallback.height, 1080) };
    default:
      return fallback;
  }
}

/**
 * What the export must come out as, from the saved document. The root is the composition the schema
 * names with rootCompositionId. The duration is the end of the last timeline item, as the editor
 * takes it, and falls back to the root composition's duration. A document with no export preset is
 * refused, because the scenario does not choose a preset for the owner.
 */
export function exportExpectation(document: JoyDocument): ExportExpectation {
  const rootId = document.rootCompositionId;
  if (typeof rootId !== 'string' || rootId === '') {
    throw new Error('the project has no root composition id');
  }
  const root = document.compositions[rootId];
  if (root === undefined) throw new Error(`the root composition ${rootId} is missing`);
  if (document.exportPreset === undefined) {
    throw new Error('the project has no export preset, so the scenario will not choose one');
  }
  const contentEndUs = document.universalTimeline.items.reduce(
    (end, item) => Math.max(end, item.startUs + item.durationUs),
    0,
  );
  const durationUs = contentEndUs > 0 ? contentEndUs : root.durationUs;
  if (!Number.isSafeInteger(durationUs) || durationUs < 1) {
    throw new Error('the project has no duration to export');
  }
  const size = dimensionsForPreset(document.exportPreset, {
    width: root.width,
    height: root.height,
  });
  return {
    preset: document.exportPreset,
    width: size.width,
    height: size.height,
    frameRate: EXPORT_FRAME_RATE,
    durationUs,
    frameCount: frameCountFor(durationUs, EXPORT_FRAME_RATE),
  };
}

/**
 * The render.export payload the worker accepts (apps/editor-web/src/export-job-request.ts).
 * The revision is the saved document counter, so the export names the revision it was made from.
 */
export function renderExportPayload(
  projectId: string,
  revision: number,
  expected: ExportExpectation,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    producer: 'browser-staged-preview-export',
    frameCount: expected.frameCount,
    manifest: {
      projectId,
      revision,
      width: expected.width,
      height: expected.height,
      frameRate: expected.frameRate,
      durationUs: expected.durationUs,
      preset: expected.preset,
    },
  };
}

/** The document counter inside an editor revision string, for example 6 in "...:document=6:...". */
export function documentCounter(revision: string): number {
  const match = /document=(\d+)/u.exec(revision);
  if (match === null) throw new Error('the stored revision has no document counter');
  return Number(match[1]);
}

/** The next document revision: the editor's revision string with its document counter one higher. */
export function nextDocumentRevision(previous: string): string {
  const next = documentCounter(previous) + 1;
  return previous.replace(/document=\d+/u, `document=${next}`);
}

/** A copy of the document with a new title and update time. The input is not changed. */
export function withSavedTitle(
  document: JoyDocument,
  title: string,
  updatedAt: string,
): JoyDocument {
  return { ...document, title, updatedAt };
}

/** Reasons a probed export is not the one the scenario asked for. An empty list means it is. */
export function probeBlockers(probe: MediaProbe, expected: ExportExpectation): string[] {
  const blockers: string[] = [];
  if (!probe.formatName.split(',').includes('mp4')) {
    blockers.push(`the container is ${probe.formatName}, not mp4`);
  }
  if (probe.videoStreams !== 1) {
    blockers.push(`there are ${probe.videoStreams} video streams, not 1`);
  }
  if (probe.audioStreams !== 1) {
    blockers.push(`there are ${probe.audioStreams} audio streams, not 1`);
  }
  if (probe.video === undefined) {
    blockers.push('there is no video stream');
  } else {
    if (probe.video.codec !== 'h264') {
      blockers.push(`the video codec is ${probe.video.codec}, not h264`);
    }
    if (probe.video.width !== expected.width || probe.video.height !== expected.height) {
      blockers.push(
        `the video is ${probe.video.width}x${probe.video.height}, expected ${expected.width}x${expected.height}`,
      );
    }
  }
  if (probe.audioCodec !== 'aac') {
    blockers.push(`the audio codec is ${probe.audioCodec ?? 'missing'}, not aac`);
  }
  if (probe.frameRate === undefined) {
    blockers.push('the frame rate is missing from the probe');
  } else if (Math.abs(probe.frameRate - expected.frameRate) > FRAME_RATE_TOLERANCE) {
    blockers.push(`the frame rate is ${probe.frameRate}, expected ${expected.frameRate}`);
  }
  if (probe.frames === undefined) {
    blockers.push('the frame count is missing from the probe');
  } else if (probe.frames !== expected.frameCount) {
    blockers.push(`the frame count is ${probe.frames}, expected ${expected.frameCount}`);
  }
  const expectedSeconds = expected.durationUs / 1_000_000;
  const toleranceSeconds = 1 / expected.frameRate;
  if (
    !Number.isFinite(probe.durationSeconds) ||
    Math.abs(probe.durationSeconds - expectedSeconds) > toleranceSeconds + 1e-6
  ) {
    blockers.push(
      `the duration is ${probe.durationSeconds} s, expected ${expectedSeconds.toFixed(3)} s within one frame`,
    );
  }
  return blockers;
}

export function stagedClipName(runId: string): string {
  return `staged-${runId}.mp4`;
}

/**
 * The problems a set of guard readings shows. `when` names the moment in the reason the owner reads.
 * With a reference reading, the owner library and the installed folder must match it too. A guard
 * listed in `unread` could not be read, so it is not judged here: its read error is reported instead.
 */
export function guardBlockers(
  current: GuardReadings,
  when: string,
  reference?: GuardReadings,
  unread: readonly GuardField[] = [],
): string[] {
  const blockers: string[] = [];
  if (!unread.includes('joyKeySha256') && current.joyKeySha256 !== JOY_KEY_EXPECTED_SHA256) {
    blockers.push(`the joy:// key was not the expected value ${when}`);
  }
  if (!unread.includes('joyProcesses') && current.joyProcesses !== 0) {
    blockers.push(`${current.joyProcesses} JOY process(es) running ${when}`);
  }
  if (reference !== undefined) {
    if (
      !unread.includes('ownerLibraryFiles') &&
      current.ownerLibraryFiles !== reference.ownerLibraryFiles
    ) {
      blockers.push(
        `the owner asset library changed ${when} (${reference.ownerLibraryFiles} to ${current.ownerLibraryFiles} files)`,
      );
    }
    if (
      !unread.includes('installedFolder') &&
      current.installedFolder !== reference.installedFolder
    ) {
      blockers.push(`the installed JOY Media folder changed ${when}`);
    }
  }
  return blockers;
}

/**
 * Reads the guards. A read that throws does not end the run: its error is reported, the field is
 * listed as unread, and its placeholder value is never judged. The other guards are still judged.
 */
export async function readGuards(driver: GuardDriver): Promise<{
  readonly guards: GuardReadings;
  readonly readErrors: string[];
  readonly unread: GuardField[];
}> {
  const readErrors: string[] = [];
  const unread: GuardField[] = [];
  const read = async <T>(
    field: GuardField,
    label: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      readErrors.push(`could not read ${label}: ${describeError(error)}`);
      unread.push(field);
      return fallback;
    }
  };
  const guards: GuardReadings = {
    joyKeySha256: await read('joyKeySha256', 'the joy:// key', '', () => driver.joyKeySha256()),
    joyProcesses: await read('joyProcesses', 'the JOY process count', -1, () =>
      driver.joyProcessCount(),
    ),
    ownerLibraryFiles: await read('ownerLibraryFiles', 'the owner library count', -1, () =>
      driver.ownerLibraryFileCount(),
    ),
    installedFolder: await read('installedFolder', 'the installed folder', '', () =>
      driver.installedFolderSignature(),
    ),
  };
  return { guards, readErrors, unread };
}

function asStoredProject(projectId: string, value: unknown): StoredProject | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.revisionId !== 'string' || !isRecord(value.document)) {
    throw new Error('the project document answer has an unexpected shape');
  }
  return {
    projectId,
    revisionId: value.revisionId,
    document: value.document as unknown as JoyDocument,
  };
}

async function readStoredProject(
  page: EditorPage,
  projectId: string,
): Promise<StoredProject | null> {
  return asStoredProject(
    projectId,
    await page.invoke('desktop.media.project.document.get', { projectId }),
  );
}

const JOB_STATUSES: readonly string[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

export function asJobView(value: unknown): JobView {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string') {
    throw new Error('the job status answer has an unexpected shape');
  }
  if (!JOB_STATUSES.includes(value.status)) {
    throw new Error(`the job status ${value.status} is not one the bridge uses`);
  }
  const derivativeValue = value.derivative;
  const derivative =
    isRecord(derivativeValue) &&
    typeof derivativeValue.sha256 === 'string' &&
    typeof derivativeValue.mimeType === 'string' &&
    typeof derivativeValue.bytes === 'number'
      ? {
          sha256: derivativeValue.sha256,
          mimeType: derivativeValue.mimeType,
          bytes: derivativeValue.bytes,
        }
      : undefined;
  const error = typeof value.error === 'string' ? value.error : undefined;
  return {
    id: value.id,
    status: value.status as JobView['status'],
    ...(error === undefined ? {} : { error }),
    ...(derivative === undefined ? {} : { derivative }),
  };
}

function expectJobId(value: unknown): string {
  if (!isRecord(value) || typeof value.jobId !== 'string') {
    throw new Error('the render request did not return a job id');
  }
  return value.jobId;
}

/**
 * Polls the job until it ends. A job that is not finished when the poll stops, whether by the timeout
 * or by an unreadable answer, is cancelled, so it does not run on after the run.
 */
async function waitForExportJob(
  driver: ScenarioDriver,
  page: EditorPage,
  jobId: string,
): Promise<JobView> {
  const deadline = driver.now().getTime() + EXPORT_TIMEOUT_MS;
  let finished = false;
  try {
    for (;;) {
      const job = asJobView(await page.invoke('desktop.media.job.status', { jobId }));
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        finished = true;
        return job;
      }
      if (driver.now().getTime() > deadline) {
        throw new StepFailure(
          'export-completed',
          `the export job was still ${job.status} after ${EXPORT_TIMEOUT_MS / 1000} seconds`,
        );
      }
      await driver.sleep(EXPORT_POLL_MS);
    }
  } finally {
    if (!finished) {
      await page.invoke('desktop.media.job.cancel', { jobId }).catch(() => undefined);
    }
  }
}

function buildReceipt(
  input: ScenarioInput,
  before: GuardReadings,
  after: GuardReadings,
  times: { readonly startedAt: string; readonly finishedAt: string },
  checks: readonly AttendedCheck[],
  artifact: AttendedArtifact,
): AttendedReceipt {
  return {
    schema: ATTENDED_RECEIPT_SCHEMA,
    scenario: { id: RESTART_SAVE_EXPORT, status: 'passed', firstAttemptPassed: true, retries: 0 },
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
    artifacts: [artifact],
  };
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

function reportFor(parts: {
  readonly verdict: ScenarioVerdict;
  readonly input: ScenarioInput;
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
}): ScenarioReport {
  return {
    scenario: RESTART_SAVE_EXPORT,
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
 * Runs the restart, save and export scenario once. The result is a report. It carries a receipt only
 * when every required check passed, the guards held at every point, and the receipt passes the contract.
 */
export async function runRestartSaveExport(
  driver: ScenarioDriver,
  input: ScenarioInput,
): Promise<ScenarioReport> {
  const required = REQUIRED_ATTENDED_CHECKS[RESTART_SAVE_EXPORT];
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

  // Before anything starts: the guards must hold, or nothing is launched.
  const beforeReading = await readGuards(driver);
  const before = beforeReading.guards;
  const refusals = [
    ...beforeReading.readErrors,
    ...guardBlockers(before, 'before launch', undefined, beforeReading.unread),
  ];
  if (refusals.length > 0) {
    note('refused', refusals.join('; '));
    return reportFor({
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
  const closeErrors: string[] = [];
  let launches = 0;
  let artifact: AttendedArtifact | undefined;
  let fatal: string | undefined;

  const launchOne = async (): Promise<{ readonly session: Session; readonly page: EditorPage }> => {
    launches += 1;
    const app = await driver.launch(launches);
    const session: Session = { app, page: undefined, closed: false };
    sessions.push(session);
    const page = await driver.attach(app);
    session.page = page;
    return { session, page };
  };

  try {
    // Save, through the editor's document channel, on the first launch.
    const first = await stage('project-saved', () => launchOne());
    const stored = await stage('project-saved', () =>
      readStoredProject(first.page, input.projectId),
    );
    if (stored === null) {
      throw new StepFailure('project-saved', 'the project has no stored document in this profile');
    }
    const title = `Attended restart check ${input.runId.slice(0, 8)}`;
    const savedRevision = nextDocumentRevision(stored.revisionId);
    const document = withSavedTitle(stored.document, title, driver.now().toISOString());
    await stage('project-saved', async () => {
      const outcome = await first.page.invoke('desktop.media.project.document.put', {
        projectId: input.projectId,
        baseRevisionId: stored.revisionId,
        revisionId: savedRevision,
        document,
      });
      if (!isRecord(outcome) || outcome.kind !== 'saved' || outcome.revisionId !== savedRevision) {
        throw new StepFailure('project-saved', `the save answered ${JSON.stringify(outcome)}`);
      }
    });
    const readBack = await stage('project-saved', () =>
      readStoredProject(first.page, input.projectId),
    );
    if (
      readBack === null ||
      readBack.revisionId !== savedRevision ||
      readBack.document.title !== title
    ) {
      throw new StepFailure('project-saved', 'the saved revision did not read back');
    }
    pass('project-saved', `saved ${savedRevision} with the title "${title}"`);

    // The export expectation comes from the saved document. A document the scenario cannot export
    // fails the export check here, before the restart, so the app is not restarted for nothing.
    const exp = await stage('export-completed', async () => exportExpectation(readBack.document));

    // Restart: close the first process and check the guards, then start a new process on the same profile.
    // The session is marked closed before the attempt, so a failed close is not retried in cleanup.
    first.session.closed = true;
    await stage('app-restarted', () => driver.close(first.session.app, first.page));
    const between = await readGuards(driver);
    const betweenProblems = [
      ...between.readErrors,
      ...guardBlockers(between.guards, 'between the launches', before, between.unread),
    ];
    if (betweenProblems.length > 0) {
      throw new StepFailure('app-restarted', `not started again: ${betweenProblems.join('; ')}`);
    }
    const second = await stage('app-restarted', () => launchOne());
    if (
      second.session.app.pid === first.session.app.pid ||
      !(await driver.isAlive(second.session.app))
    ) {
      throw new StepFailure(
        'app-restarted',
        `the second launch did not start a new process (pids ${first.session.app.pid}, ${second.session.app.pid})`,
      );
    }
    pass(
      'app-restarted',
      `process ${second.session.app.pid} started after ${first.session.app.pid} closed`,
    );

    // Reopen: the saved revision and title must be what the restarted app reads.
    const reopened = await stage('project-reopened-after-restart', () =>
      readStoredProject(second.page, input.projectId),
    );
    if (
      reopened === null ||
      reopened.revisionId !== savedRevision ||
      reopened.document.title !== title
    ) {
      throw new StepFailure(
        'project-reopened-after-restart',
        `after the restart the stored revision is ${reopened?.revisionId ?? 'missing'}, not ${savedRevision}`,
      );
    }
    pass(
      'project-reopened-after-restart',
      `revision ${savedRevision} and its title read back after the restart`,
    );

    // Export: stage the clip, register and upload it the way the editor does, enqueue the render, and wait.
    const clipName = stagedClipName(input.runId);
    const exportedJob = await stage('export-completed', async () => {
      const staged = await driver.stageVideo({
        name: clipName,
        width: exp.width,
        height: exp.height,
        frameRate: exp.frameRate,
        frameCount: exp.frameCount,
        durationUs: exp.durationUs,
      });
      if (staged.bytes.byteLength > SINGLE_SHOT_UPLOAD_LIMIT_BYTES) {
        throw new StepFailure(
          'export-completed',
          `the staged clip is ${staged.bytes.byteLength} bytes, above the single-message limit`,
        );
      }
      const assetId = `export-source-${input.runId}`;
      await second.page.invoke('desktop.media.asset.register', {
        id: assetId,
        kind: 'video',
        displayName: clipName,
        sha256: sha256Hex(staged.bytes),
        bytes: staged.bytes.byteLength,
        descriptor: {
          mimeType: 'video/mp4',
          width: exp.width,
          height: exp.height,
          durationUs: exp.durationUs,
        },
      });
      await second.page.uploadOriginal(assetId, staged.bytes);
      const enqueued = await second.page.invoke('desktop.media.render.enqueue', {
        refId: assetId,
        payload: renderExportPayload(input.projectId, documentCounter(savedRevision), exp),
      });
      const jobId = expectJobId(enqueued);
      const job = await waitForExportJob(driver, second.page, jobId);
      return { jobId, job };
    });
    if (exportedJob.job.status !== 'done') {
      const reason = exportedJob.job.error === undefined ? '' : `: ${exportedJob.job.error}`;
      throw new StepFailure(
        'export-completed',
        `the export job ended as ${exportedJob.job.status}${reason}`,
      );
    }
    const derivative = await stage('export-completed', () =>
      second.page.fetchDerivative(exportedJob.jobId),
    );
    const derivativeSha = sha256Hex(derivative.bytes);
    if (derivative.mimeType !== 'video/mp4' || derivative.bytes.byteLength === 0) {
      throw new StepFailure(
        'export-completed',
        `the derivative is ${derivative.mimeType} with ${derivative.bytes.byteLength} bytes`,
      );
    }
    if (
      derivativeSha !== derivative.sha256 ||
      (exportedJob.job.derivative !== undefined &&
        exportedJob.job.derivative.sha256 !== derivativeSha)
    ) {
      throw new StepFailure('export-completed', 'the derivative does not match its checksum');
    }
    await stage('export-completed', () => driver.writeRunFile(EXPORT_FILE_NAME, derivative.bytes));
    artifact = {
      name: EXPORT_FILE_NAME,
      path: EXPORT_FILE_NAME,
      sha256: derivativeSha,
      bytes: derivative.bytes.byteLength,
    };
    pass(
      'export-completed',
      `job ${exportedJob.jobId} done from revision ${savedRevision}; ${EXPORT_FILE_NAME} is ${derivative.bytes.byteLength} bytes, sha256 ${derivativeSha}`,
    );

    const probe = await stage('export-probed-playable', () => driver.probeMedia(EXPORT_FILE_NAME));
    const problems = probeBlockers(probe, exp);
    if (problems.length > 0) throw new StepFailure('export-probed-playable', problems.join('; '));
    pass(
      'export-probed-playable',
      `mp4 with one h264 ${exp.width}x${exp.height} stream and one aac stream, ${probe.durationSeconds.toFixed(3)} s`,
    );
  } catch (error) {
    if (error instanceof StepFailure) {
      results.set(error.check, { name: error.check, status: 'failed', detail: error.message });
      note(error.check, `failed: ${error.message}`);
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
  blockers.push(...closeErrors);
  blockers.push(...afterReading.readErrors);
  blockers.push(...guardBlockers(after, 'after the run', before, afterReading.unread));

  const checks = orderedChecks(results, required);
  const allPassed = checks.every((check) => check.status === 'passed');

  let receipt: AttendedReceipt | undefined;
  if (allPassed && blockers.length === 0 && artifact !== undefined) {
    const candidate = buildReceipt(
      input,
      before,
      after,
      { startedAt, finishedAt: driver.now().toISOString() },
      checks,
      artifact,
    );
    const problems = validateAttendedReceipt(candidate, {
      scenarioId: RESTART_SAVE_EXPORT,
      candidateSha: input.candidateSha,
    });
    if (problems.length === 0) {
      receipt = candidate;
    } else {
      blockers.push(...problems.map((problem) => `receipt refused: ${problem}`));
    }
  }

  return reportFor({
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
