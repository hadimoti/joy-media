import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATTENDED_RECEIPT_SCHEMA,
  JOY_KEY_EXPECTED_SHA256,
  REQUIRED_ATTENDED_CHECKS,
  validateAttendedReceipt,
} from './attended-receipt.ts';
import {
  EXPORT_FILE_NAME,
  asJobView,
  dimensionsForPreset,
  documentCounter,
  exportExpectation,
  frameCountFor,
  guardBlockers,
  nextDocumentRevision,
  probeBlockers,
  renderExportPayload,
  runRestartSaveExport,
  withSavedTitle,
  type AppHandle,
  type EditorPage,
  type GuardReadings,
  type JoyDocument,
  type MediaProbe,
  type ScenarioDriver,
  type ScenarioInput,
  type ScenarioReport,
  type StageSpec,
} from './attended-scenario.ts';

const SCENARIO = 'desktop.app.restart-save-export';
const CANDIDATE = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
const EXE_SHA256 = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const PROJECT = 'project-f2ef6ccb-acf6-4998-8a45-f0e578e7b150';
const RUN_ID = '2b0f6c7e-3c1d-4f5a-9d2e-6a8b7c9d0e1f';
const REVISION_BEFORE =
  'local-revision:v1:6281558f-fa04-404e-829b-05de4a9928c4:timeline=1:document=6:graph=0:artifacts=0:looks=0';
const REVISION_SAVED =
  'local-revision:v1:6281558f-fa04-404e-829b-05de4a9928c4:timeline=1:document=7:graph=0:artifacts=0:looks=0';
const OTHER_KEY = 'b'.repeat(64);
const SIGNATURE = 'installed-1';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function baseDocument(): JoyDocument {
  return {
    title: 'Attended check A',
    updatedAt: '2026-11-09T12:52:38.397Z',
    rootCompositionId: 'root',
    exportPreset: 'reels-1080',
    compositions: { root: { width: 1080, height: 1920, durationUs: 60_000_000 } },
    universalTimeline: { items: [{ startUs: 0, durationUs: 3_000_000 }] },
  };
}

function input(): ScenarioInput {
  return {
    runId: RUN_ID,
    candidateSha: CANDIDATE,
    projectId: PROJECT,
    exeSha256: EXE_SHA256,
    unpackedDir: 'C:\\jgp\\attended-ded976c8-20261109\\app',
  };
}

interface FakeOptions {
  readonly key?: string;
  /** After this launch attempt, the joy:// key reads OTHER_KEY. */
  readonly flipKeyAfterLaunch?: number;
  /** JOY processes already running before the run. */
  readonly externalProcesses?: number;
  /** JOY processes that stay after the first window closes, as an Electron child might. */
  readonly leftoverAfterFirstClose?: number;
  /** Successive reads of the owner library count. The last value repeats. */
  readonly libraryCounts?: readonly number[];
  /** Successive reads of the installed folder signature. The last value repeats. */
  readonly installedSignatures?: readonly string[];
  readonly saveReply?: 'saved' | 'conflict';
  /** The revision the restarted app (attempt 2) reads back. */
  readonly reopenRevision?: string;
  readonly jobEnd?: 'done' | 'failed' | 'running';
  readonly jobError?: string;
  /** The job status answer is not one the bridge uses. */
  readonly badJobAnswer?: boolean;
  /** A checksum the bridge reports for the derivative that does not match its bytes. */
  readonly derivativeSha?: string;
  readonly probe?: Partial<MediaProbe>;
  /** The second launch gets the first process id back, as if the old process never went away. */
  readonly samePidOnRelaunch?: boolean;
  /** close() of this launch attempt throws and the process stays alive. */
  readonly closeStuckAttempt?: number;
  /** Reading the JOY process count throws. */
  readonly failProcessCount?: boolean;
  /** The stored project document, when a test needs another shape. */
  readonly document?: JoyDocument;
}

