import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  ATTENDED_RECEIPT_SCHEMA,
  JOY_KEY_EXPECTED_SHA256,
  REQUIRED_ATTENDED_CHECKS,
  validateAttendedReceipt,
} from './attended-receipt.ts';
import { sha256Hex, type AppHandle, type MediaProbe } from './attended-scenario.ts';
import {
  CATALOG_KEY,
  FRESH_PROCESS_SCENARIO,
  PACKAGE_FILE_NAME,
  RENDER_FILE_NAME,
  TIMELINE_LOG_KEY,
  VISUAL_LOG_KEY,
  freshNames,
  freshStoreBlockers,
  libraryDirectoryOf,
  packageBlockers,
  packageProblems,
  renderBlockers,
  renderMatchesClip,
  runFreshProcessPersistence,
  sourceStoreBlockers,
  type FreshEditorPage,
  type FreshProcessDriver,
  type FreshProcessInput,
} from './attended-fresh-process.ts';

const RUN_ID = '2b0f6c7e-3c1d-4f5a-9d2e-6a8b7c9d0e1f';
const CANDIDATE = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
const EXE_SHA256 = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const LIBRARY = 'C:\\jgp\\attended-ded976c8-20261109\\library';
const SOURCE_PROFILE = 'C:\\jgp\\run\\profile-source';
const FRESH_PROFILE = 'C:\\jgp\\run\\profile-fresh';
const CLIP = new Uint8Array(Buffer.from('fixture clip bytes'));
const RENDER = new Uint8Array(Buffer.from('mp4 bytes from the render'));
const names = freshNames(RUN_ID);
const expectation = {
  sourceTitle: names.sourceTitle,
  clipName: names.clipName,
  clipSha256: sha256Hex(CLIP),
};
const REQUIRED = REQUIRED_ATTENDED_CHECKS[FRESH_PROCESS_SCENARIO];

interface Faults {
  joyKey?: string;
  joyProcesses?: number;
  libraryFiles?: readonly number[];
  downloads?: readonly string[];
  downloadsUnreadable?: boolean;
  packageTitle?: string;
  missingMedia?: boolean;
  sourceCatalogMissing?: boolean;
  noticeOverride?: string;
  noHeading?: boolean;
  renderProbe?: Partial<MediaProbe>;
  noVideoStream?: boolean;
  renderFails?: boolean;
  freshStoreMissingClip?: boolean;
  freshCatalogHasSource?: boolean;
  libraryReported?: string;
  sourceLibraryReported?: string;
  joyProcessesAfterFirstClose?: number;
  joyProcessesAfterSecondClose?: number;
  joyKeyAfterFirstClose?: string;
  closeFails?: number;
}

function input(): FreshProcessInput {
  return {
    runId: RUN_ID,
    candidateSha: CANDIDATE,
    exeSha256: EXE_SHA256,
    unpackedDir: 'C:\\jgp\\attended-ded976c8-20261109\\app',
    library: LIBRARY,
    sourceProfile: SOURCE_PROFILE,
    freshProfile: FRESH_PROFILE,
    approvedOwnerFiles: 3221,
  };
}

/** A fake editor page. Its storage follows the shapes the scenario reads, and it keeps state per process. */
class FakePage implements FreshEditorPage {
  project: string | undefined;
  timeline: string[] = [];
  catalogTitles: string[] = [];

  constructor(
    private readonly driver: FakeFreshDriver,
    private readonly isFresh: boolean,
  ) {
    if (isFresh && driver.faults.freshCatalogHasSource) this.catalogTitles = [names.sourceTitle];
  }

  async libraryDirectory(): Promise<string> {
    return this.isFresh
      ? (this.driver.faults.libraryReported ?? LIBRARY)
      : (this.driver.faults.sourceLibraryReported ?? LIBRARY);
  }

  async waitForLibrary(): Promise<void> {}