/** An in-memory stand-in for the machine, the app and the bridge. Nothing here starts a process. */
class FakeWorld implements ScenarioDriver {
  key: string;
  readonly options: FakeOptions;
  readonly launchesMade: number[] = [];
  readonly closedAttempts: number[] = [];
  readonly alive = new Set<number>();
  readonly stagedSpecs: StageSpec[] = [];
  readonly enqueued: unknown[] = [];
  readonly uploaded: { assetId: string; bytes: number }[] = [];
  readonly written: { name: string; bytes: Uint8Array }[] = [];
  readonly probedNames: string[] = [];
  readonly cancelled: string[] = [];
  readonly derivative = new Uint8Array(4096).fill(9);
  documentRevision = REVISION_BEFORE;
  store: JoyDocument;
  private clock = Date.parse('2026-11-09T13:00:00.000Z');
  private leftover = 0;
  private libraryReads = 0;
  private signatureReads = 0;
  private nextPid = 4000;
  private lastPid = 0;

  constructor(options: FakeOptions = {}) {
    this.options = options;
    this.key = options.key ?? JOY_KEY_EXPECTED_SHA256;
    this.store = options.document ?? baseDocument();
  }

  now(): Date {
    return new Date(this.clock);
  }

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
  }

  async joyKeySha256(): Promise<string> {
    return this.key;
  }

  async joyProcessCount(): Promise<number> {
    if (this.options.failProcessCount === true) throw new Error('the process count failed');
    return this.alive.size + (this.options.externalProcesses ?? 0) + this.leftover;
  }

  async ownerLibraryFileCount(): Promise<number> {
    const counts = this.options.libraryCounts ?? [3221];
    const value = counts[Math.min(this.libraryReads, counts.length - 1)] ?? 3221;
    this.libraryReads += 1;
    return value;
  }

  async installedFolderSignature(): Promise<string> {
    const signatures = this.options.installedSignatures ?? [SIGNATURE];
    const value = signatures[Math.min(this.signatureReads, signatures.length - 1)] ?? SIGNATURE;
    this.signatureReads += 1;
    return value;
  }

  async launch(attempt: number): Promise<AppHandle> {
    this.launchesMade.push(attempt);
    const pid =
      this.options.samePidOnRelaunch === true && this.lastPid !== 0 ? this.lastPid : this.nextPid++;
    this.lastPid = pid;
    this.alive.add(pid);
    if (this.options.flipKeyAfterLaunch === attempt) this.key = OTHER_KEY;
    return { pid, attempt };
  }

  async attach(app: AppHandle): Promise<EditorPage> {
    if (!this.alive.has(app.pid)) throw new Error('the process is not running');
    return this.pageFor(app);
  }

  async isAlive(app: AppHandle): Promise<boolean> {
    return this.alive.has(app.pid);
  }

  async close(app: AppHandle): Promise<void> {
    this.closedAttempts.push(app.attempt);
    if (this.options.closeStuckAttempt === app.attempt) throw new Error('the window did not close');
    this.alive.delete(app.pid);
    if (app.attempt === 1 && this.options.leftoverAfterFirstClose !== undefined) {
      this.leftover = this.options.leftoverAfterFirstClose;
    }
  }

  async stageVideo(spec: StageSpec): Promise<{ readonly bytes: Uint8Array }> {
    this.stagedSpecs.push(spec);
    return { bytes: new Uint8Array(2048).fill(5) };
  }

  async probeMedia(name: string): Promise<MediaProbe> {
    this.probedNames.push(name);
    return {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreams: 1,
      audioStreams: 1,
      video: { codec: 'h264', width: 1080, height: 1920 },
      audioCodec: 'aac',
      frameRate: 30,
      frames: 90,
      ...this.options.probe,
    };
  }

  async writeRunFile(name: string, bytes: Uint8Array): Promise<void> {
    this.written.push({ name, bytes });
  }

  private pageFor(app: AppHandle): EditorPage {
    return {
      invoke: async (channel: string, payload: unknown): Promise<unknown> => {
        switch (channel) {
          case 'desktop.media.project.document.get':
            return this.readDocument(app.attempt);
          case 'desktop.media.project.document.put':
            return this.writeDocument(payload);
          case 'desktop.media.asset.register':
            return { ok: true };
          case 'desktop.media.render.enqueue':
            this.enqueued.push(payload);
            return { jobId: 'job-1' };
          case 'desktop.media.job.status':
            return this.jobView();
          case 'desktop.media.job.cancel':
            this.cancelled.push((payload as { jobId: string }).jobId);
            return { ok: true };
          default:
            throw new Error(`the fake bridge does not answer ${channel}`);
        }
      },
      uploadOriginal: async (assetId: string, bytes: Uint8Array): Promise<void> => {
        this.uploaded.push({ assetId, bytes: bytes.byteLength });
      },
      fetchDerivative: async () => ({
        mimeType: 'video/mp4',
        sha256: this.derivativeSha(),
        bytes: this.derivative,
      }),
    };
  }

  private readDocument(attempt: number): {
    projectId: string;
    revisionId: string;
    document: JoyDocument;
  } {
    const revisionId =
      attempt === 2 && this.options.reopenRevision !== undefined
        ? this.options.reopenRevision
        : this.documentRevision;
    return { projectId: PROJECT, revisionId, document: this.store };
  }

  private writeDocument(payload: unknown): { kind: string; revisionId: string } {
    const write = payload as { baseRevisionId: string; revisionId: string; document: JoyDocument };
    if (this.options.saveReply === 'conflict' || write.baseRevisionId !== this.documentRevision) {
      return { kind: 'conflict', revisionId: this.documentRevision };
    }
    this.documentRevision = write.revisionId;
    this.store = write.document;
    return { kind: 'saved', revisionId: write.revisionId };
  }

  private derivativeSha(): string {
    return this.options.derivativeSha ?? sha256(this.derivative);
  }

  private jobView(): Record<string, unknown> {
    if (this.options.badJobAnswer === true) return { id: 'job-1', status: 'paused' };
    const status = this.options.jobEnd ?? 'done';
    const view: Record<string, unknown> = {
      id: 'job-1',
      jobType: 'render.export',
      status,
      progress: 1,
      attempts: 1,
      cancelRequested: false,
      createdAt: '2026-11-09T13:00:00.000Z',
      updatedAt: '2026-11-09T13:00:05.000Z',
    };
    if (status === 'failed') {
      view.error = this.options.jobError ?? 'The job failed. Its details are not shown here.';
    }
    if (status === 'done') {
      view.derivative = {
        sha256: this.derivativeSha(),
        bytes: this.derivative.byteLength,
        mimeType: 'video/mp4',
      };
    }
    return view;
  }
}