  async createProject(title: string): Promise<void> {
    this.project = title;
    this.timeline = [];
    if (!this.isFresh && !this.driver.faults.sourceCatalogMissing) this.catalogTitles.push(title);
  }

  async importClip(name: string): Promise<void> {
    this.timeline.push(name);
  }

  async timelineClipCount(name: string): Promise<number> {
    return this.timeline.filter((label) => label === name).length;
  }

  async exportEditablePackage(): Promise<Uint8Array> {
    const media = {
      asset: {
        id: 'asset-src',
        displayName: names.clipName,
        sha256: sha256Hex(CLIP),
        bytes: CLIP.byteLength,
        descriptor: { mimeType: 'video/mp4' },
      },
      status: this.driver.faults.missingMedia ? 'missing' : 'embedded',
      dataBase64: this.driver.faults.missingMedia
        ? undefined
        : Buffer.from(CLIP).toString('base64'),
    };
    const pkg = {
      format: 'joy-media-project',
      schemaVersion: 1,
      app: 'JOY Media',
      exportedAt: '2026-11-09T10:00:00.000Z',
      source: {
        id: 'project-src',
        title: this.driver.faults.packageTitle ?? this.project,
        createdAt: '2026-11-09T09:59:00.000Z',
        updatedAt: '2026-11-09T10:00:00.000Z',
      },
      documents: {
        timeline: {
          id: 'project-src',
          compositions: {
            root: { tracks: [{ clips: [{ kind: 'video', assetId: 'asset-src' }] }] },
          },
        },
        visual: {
          id: 'project-src',
          assets: { 'asset-src': { id: 'asset-src', displayName: names.clipName } },
        },
      },
      media: [media],
    };
    return new Uint8Array(Buffer.from(JSON.stringify(pkg)));
  }

  async importEditablePackage(_name: string, bytes: Uint8Array): Promise<string> {
    this.driver.events.push('import');
    const pkg = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      source: { title: string };
      media: { status: string }[];
    };
    this.project = pkg.source.title;
    this.timeline = [names.clipName];
    this.catalogTitles.push(pkg.source.title);
    if (this.driver.faults.noticeOverride !== undefined) return this.driver.faults.noticeOverride;
    const complete = pkg.media.every((entry) => entry.status === 'embedded');
    return complete
      ? `Imported \u201C${pkg.source.title}\u201D with all media available.`
      : `Imported \u201C${pkg.source.title}\u201D; 1 media file needs relinking.`;
  }

  async activeProjectTitle(): Promise<string | null> {
    if (this.driver.faults.noHeading) return null;
    return this.project ?? null;
  }

  async readStorage(keys: readonly string[]): Promise<Readonly<Record<string, string | null>>> {
    const values: Record<string, string | null> = {};
    for (const key of keys) values[key] = this.stored(key);
    return values;
  }

  private stored(key: string): string | null {
    const project = this.project ?? 'project';
    if (key === CATALOG_KEY) {
      const projects = Object.fromEntries(
        this.catalogTitles.map((title) => [title, { id: title, title }]),
      );
      return JSON.stringify({ version: 4, projects });
    }
    if (this.timeline.length === 0) return null;
    const assetId = this.isFresh ? 'asset-fresh' : 'asset-src';
    if (key === TIMELINE_LOG_KEY) {
      const clips = this.timeline.map((label) => ({ kind: 'video', assetId, label }));
      return JSON.stringify({
        projects: {
          [project]: {
            snapshots: [{ payload: { compositions: { root: { tracks: [{ clips }] } } } }],
          },
        },
      });
    }
    if (key === VISUAL_LOG_KEY) {
      const displayName =
        this.isFresh && this.driver.faults.freshStoreMissingClip ? 'other.mp4' : names.clipName;
      return JSON.stringify({
        projects: {
          [project]: {
            snapshots: [{ payload: { assets: { [assetId]: { id: assetId, displayName } } } }],
          },
        },
      });
    }
    return null;
  }

  async snapshot(): Promise<{ readonly text: string; readonly png: Uint8Array }> {
    return { text: 'fake page text', png: new Uint8Array([137, 80, 78, 71]) };
  }

  async renderMp4(): Promise<Uint8Array> {
    if (this.driver.faults.renderFails) throw new Error('the render ended as failed');
    this.driver.events.push('render');
    return RENDER;
  }
}

/** A fake driver. Every guard reading comes from the faults, and every call is recorded in order. */
class FakeFreshDriver implements FreshProcessDriver {
  readonly events: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly seeded: string[] = [];
  launches = 0;
  private clock = 0;
  private libraryReads = 0;
  private downloadReads = 0;

  constructor(readonly faults: Faults = {}) {}

  now(): Date {
    this.clock += 1000;
    return new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + this.clock);
  }

  async sleep(): Promise<void> {}

  async joyKeySha256(): Promise<string> {
    if (this.faults.joyKeyAfterFirstClose !== undefined && this.afterFirstClose()) {
      return this.faults.joyKeyAfterFirstClose;
    }
    return this.faults.joyKey ?? JOY_KEY_EXPECTED_SHA256;
  }

  async joyProcessCount(): Promise<number> {
    if (this.faults.joyProcessesAfterFirstClose !== undefined && this.afterFirstClose()) {
      return this.faults.joyProcessesAfterFirstClose;
    }
    if (this.faults.joyProcessesAfterSecondClose !== undefined && this.events.includes('close 2')) {
      return this.faults.joyProcessesAfterSecondClose;
    }
    return this.faults.joyProcesses ?? 0;
  }

  /** True once the first process has closed, which is when the readings in between the launches are taken. */
  private afterFirstClose(): boolean {
    return this.events.includes('close 1');
  }

  async ownerLibraryFileCount(): Promise<number> {
    const sequence = this.faults.libraryFiles ?? [3221];
    const value = sequence[Math.min(this.libraryReads, sequence.length - 1)] ?? 3221;
    this.libraryReads += 1;
    return value;
  }

  async installedFolderSignature(): Promise<string> {
    return 'installed-1';
  }

  async seedProfile(profile: string, library: string): Promise<void> {
    this.events.push(`seed ${profile}`);
    if (library !== LIBRARY)
      throw new Error(`the profile names ${library}, not the scratch library`);
    this.seeded.push(profile);
  }

  async downloadsSignature(): Promise<string> {
    if (this.faults.downloadsUnreadable) throw new Error('access denied');
    const sequence = this.faults.downloads ?? ['5 files'];
    const value = sequence[Math.min(this.downloadReads, sequence.length - 1)] ?? '5 files';
    this.downloadReads += 1;
    return value;
  }

  async launch(attempt: number, profile: string): Promise<AppHandle> {
    this.launches += 1;
    this.events.push(`launch ${attempt} ${profile}`);
    return { pid: 4000 + attempt, attempt };
  }

  async attach(app: AppHandle): Promise<FreshEditorPage> {
    return new FakePage(this, app.attempt === 2);
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async close(app: AppHandle): Promise<void> {
    this.events.push(`close ${app.attempt}`);
    if (this.faults.closeFails === app.attempt) {
      throw new Error(`process ${app.pid} is still running`);
    }
  }

  async readClipFixture(): Promise<Uint8Array> {
    return CLIP;
  }

  async probeMedia(): Promise<MediaProbe> {
    const common = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      audioStreams: 1,
      audioCodec: 'aac',
      frameRate: 30,
      frames: 90,
    };
    const probe: MediaProbe = this.faults.noVideoStream
      ? { ...common, videoStreams: 0 }
      : {
          ...common,
          videoStreams: 1,
          video: { codec: 'h264', width: 1080, height: 1920 },
        };
    return { ...probe, ...this.faults.renderProbe };
  }

  async probeClip(): Promise<MediaProbe> {
    return {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreams: 1,
      audioStreams: 1,
      video: { codec: 'h264', width: 1080, height: 1920 },
    };
  }

  async writeRunFile(name: string, bytes: Uint8Array): Promise<void> {
    this.files.set(name, bytes);
  }
}