function checkStatuses(report: ScenarioReport): [string, string][] {
  return report.checks.map((check): [string, string] => [check.name, check.status]);
}

function checkOf(report: ScenarioReport, name: string) {
  return report.checks.find((check) => check.name === name);
}

function expectNoReceipt(report: ScenarioReport): void {
  expect(report.verdict).not.toBe('passed');
  expect(report.receipt).toBeUndefined();
}

describe('restart, save and export scenario', () => {
  it('passes end to end and writes a receipt that the contract accepts', async () => {
    const world = new FakeWorld();
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('passed');
    const receipt = report.receipt;
    if (receipt === undefined) throw new Error('the passing run wrote no receipt');
    expect(
      validateAttendedReceipt(receipt, { scenarioId: SCENARIO, candidateSha: CANDIDATE }),
    ).toEqual([]);
    expect(receipt.schema).toBe(ATTENDED_RECEIPT_SCHEMA);
    expect(receipt.run).toMatchObject({
      mode: 'scripted',
      manual: false,
      operator: 'owner-at-pc',
      attempt: 1,
    });
    expect(receipt.guards).toMatchObject({
      joyKeyBefore: JOY_KEY_EXPECTED_SHA256,
      joyKeyAfter: JOY_KEY_EXPECTED_SHA256,
      ownerLibraryFilesBefore: 3221,
      ownerLibraryFilesAfter: 3221,
      installedFolderTouched: false,
    });
    expect(checkStatuses(report)).toEqual(
      REQUIRED_ATTENDED_CHECKS[SCENARIO].map((name) => [name, 'passed']),
    );
    expect(world.launchesMade).toEqual([1, 2]);
    expect(world.closedAttempts).toEqual([1, 2]);
    expect(world.alive.size).toBe(0);
    expect(world.stagedSpecs).toEqual([
      expect.objectContaining({
        width: 1080,
        height: 1920,
        frameRate: 30,
        frameCount: 90,
        durationUs: 3_000_000,
      }),
    ]);
    expect(world.enqueued).toEqual([
      {
        refId: `export-source-${RUN_ID}`,
        payload: {
          schemaVersion: 1,
          producer: 'browser-staged-preview-export',
          frameCount: 90,
          manifest: {
            projectId: PROJECT,
            revision: 7,
            width: 1080,
            height: 1920,
            frameRate: 30,
            durationUs: 3_000_000,
            preset: 'reels-1080',
          },
        },
      },
    ]);
    expect(world.written.map((entry) => entry.name)).toEqual([EXPORT_FILE_NAME]);
    expect(world.probedNames).toEqual([EXPORT_FILE_NAME]);
    expect(receipt.artifacts).toEqual([
      {
        name: EXPORT_FILE_NAME,
        path: EXPORT_FILE_NAME,
        sha256: sha256(world.derivative),
        bytes: 4096,
      },
    ]);
    expect(world.store.title).toBe(`Attended restart check ${RUN_ID.slice(0, 8)}`);
    expect(world.documentRevision).toBe(REVISION_SAVED);
  });

  it('refuses before any launch when the joy:// key is not the expected value', async () => {
    const world = new FakeWorld({ key: OTHER_KEY });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('refused');
    expect(report.blockers).toEqual(['the joy:// key was not the expected value before launch']);
    expect(world.launchesMade).toEqual([]);
    expect(checkStatuses(report).every(([, status]) => status === 'not-run')).toBe(true);
    expectNoReceipt(report);
  });

  it('refuses before any launch when a JOY process is already running', async () => {
    const world = new FakeWorld({ externalProcesses: 1 });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('refused');
    expect(report.blockers).toEqual(['1 JOY process(es) running before launch']);
    expect(world.launchesMade).toEqual([]);
    expectNoReceipt(report);
  });

  it('refuses before any launch when a guard cannot be read, and says which one', async () => {
    const world = new FakeWorld({ failProcessCount: true });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('refused');
    expect(report.blockers).toEqual([
      'could not read the JOY process count: the process count failed',
    ]);
    expect(world.launchesMade).toEqual([]);
    expectNoReceipt(report);
  });

  it('keeps the other guard reasons when one guard cannot be read', async () => {
    const world = new FakeWorld({ failProcessCount: true, key: OTHER_KEY });
    const report = await runRestartSaveExport(world, input());
    expect(report.blockers).toEqual([
      'could not read the JOY process count: the process count failed',
      'the joy:// key was not the expected value before launch',
    ]);
    expect(world.launchesMade).toEqual([]);
  });

  it('fails the save and closes the app when the stored revision is not saved', async () => {
    const world = new FakeWorld({ saveReply: 'conflict' });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkStatuses(report)[0]).toEqual(['project-saved', 'failed']);
    expect(
      checkStatuses(report)
        .slice(1)
        .every(([, status]) => status === 'not-run'),
    ).toBe(true);
    expect(world.launchesMade).toEqual([1]);
    expect(world.closedAttempts).toEqual([1]);
    expect(world.alive.size).toBe(0);
    expect(world.written).toEqual([]);
    expectNoReceipt(report);
  });

  it('fails the export before any restart when the document has no export preset', async () => {
    const document = { ...baseDocument(), exportPreset: undefined } as unknown as JoyDocument;
    const world = new FakeWorld({ document });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkStatuses(report)).toEqual([
      ['project-saved', 'passed'],
      ['app-restarted', 'not-run'],
      ['project-reopened-after-restart', 'not-run'],
      ['export-completed', 'failed'],
      ['export-probed-playable', 'not-run'],
    ]);
    expect(checkOf(report, 'export-completed')?.detail).toContain('no export preset');
    expect(world.launchesMade).toEqual([1]);
    expect(world.closedAttempts).toEqual([1]);
    expectNoReceipt(report);
  });

  it('finds the root composition through rootCompositionId, not the first composition', async () => {
    const document: JoyDocument = {
      ...baseDocument(),
      rootCompositionId: 'main',
      exportPreset: 'social-h264-aac',
      compositions: {
        other: { width: 1920, height: 1080, durationUs: 9_000_000 },
        main: { width: 1080, height: 1920, durationUs: 4_000_000 },
      },
      universalTimeline: { items: [] },
    };
    // The probe reports the 4-second export that this root composition asks for.
    const world = new FakeWorld({ document, probe: { durationSeconds: 4, frames: 120 } });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('passed');
    expect(world.stagedSpecs[0]).toMatchObject({
      width: 1080,
      height: 1920,
      durationUs: 4_000_000,
      frameCount: 120,
    });
  });

  it('fails the export when the document names a root composition it does not contain', async () => {
    const document: JoyDocument = { ...baseDocument(), rootCompositionId: 'missing' };
    const world = new FakeWorld({ document });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-completed')).toMatchObject({
      status: 'failed',
      detail: 'the root composition missing is missing',
    });
    expectNoReceipt(report);
  });

  it('fails the restart check when the second launch reuses the first process id', async () => {
    const world = new FakeWorld({ samePidOnRelaunch: true });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    const restart = checkOf(report, 'app-restarted');
    expect(restart?.status).toBe('failed');
    expect(restart?.detail).toContain('did not start a new process');
    expect(world.alive.size).toBe(0);
    expectNoReceipt(report);
  });

  it('does not start the app again when the joy:// key changes between the launches', async () => {
    const world = new FakeWorld({ flipKeyAfterLaunch: 1 });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(world.launchesMade).toEqual([1]);
    expect(checkStatuses(report)[1]).toEqual(['app-restarted', 'failed']);
    expect(checkOf(report, 'app-restarted')?.detail).toBe(
      'not started again: the joy:// key was not the expected value between the launches',
    );
    expect(report.blockers).toContain('the joy:// key was not the expected value after the run');
    expectNoReceipt(report);
  });

  it('does not start the app again when the owner library changes between the launches', async () => {
    const world = new FakeWorld({ libraryCounts: [3221, 3222, 3222] });
    const report = await runRestartSaveExport(world, input());
    expect(world.launchesMade).toEqual([1]);
    expect(checkOf(report, 'app-restarted')?.detail).toBe(
      'not started again: the owner asset library changed between the launches (3221 to 3222 files)',
    );
    expectNoReceipt(report);
  });

  it('does not start the app again when the installed folder changes between the launches', async () => {
    const world = new FakeWorld({ installedSignatures: [SIGNATURE, 'installed-2', 'installed-2'] });
    const report = await runRestartSaveExport(world, input());
    expect(world.launchesMade).toEqual([1]);
    expect(checkOf(report, 'app-restarted')?.detail).toBe(
      'not started again: the installed JOY Media folder changed between the launches',
    );
    expectNoReceipt(report);
  });

  it('does not start the app again when a child of the first app is still running', async () => {
    const world = new FakeWorld({ leftoverAfterFirstClose: 1 });
    const report = await runRestartSaveExport(world, input());
    expect(world.launchesMade).toEqual([1]);
    expect(checkOf(report, 'app-restarted')?.detail).toBe(
      'not started again: 1 JOY process(es) running between the launches',
    );
    expectNoReceipt(report);
  });

  it('fails the reopen check when the restarted app reads an older revision', async () => {
    const world = new FakeWorld({ reopenRevision: REVISION_BEFORE });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    const reopened = checkOf(report, 'project-reopened-after-restart');
    expect(reopened?.status).toBe('failed');
    expect(reopened?.detail).toContain(REVISION_BEFORE);
    expect(checkOf(report, 'export-completed')?.status).toBe('not-run');
    expectNoReceipt(report);
  });

  it('fails the export when the job ends as failed, and writes no derivative', async () => {
    const world = new FakeWorld({
      jobEnd: 'failed',
      jobError: 'The job failed. Its details are not shown here.',
    });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-completed')).toMatchObject({
      status: 'failed',
      detail: 'the export job ended as failed: The job failed. Its details are not shown here.',
    });
    expect(world.written).toEqual([]);
    expect(checkOf(report, 'export-probed-playable')?.status).toBe('not-run');
    expectNoReceipt(report);
  });

  it('cancels an export job that is still running at the timeout, and fails the export', async () => {
    const world = new FakeWorld({ jobEnd: 'running' });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-completed')).toMatchObject({
      status: 'failed',
      detail: 'the export job was still running after 900 seconds',
    });
    expect(world.cancelled).toEqual(['job-1']);
    expect(world.closedAttempts).toEqual([1, 2]);
    expectNoReceipt(report);
  });

  it('cancels the export job when its status answer is not one the bridge uses', async () => {
    const world = new FakeWorld({ badJobAnswer: true });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-completed')).toMatchObject({
      status: 'failed',
      detail: 'the job status paused is not one the bridge uses',
    });
    expect(world.cancelled).toEqual(['job-1']);
    expectNoReceipt(report);
  });

  it('fails the export when the derivative does not match its checksum', async () => {
    const world = new FakeWorld({ derivativeSha: 'e'.repeat(64) });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-completed')).toMatchObject({
      status: 'failed',
      detail: 'the derivative does not match its checksum',
    });
    expect(world.written).toEqual([]);
    expectNoReceipt(report);
  });

  it('fails the probe when the export is the wrong size', async () => {
    const world = new FakeWorld({
      probe: { video: { codec: 'h264', width: 1920, height: 1080 } },
    });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    const probed = checkOf(report, 'export-probed-playable');
    expect(probed?.status).toBe('failed');
    expect(probed?.detail).toContain('the video is 1920x1080, expected 1080x1920');
    expectNoReceipt(report);
  });

  it('fails the probe when the export has two video streams', async () => {
    const world = new FakeWorld({ probe: { videoStreams: 2 } });
    const report = await runRestartSaveExport(world, input());
    expect(checkOf(report, 'export-probed-playable')?.detail).toContain(
      'there are 2 video streams, not 1',
    );
    expectNoReceipt(report);
  });

  it('fails the probe when the frame rate or the frame count is not the expected one', async () => {
    const world = new FakeWorld({ probe: { frameRate: 25, frames: 75 } });
    const report = await runRestartSaveExport(world, input());
    expect(checkOf(report, 'export-probed-playable')?.detail).toBe(
      'the frame rate is 25, expected 30; the frame count is 75, expected 90',
    );
    expectNoReceipt(report);
  });

  it('fails the probe when the frame rate or the frame count is missing from the probe', async () => {
    const world = new FakeWorld({ probe: { frameRate: undefined, frames: undefined } });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'export-probed-playable')?.detail).toBe(
      'the frame rate is missing from the probe; the frame count is missing from the probe',
    );
    expectNoReceipt(report);
  });

  it('writes no receipt when the joy:// key changes after the run, even though every check passed', async () => {
    const world = new FakeWorld({ flipKeyAfterLaunch: 2 });
    const report = await runRestartSaveExport(world, input());
    expect(checkStatuses(report).every(([, status]) => status === 'passed')).toBe(true);
    expect(report.blockers).toEqual(['the joy:// key was not the expected value after the run']);
    expectNoReceipt(report);
  });

  it('writes no receipt when the owner asset library changed during the run', async () => {
    const world = new FakeWorld({ libraryCounts: [3221, 3221, 3222] });
    const report = await runRestartSaveExport(world, input());
    expect(checkStatuses(report).every(([, status]) => status === 'passed')).toBe(true);
    expect(report.blockers).toEqual([
      'the owner asset library changed after the run (3221 to 3222 files)',
    ]);
    expectNoReceipt(report);
  });

  it('writes no receipt when the installed JOY Media folder changed during the run', async () => {
    const world = new FakeWorld({ installedSignatures: [SIGNATURE, SIGNATURE, 'installed-2'] });
    const report = await runRestartSaveExport(world, input());
    expect(report.blockers).toEqual(['the installed JOY Media folder changed after the run']);
    expectNoReceipt(report);
  });

  it('fails the restart check when the first window does not close', async () => {
    const world = new FakeWorld({ closeStuckAttempt: 1 });
    const report = await runRestartSaveExport(world, input());
    expect(report.verdict).toBe('failed');
    expect(checkOf(report, 'app-restarted')).toMatchObject({
      status: 'failed',
      detail: 'the window did not close',
    });
    expect(world.launchesMade).toEqual([1]);
    expectNoReceipt(report);
  });

  it('writes no receipt when the second app does not close, and reports the process still running', async () => {
    const world = new FakeWorld({ closeStuckAttempt: 2 });
    const report = await runRestartSaveExport(world, input());
    expect(checkStatuses(report).every(([, status]) => status === 'passed')).toBe(true);
    expect(report.blockers).toEqual([
      'process 4001 did not close: the window did not close',
      '1 JOY process(es) running after the run',
    ]);
    expectNoReceipt(report);
  });
});

describe('scenario helpers', () => {
  it('counts frames the way the worker does, with at least one frame', () => {
    expect(frameCountFor(3_000_000, 30)).toBe(90);
    expect(frameCountFor(1, 30)).toBe(1);
    expect(frameCountFor(60_000_000, 30)).toBe(1800);
  });

  it('sizes each preset as the export core does', () => {
    const fallback = { width: 1920, height: 1080 };
    expect(dimensionsForPreset('reels-1080', fallback)).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsForPreset('shorts-1080', fallback)).toEqual({ width: 1080, height: 1920 });
    expect(dimensionsForPreset('youtube-1080', { width: 1080, height: 1920 })).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(dimensionsForPreset('social-h264-aac', { width: 720, height: 1280 })).toEqual({
      width: 720,
      height: 1280,
    });
    expect(dimensionsForPreset('high-bitrate', { width: 640, height: 480 })).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('takes the export from the timeline end, and from the root composition when there are no items', () => {
    expect(exportExpectation(baseDocument())).toEqual({
      preset: 'reels-1080',
      width: 1080,
      height: 1920,
      frameRate: 30,
      durationUs: 3_000_000,
      frameCount: 90,
    });
    const empty: JoyDocument = { ...baseDocument(), universalTimeline: { items: [] } };
    expect(exportExpectation(empty)).toMatchObject({ durationUs: 60_000_000, frameCount: 1800 });
  });

  it('refuses a document with no export preset or no root composition', () => {
    const noPreset = { ...baseDocument(), exportPreset: undefined } as unknown as JoyDocument;
    expect(() => exportExpectation(noPreset)).toThrow('no export preset');
    const noRoot: JoyDocument = { ...baseDocument(), rootCompositionId: 'main' };
    expect(() => exportExpectation(noRoot)).toThrow('the root composition main is missing');
  });

  it('reads the document counter and moves it on by one', () => {
    expect(documentCounter(REVISION_BEFORE)).toBe(6);
    expect(nextDocumentRevision(REVISION_BEFORE)).toBe(REVISION_SAVED);
    expect(() => nextDocumentRevision('local-revision:v1:no-counter')).toThrow(
      'no document counter',
    );
  });

  it('copies a document with a new title and leaves the original alone', () => {
    const original = baseDocument();
    const copy = withSavedTitle(original, 'New title', '2026-11-09T13:00:00.000Z');
    expect(copy.title).toBe('New title');
    expect(copy.updatedAt).toBe('2026-11-09T13:00:00.000Z');
    expect(original.title).toBe('Attended check A');
  });

  it('accepts a probe that matches the expectation and lists every mismatch in a bad one', () => {
    const expected = exportExpectation(baseDocument());
    const good: MediaProbe = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3.02,
      videoStreams: 1,
      audioStreams: 1,
      video: { codec: 'h264', width: 1080, height: 1920 },
      audioCodec: 'aac',
      frameRate: 30,
      frames: 90,
    };
    expect(probeBlockers(good, expected)).toEqual([]);
    const bad: MediaProbe = {
      formatName: 'matroska,webm',
      durationSeconds: 3.5,
      videoStreams: 1,
      audioStreams: 1,
      video: { codec: 'vp9', width: 720, height: 1280 },
      frameRate: 25,
      frames: 75,
    };
    expect(probeBlockers(bad, expected)).toEqual([
      'the container is matroska,webm, not mp4',
      'the video codec is vp9, not h264',
      'the video is 720x1280, expected 1080x1920',
      'the audio codec is missing, not aac',
      'the frame rate is 25, expected 30',
      'the frame count is 75, expected 90',
      'the duration is 3.5 s, expected 3.000 s within one frame',
    ]);
  });

  it('holds the frame rate to the worker tolerance, and the stream counts to exactly one each', () => {
    const expected = exportExpectation(baseDocument());
    const base: MediaProbe = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreams: 1,
      audioStreams: 1,
      video: { codec: 'h264', width: 1080, height: 1920 },
      audioCodec: 'aac',
      frameRate: 30.005,
      frames: 90,
    };
    expect(probeBlockers(base, expected)).toEqual([]);
    expect(probeBlockers({ ...base, frameRate: 30.02 }, expected)).toEqual([
      'the frame rate is 30.02, expected 30',
    ]);
    expect(probeBlockers({ ...base, audioStreams: 0 }, expected)).toEqual([
      'there are 0 audio streams, not 1',
    ]);
    expect(probeBlockers({ ...base, audioStreams: 2 }, expected)).toEqual([
      'there are 2 audio streams, not 1',
    ]);
  });

  it('builds the payload the worker validates: a frame count that matches the manifest', () => {
    const expected = exportExpectation(baseDocument());
    const payload = renderExportPayload(PROJECT, 7, expected) as {
      frameCount: number;
      manifest: { durationUs: number; frameRate: number; revision: number };
    };
    expect(payload.manifest.revision).toBe(7);
    expect(payload.frameCount).toBe(
      frameCountFor(payload.manifest.durationUs, payload.manifest.frameRate),
    );
  });

  it('names every guard that does not hold, and compares against a reference reading', () => {
    const reference: GuardReadings = {
      joyKeySha256: JOY_KEY_EXPECTED_SHA256,
      joyProcesses: 0,
      ownerLibraryFiles: 3221,
      installedFolder: SIGNATURE,
    };
    expect(guardBlockers(reference, 'now', reference)).toEqual([]);
    expect(
      guardBlockers(
        {
          joyKeySha256: OTHER_KEY,
          joyProcesses: 2,
          ownerLibraryFiles: 1,
          installedFolder: 'other',
        },
        'now',
        reference,
      ),
    ).toEqual([
      'the joy:// key was not the expected value now',
      '2 JOY process(es) running now',
      'the owner asset library changed now (3221 to 1 files)',
      'the installed JOY Media folder changed now',
    ]);
  });

  it('leaves out a guard that could not be read, and judges the others', () => {
    const reading: GuardReadings = {
      joyKeySha256: OTHER_KEY,
      joyProcesses: -1,
      ownerLibraryFiles: 1,
      installedFolder: 'other',
    };
    expect(guardBlockers(reading, 'now', undefined, ['joyProcesses'])).toEqual([
      'the joy:// key was not the expected value now',
    ]);
  });

  it('refuses a job status that the bridge does not use', () => {
    expect(() => asJobView({ id: 'job-1', status: 'paused' })).toThrow(
      'is not one the bridge uses',
    );
    expect(
      asJobView({
        id: 'job-1',
        status: 'done',
        derivative: { sha256: 'a', bytes: 1, mimeType: 'video/mp4' },
      }),
    ).toMatchObject({ id: 'job-1', status: 'done', derivative: { bytes: 1 } });
  });
});