/** The detail text of one named check, which carries the guard or step failure that stopped it. */
function checkDetail(
  report: { readonly checks: readonly { readonly name: string; readonly detail?: string }[] },
  name: string,
): string {
  return report.checks.find((check) => check.name === name)?.detail ?? '';
}

function expectNoReceipt(report: { receipt: unknown }): void {
  expect(report.receipt).toBeUndefined();
}

function failedCheck(
  report: { checks: readonly { name: string; status: string }[] },
  name: string,
) {
  return report.checks.find((check) => check.name === name)?.status;
}

describe('the library folder reply', () => {
  it('reads the folder from the info the preload hands back', () => {
    expect(
      libraryDirectoryOf({
        directory: LIBRARY,
        exists: true,
        hasCatalog: true,
        isDefault: false,
        counts: { total: 0, audio: 0, image: 0 },
      }),
    ).toBe(LIBRARY);
  });

  it('refuses the wrapped shape, which the preload never returns', () => {
    expect(() => libraryDirectoryOf({ ok: true, data: { directory: LIBRARY } })).toThrow(
      'the app reported no library folder',
    );
  });

  it('refuses a missing or empty folder', () => {
    expect(() => libraryDirectoryOf(undefined)).toThrow('the app reported no library folder');
    expect(() => libraryDirectoryOf({ directory: '' })).toThrow(
      'the app reported no library folder',
    );
  });
});

describe('the fresh-process scenario, end to end', () => {
  it('passes both processes and writes a receipt the contract accepts', async () => {
    const driver = new FakeFreshDriver();
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('passed');
    expect(report.launches).toBe(2);
    expect(report.blockers).toEqual([]);
    expect(report.checks.map((check) => check.name)).toEqual([...REQUIRED]);
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(driver.events).toEqual([
      `seed ${SOURCE_PROFILE}`,
      `launch 1 ${SOURCE_PROFILE}`,
      'close 1',
      `seed ${FRESH_PROFILE}`,
      `launch 2 ${FRESH_PROFILE}`,
      'import',
      'render',
      'close 2',
    ]);
    expect(driver.files.has(PACKAGE_FILE_NAME)).toBe(true);
    expect(driver.files.has(RENDER_FILE_NAME)).toBe(true);
    expect(report.receipt?.schema).toBe(ATTENDED_RECEIPT_SCHEMA);
    expect(report.receipt?.artifacts.map((artifact) => artifact.name)).toEqual([
      PACKAGE_FILE_NAME,
      RENDER_FILE_NAME,
    ]);
    expect(
      validateAttendedReceipt(report.receipt, {
        scenarioId: FRESH_PROCESS_SCENARIO,
        candidateSha: CANDIDATE,
      }),
    ).toEqual([]);
  });

  it('refuses to start a run that has no approved owner library count', async () => {
    const withoutCount = {
      ...input(),
      approvedOwnerFiles: undefined,
    } as unknown as FreshProcessInput;

    await expect(runFreshProcessPersistence(new FakeFreshDriver(), withoutCount)).rejects.toThrow(
      'a run needs an approved owner library count',
    );
  });

  it('refuses before any launch when the owner library count is not the approved one', async () => {
    const driver = new FakeFreshDriver({ libraryFiles: [3221] });
    const report = await runFreshProcessPersistence(driver, {
      ...input(),
      approvedOwnerFiles: 3222,
    });

    expect(report.verdict).toBe('refused');
    expect(report.launches).toBe(0);
    expect(driver.events).toEqual([]);
    expect(report.blockers).toEqual([
      'the owner library has 3221 files, not the 3222 approved for this run before launch',
    ]);
    expectNoReceipt(report);
  });

  it('lets a launch through when the owner library count is the approved one', async () => {
    const driver = new FakeFreshDriver({ libraryFiles: [3221] });
    const report = await runFreshProcessPersistence(driver, {
      ...input(),
      approvedOwnerFiles: 3221,
    });

    expect(report.verdict).toBe('passed');
  });

  it('refuses before any launch when the joy:// key is not the expected value', async () => {
    const driver = new FakeFreshDriver({ joyKey: 'b'.repeat(64) });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('refused');
    expect(report.launches).toBe(0);
    expect(driver.events).toEqual([]);
    expect(report.blockers.join(' ')).toContain('joy:// key');
    expectNoReceipt(report);
  });

  it('refuses before any launch when a JOY process is already running', async () => {
    const driver = new FakeFreshDriver({ joyProcesses: 1 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('refused');
    expect(report.launches).toBe(0);
    expect(report.blockers.join(' ')).toContain('JOY process');
  });

  it('refuses before any launch when the Downloads folder cannot be read', async () => {
    const driver = new FakeFreshDriver({ downloadsUnreadable: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('refused');
    expect(report.launches).toBe(0);
    expect(report.blockers.join(' ')).toContain('Downloads folder');
  });
});

describe('the first process: the editable package and the saved state', () => {
  it('writes the page text and a screenshot into the run folder when a step fails', async () => {
    const driver = new FakeFreshDriver({ packageTitle: 'Some other project' });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(driver.files.has('failure-editable-project-exported.txt')).toBe(true);
    expect(driver.files.has('failure-editable-project-exported.png')).toBe(true);
    expect(report.steps.some((step) => step.step === 'failure-snapshot')).toBe(true);
  });

  it('fails the first check when the source profile names another library', async () => {
    const driver = new FakeFreshDriver({
      sourceLibraryReported: 'C:\\Users\\HadiMoti\\joy-media-assets',
    });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'editable-project-exported')).toBe('failed');
    expect(report.verdict).toBe('failed');
    expect(report.launches).toBe(1);
  });

  it('fails when the package carries another title, and the second process never starts', async () => {
    const driver = new FakeFreshDriver({ packageTitle: 'Some other project' });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(failedCheck(report, 'editable-project-exported')).toBe('failed');
    expect(report.launches).toBe(1);
    expect(driver.seeded).toEqual([SOURCE_PROFILE]);
    expectNoReceipt(report);
  });

  it('fails when a media entry is missing from the package', async () => {
    const driver = new FakeFreshDriver({ missingMedia: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'editable-project-exported')).toBe('failed');
    expect(report.verdict).toBe('failed');
    expect(report.launches).toBe(1);
  });

  it('fails when the source profile has not saved the project in its catalog', async () => {
    const driver = new FakeFreshDriver({ sourceCatalogMissing: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'editable-project-exported')).toBe('failed');
    expect(report.blockers).toEqual([]);
  });

  it('fails the export check when the first process does not close, and names that process as a blocker', async () => {
    const driver = new FakeFreshDriver({ closeFails: 1 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(failedCheck(report, 'editable-project-exported')).toBe('failed');
    expect(report.launches).toBe(1);
    expect(report.blockers).toContain('process 4001 did not close: process 4001 is still running');
    expectNoReceipt(report);
  });

  it('names the second process as a blocker when it does not close, and writes no receipt', async () => {
    const driver = new FakeFreshDriver({ closeFails: 2 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(report.blockers).toContain('process 4002 did not close: process 4002 is still running');
    expectNoReceipt(report);
  });
});

describe('the second process: the import, the render and the fresh saved state', () => {
  it('fails the render check when the render ends as failed', async () => {
    const driver = new FakeFreshDriver({ renderFails: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'export-from-fresh-profile-probed')).toBe('failed');
    expect(report.verdict).toBe('failed');
    expectNoReceipt(report);
  });

  it('fails the import check when the notice reports a missing file', async () => {
    const driver = new FakeFreshDriver({
      noticeOverride: `Imported \u201C${names.sourceTitle}\u201D; 1 media file needs relinking.`,
    });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'project-imported-in-fresh-profile')).toBe('failed');
    expect(driver.events).not.toContain('render');
    expect(driver.files.has(RENDER_FILE_NAME)).toBe(false);
    expectNoReceipt(report);
  });

  it('fails the import check when the open project is not the imported one', async () => {
    const driver = new FakeFreshDriver({ noHeading: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'project-imported-in-fresh-profile')).toBe('failed');
    expect(report.verdict).toBe('failed');
  });

  it('passes the import when the app showed no notice but the imported project is open', async () => {
    const driver = new FakeFreshDriver({ noticeOverride: '' });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('passed');
    expect(failedCheck(report, 'project-imported-in-fresh-profile')).toBe('passed');
    expect(
      report.checks.find((check) => check.name === 'project-imported-in-fresh-profile')?.detail,
    ).toContain('the app showed no notice');
  });

  it('fails the render check when the file has no video stream', async () => {
    const driver = new FakeFreshDriver({ noVideoStream: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'export-from-fresh-profile-probed')).toBe('failed');
    expectNoReceipt(report);
  });

  it('fails the render check when the render does not last as long as the imported clip', async () => {
    const driver = new FakeFreshDriver({ renderProbe: { durationSeconds: 9 } });
    const report = await runFreshProcessPersistence(driver, input());

    const render = report.checks.find((check) => check.name === 'export-from-fresh-profile-probed');
    expect(render?.status).toBe('failed');
    expect(render?.detail).toContain('lasts 9.000 s');
    expectNoReceipt(report);
  });

  it('fails the import check when the fresh profile does not store the clip', async () => {
    const driver = new FakeFreshDriver({ freshStoreMissingClip: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'project-imported-in-fresh-profile')).toBe('failed');
    expect(failedCheck(report, 'export-from-fresh-profile-probed')).toBe('passed');
    expect(report.verdict).toBe('failed');
    expectNoReceipt(report);
  });

  it('fails the start check when the fresh profile already holds the source project', async () => {
    const driver = new FakeFreshDriver({ freshCatalogHasSource: true });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'fresh-profile-started')).toBe('failed');
    expect(driver.events).not.toContain('import');
  });

  it('fails the start check when the fresh profile reports another library', async () => {
    const driver = new FakeFreshDriver({
      libraryReported: 'C:\\Users\\HadiMoti\\joy-media-assets',
    });
    const report = await runFreshProcessPersistence(driver, input());

    expect(failedCheck(report, 'fresh-profile-started')).toBe('failed');
    expect(report.verdict).toBe('failed');
  });

  it('reports a fresh process that does not close as a blocker, and refuses the receipt', async () => {
    const driver = new FakeFreshDriver({ closeFails: 2 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.blockers.join(' ')).toContain('did not close');
    expect(report.verdict).toBe('failed');
    expectNoReceipt(report);
  });
});

describe('the guards between and after the processes', () => {
  it('does not start the second process when a JOY process runs in between', async () => {
    const driver = new FakeFreshDriver({ joyProcessesAfterFirstClose: 1 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(failedCheck(report, 'fresh-profile-started')).toBe('failed');
    expect(checkDetail(report, 'fresh-profile-started')).toContain(
      'JOY process(es) running between the launches',
    );
    expect(report.launches).toBe(1);
    expect(driver.seeded).toEqual([SOURCE_PROFILE]);
  });

  it('does not start the second process when the joy:// key changed in between', async () => {
    const driver = new FakeFreshDriver({ joyKeyAfterFirstClose: 'b'.repeat(64) });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(failedCheck(report, 'fresh-profile-started')).toBe('failed');
    expect(checkDetail(report, 'fresh-profile-started')).toContain(
      'the joy:// key was not the expected value between the launches',
    );
    expect(report.launches).toBe(1);
    expect(driver.seeded).toEqual([SOURCE_PROFILE]);
  });

  it('does not start the second process when the owner library changed in between', async () => {
    const driver = new FakeFreshDriver({ libraryFiles: [3221, 3222, 3222] });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.verdict).toBe('failed');
    expect(failedCheck(report, 'fresh-profile-started')).toBe('failed');
    expect(checkDetail(report, 'fresh-profile-started')).toContain(
      'the owner asset library changed between the launches',
    );
    expect(report.launches).toBe(1);
    expect(driver.seeded).toEqual([SOURCE_PROFILE]);
    expectNoReceipt(report);
  });

  it('blocks the receipt when a JOY process runs after the second process closes', async () => {
    const driver = new FakeFreshDriver({ joyProcessesAfterSecondClose: 1 });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.launches).toBe(2);
    expect(report.verdict).toBe('failed');
    expect(report.blockers.join(' ')).toContain('JOY process(es) running after the run');
    expectNoReceipt(report);
  });

  it('blocks the receipt when the Downloads folder gains a file', async () => {
    const driver = new FakeFreshDriver({ downloads: ['5 files', '5 files, one rewritten'] });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(report.blockers.join(' ')).toContain('Downloads folder changed');
    expect(report.verdict).toBe('failed');
    expectNoReceipt(report);
  });

  it('blocks the receipt when the owner library changed after the run', async () => {
    const driver = new FakeFreshDriver({ libraryFiles: [3221, 3221, 3225] });
    const report = await runFreshProcessPersistence(driver, input());

    expect(report.blockers.join(' ')).toContain('owner asset library changed');
    expectNoReceipt(report);
  });
});

describe('the package and store helpers', () => {
  function packageValue(): Record<string, unknown> {
    return {
      format: 'joy-media-project',
      schemaVersion: 1,
      app: 'JOY Media',
      source: { id: 'project-src', title: names.sourceTitle },
      documents: {
        timeline: { compositions: { root: { tracks: [{ clips: [{ assetId: 'asset-src' }] }] } } },
        visual: { assets: { 'asset-src': { id: 'asset-src' } } },
      },
      media: [
        {
          asset: { id: 'asset-src', displayName: names.clipName },
          status: 'embedded',
          dataBase64: Buffer.from(CLIP).toString('base64'),
        },
      ],
    };
  }

  it('accepts a complete package that embeds the clip byte for byte', () => {
    expect(packageBlockers(packageValue(), expectation)).toEqual([]);
    expect(
      packageProblems(new Uint8Array(Buffer.from(JSON.stringify(packageValue()))), expectation),
    ).toEqual([]);
  });

  it('still accepts a package written under the old JOY Studio name', () => {
    expect(packageBlockers({ ...packageValue(), app: 'JOY Studio' }, expectation)).toEqual([]);
  });

  it('refuses a package written by another app', () => {
    expect(packageBlockers({ ...packageValue(), app: 'Other Editor' }, expectation)).toEqual([
      'the package was not written by JOY Media',
    ]);
  });

  it('refuses text that is not JSON, and a value that is not an object', () => {
    expect(packageProblems(new Uint8Array(Buffer.from('{ not json')), expectation)[0]).toContain(
      'not JSON',
    );
    expect(packageBlockers('a string', expectation)).toEqual(['the package is not a JSON object']);
  });

  it('refuses a package in another format or schema version', () => {
    const value = { ...packageValue(), format: 'other', schemaVersion: 2 };
    const blockers = packageBlockers(value, expectation);
    expect(blockers).toContain('the package format is other');
    expect(blockers).toContain('the package schema version is not 1');
  });

  it('refuses an embedded clip whose bytes differ from the clip that was imported', () => {
    const value = packageValue();
    const [media] = value.media as { dataBase64: string }[];
    if (media === undefined) throw new Error('the fixture package has no media entry');
    media.dataBase64 = Buffer.from('other bytes').toString('base64');
    expect(packageBlockers(value, expectation).join(' ')).toContain(
      'not the clip that was imported',
    );
  });

  it('refuses a timeline that does not reference the embedded clip', () => {
    const value = packageValue();
    value.documents = {
      ...(value.documents as Record<string, unknown>),
      timeline: { compositions: {} },
    };
    expect(packageBlockers(value, expectation).join(' ')).toContain('does not reference');
  });

  it('accepts an MP4 with a video stream and a positive duration, and refuses the rest', () => {
    const good: MediaProbe = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreams: 1,
      audioStreams: 0,
      video: { codec: 'h264', width: 1080, height: 1920 },
    };
    expect(renderBlockers(good)).toEqual([]);
    expect(renderBlockers({ ...good, formatName: 'matroska,webm' })[0]).toContain('not MP4');
    expect(renderBlockers({ ...good, durationSeconds: 0 })).toContain(
      'the render duration is not positive',
    );
    expect(renderBlockers({ ...good, video: { codec: 'h264', width: 0, height: 0 } })).toContain(
      'the render video has no size',
    );
  });

  it('accepts a render within half a second of the clip and refuses a longer or shorter one', () => {
    const clip: MediaProbe = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreams: 1,
      audioStreams: 1,
    };
    expect(renderMatchesClip({ ...clip, durationSeconds: 3.4 }, clip)).toEqual([]);
    expect(renderMatchesClip({ ...clip, durationSeconds: 2.4 }, clip)[0]).toContain(
      'lasts 2.400 s',
    );
    expect(renderMatchesClip(clip, { ...clip, durationSeconds: 0 })[0]).toContain(
      'no positive duration',
    );
  });

  it('checks the first process store for the clip and the project', () => {
    const good = {
      [TIMELINE_LOG_KEY]: `{"label":"${names.clipName}"}`,
      [CATALOG_KEY]: `{"projects":{"${names.sourceTitle}":{}}}`,
    };
    expect(sourceStoreBlockers(good, names)).toEqual([]);
    expect(sourceStoreBlockers({ ...good, [CATALOG_KEY]: '{}' }, names).join(' ')).toContain(
      'catalog does not hold',
    );
  });

  it('checks the fresh store for the imported project and a clip named after the media', () => {
    const timeline = JSON.stringify({
      projects: {
        p: {
          snapshots: [
            {
              payload: {
                compositions: { root: { tracks: [{ clips: [{ assetId: 'asset-fresh' }] }] } },
              },
            },
          ],
        },
      },
    });
    const visual = JSON.stringify({
      projects: {
        p: {
          snapshots: [
            {
              payload: {
                assets: { 'asset-fresh': { id: 'asset-fresh', displayName: names.clipName } },
              },
            },
          ],
        },
      },
    });
    const catalog = `{"projects":{"${names.sourceTitle}":{}}}`;
    expect(
      freshStoreBlockers(
        { [TIMELINE_LOG_KEY]: timeline, [VISUAL_LOG_KEY]: visual, [CATALOG_KEY]: catalog },
        names,
      ),
    ).toEqual([]);
    expect(
      freshStoreBlockers(
        {
          [TIMELINE_LOG_KEY]: timeline,
          [VISUAL_LOG_KEY]: visual.replace(names.clipName, 'other.mp4'),
          [CATALOG_KEY]: catalog,
        },
        names,
      ).join(' '),
    ).toContain('does not store a timeline clip');
    expect(
      freshStoreBlockers({ [TIMELINE_LOG_KEY]: timeline, [VISUAL_LOG_KEY]: visual }, names).join(
        ' ',
      ),
    ).toContain('catalog does not hold');
  });

  it('derives distinct names from distinct run ids', () => {
    const other = freshNames('9a1b2c3d-0000-4000-8000-000000000000');
    expect(names.clipName).toBe('fresh-process-2b0f6c7e.mp4');
    expect(other.clipName).not.toBe(names.clipName);
    expect(names.sourceTitle).not.toBe(other.sourceTitle);
  });
});
