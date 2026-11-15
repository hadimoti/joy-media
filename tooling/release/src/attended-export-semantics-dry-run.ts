/**
 * The dry run of the export-semantics scenario: the same scenario code, run against a fake driver, so it
 * needs no app, no ffmpeg and no owner. Nothing is launched, read from the owner's folders or written
 * outside the run folder the caller chooses.
 *
 * The fake models one timeline, as the live run builds it: the stereo clip at 0–3 s and the still at
 * 3–6 s on one track, with a 0.5 s Dissolve, in a 1920x1080 composition at 30 fps. Its frames are made up
 * (a moving gradient for the clip, solid blue for the still), so the frame compare and the dissolve check
 * do real arithmetic on them. Faults make each check fail on purpose; the unit tests use them.
 *
 * The in-memory dry-run receipt is evidence that the code path works, never that the app works: its
 * candidate is all zeros and its app hash is the hash of a fixed text. The CLI omits it from dry-run.json.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { JOY_KEY_EXPECTED_SHA256 } from './attended-receipt.ts';
import type { AppHandle } from './attended-scenario.ts';
import { TIMELINE_LOG_KEY, VISUAL_LOG_KEY } from './attended-fresh-process.ts';
import { blendFrames, type RgbFrame } from './attended-frame-compare.ts';
import {
  ACTIVE_PROJECT_KEY,
  VIDEO_FIXTURE,
  runExportMediaSemantics,
  type ExportSemanticsDriver,
  type ExportSemanticsInput,
  type ExportSemanticsReport,
  type FrameSource,
  type SemanticsEditorPage,
  type SemanticsProbe,
} from './attended-export-semantics.ts';

export const DRY_RUN_CANDIDATE = '0'.repeat(40);
export const DRY_RUN_EXE_SHA256 = createHash('sha256')
  .update('JOY Media export-semantics dry run: no app')
  .digest('hex');
export const DRY_RUN_OWNER_FILES = 3221;
export const DRY_RUN_LIBRARY = 'C:\\dry-run\\library';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const VIDEO_US = 3_000_000;
const STILL_US = 3_000_000;
const DISSOLVE_US = 500_000;
const PROJECT_ID = 'project-dry-run';
/** The still: picture-tiny.png is one solid colour, 0x2a6fdb. */
const STILL_RGB: readonly [number, number, number] = [0x2a, 0x6f, 0xdb];

/** Ways to make the fake world go wrong, one check at a time. */
export interface DryRunFaults {
  readonly joyKey?: string;
  readonly downloadsChange?: boolean;
  readonly libraryReported?: string;
  readonly exportFails?: boolean;
  readonly emptyExport?: boolean;
  readonly stillOnOtherTrack?: boolean;
  readonly noDissolve?: boolean;
  readonly dissolveType?: string;
  /** The export cuts from the clip to the still with no blend, though the timeline has the Dissolve. */
  readonly hardCut?: boolean;
  readonly exportSize?: { readonly width: number; readonly height: number };
  readonly audioChannels?: number;
  readonly noAudioStream?: boolean;
  readonly durationOffsetSeconds?: number;
  readonly frameCountOffset?: number;
  readonly silentChannel?: number;
  /** The Monitor shows a black picture at the first sampled frame. */
  readonly previewBlackFirst?: boolean;
  /** The Monitor shows the clip 1.5 s later than the export at every frame. */
  readonly previewLate?: boolean;
  readonly previewFails?: boolean;
  readonly closeFails?: boolean;
}

function clipRgb(x: number, y: number, width: number, height: number, frame: number): number[] {
  // A gradient whose green and blue bands move with the frame, so different times give different pictures.
  const r = Math.round((x * 255) / Math.max(1, width - 1));
  const g = (Math.round((y * 255) / Math.max(1, height - 1)) + frame * 8) % 256;
  const b = 64 + ((x * 3 + y + frame * 4) % 128);
  return [r, g, b];
}

function fill(
  size: { readonly width: number; readonly height: number },
  pixel: (x: number, y: number) => readonly number[],
): RgbFrame {
  const data = new Uint8Array(size.width * size.height * 3);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * size.width + x) * 3;
      data[offset] = r!;
      data[offset + 1] = g!;
      data[offset + 2] = b!;
    }
  }
  return { width: size.width, height: size.height, data };
}

function clipFrame(
  size: { readonly width: number; readonly height: number },
  frame: number,
): RgbFrame {
  return fill(size, (x, y) => clipRgb(x, y, size.width, size.height, frame));
}

function stillFrame(size: { readonly width: number; readonly height: number }): RgbFrame {
  return fill(size, () => STILL_RGB);
}

function blackFrame(size: { readonly width: number; readonly height: number }): RgbFrame {
  return fill(size, () => [0, 0, 0]);
}

/** The first frame at or after a time, as the real driver's ffmpeg select gives it. */
function frameAtOrAfter(seconds: number): number {
  return Math.max(0, Math.ceil(seconds * FPS - 1e-9));
}

interface FakeClip {
  id: string;
  trackId: string;
  assetId: string;
  displayName: string;
  startUs: number;
  durationUs: number;
}

interface FakeTransition {
  id: string;
  type: string;
  trackId: string;
  leftClipId: string;
  rightClipId: string;
  durationUs: number;
}

/** The fake world: one app, one project, the run folder's files. */
export class DryRunWorld implements ExportSemanticsDriver {
  readonly faults: DryRunFaults;
  readonly files = new Map<string, Uint8Array>();
  readonly events: string[] = [];
  readonly clips: FakeClip[] = [];
  readonly transitions: FakeTransition[] = [];
  private clock = 0;
  private downloadReads = 0;
  private alive = false;

  constructor(faults: DryRunFaults = {}) {
    this.faults = faults;
  }

  now(): Date {
    this.clock += 1000;
    return new Date(Date.UTC(2026, 10, 15, 10, 0, 0) + this.clock);
  }

  async sleep(): Promise<void> {}

  async joyKeySha256(): Promise<string> {
    return this.faults.joyKey ?? JOY_KEY_EXPECTED_SHA256;
  }

  async joyProcessCount(): Promise<number> {
    return this.alive ? 1 : 0;
  }

  async ownerLibraryFileCount(): Promise<number> {
    return DRY_RUN_OWNER_FILES;
  }

  async installedFolderSignature(): Promise<string> {
    return 'installed-folder-unchanged';
  }

  async downloadsSignature(): Promise<string> {
    this.downloadReads += 1;
    return this.faults.downloadsChange === true && this.downloadReads > 1 ? 'changed' : 'downloads';
  }

  async seedProfile(profile: string, library: string): Promise<void> {
    this.events.push(`seed ${profile} ${library}`);
  }

  async launch(attempt: number): Promise<AppHandle> {
    this.alive = true;
    this.events.push(`launch ${attempt}`);
    return { pid: 40_000 + attempt, attempt };
  }

  async attach(): Promise<SemanticsEditorPage> {
    return new DryRunPage(this);
  }

  async close(app: AppHandle): Promise<void> {
    this.events.push(`close ${app.pid}`);
    if (this.faults.closeFails === true) throw new Error('the window stayed open');
    this.alive = false;
  }

  async readFixture(name: string): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(`dry-run fixture ${name}`));
  }

  async writeRunFile(name: string, bytes: Uint8Array): Promise<void> {
    this.files.set(name, bytes);
  }

  /** The timeline's end, from the clips placed so far. */
  durationUs(): number {
    return this.clips.reduce((end, clip) => Math.max(end, clip.startUs + clip.durationUs), 0);
  }

  async probe(name: string): Promise<SemanticsProbe> {
    if (!this.files.has(name)) throw new Error(`ffprobe failed on ${name}: no such file`);
    const seconds = this.durationUs() / 1_000_000 + (this.faults.durationOffsetSeconds ?? 0);
    const size = this.faults.exportSize ?? { width: WIDTH, height: HEIGHT };
    return {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: seconds,
      video: [{ codec: 'h264', width: size.width, height: size.height, durationSeconds: seconds }],
      audio:
        this.faults.noAudioStream === true
          ? []
          : [{ codec: 'aac', channels: this.faults.audioChannels ?? 2, sampleRate: 48_000 }],
    };
  }

  async decodedFrameCount(): Promise<number> {
    return Math.round((this.durationUs() / 1_000_000) * FPS) + (this.faults.frameCountOffset ?? 0);
  }

  async audioRmsDb(): Promise<readonly number[]> {
    if (this.faults.noAudioStream === true) return [];
    const channels = this.faults.audioChannels ?? 2;
    return Array.from({ length: channels }, (_unused, index) =>
      this.faults.silentChannel === index + 1 ? Number.NEGATIVE_INFINITY : -24.3,
    );
  }

  /** The export's picture at a frame: the clip, the blend in the Dissolve's window, then the still. */
  renderedFrame(
    size: { readonly width: number; readonly height: number },
    frame: number,
    options: { readonly ignoreDissolve?: boolean } = {},
  ): RgbFrame {
    const timeUs = (frame * 1_000_000) / FPS;
    const video = this.clips.find((clip) => clip.displayName.endsWith('.mp4'));
    const still = this.clips.find((clip) => clip.displayName.endsWith('.png'));
    const transition = options.ignoreDissolve === true ? undefined : this.transitions[0];
    if (still !== undefined && timeUs >= still.startUs) return stillFrame(size);
    if (video === undefined) return blackFrame(size);
    const windowStart =
      still === undefined || transition === undefined
        ? Infinity
        : still.startUs - transition.durationUs;
    if (timeUs >= windowStart && transition !== undefined) {
      const progress = (timeUs - windowStart) / transition.durationUs;
      return blendFrames(clipFrame(size, frame), stillFrame(size), progress);
    }
    return clipFrame(size, frame);
  }

  async frameOf(
    source: FrameSource,
    size: { readonly width: number; readonly height: number },
  ): Promise<RgbFrame> {
    if (source.kind === 'fixture-video') {
      if (source.name !== VIDEO_FIXTURE) throw new Error(`${source.name} is not a video fixture`);
      return clipFrame(size, frameAtOrAfter(source.seconds));
    }
    const bytes = this.files.get(source.name);
    if (bytes === undefined) throw new Error(`${source.name} is not in the run folder`);
    if (source.kind === 'run-video') {
      return this.renderedFrame(size, frameAtOrAfter(source.seconds), {
        ignoreDissolve: this.faults.hardCut === true,
      });
    }
    // A Monitor capture: the page wrote which frame it shows, and how.
    const capture = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      readonly frame: number;
      readonly black?: boolean;
    };
    if (capture.black === true) return blackFrame(size);
    return this.renderedFrame(size, capture.frame);
  }
}

/** The fake editor page. Its storage has the shapes the editor writes. */
class DryRunPage implements SemanticsEditorPage {
  private readonly world: DryRunWorld;
  private captures = 0;

  constructor(world: DryRunWorld) {
    this.world = world;
  }

  async libraryDirectory(): Promise<string> {
    return this.world.faults.libraryReported ?? DRY_RUN_LIBRARY;
  }

  async waitForLibrary(): Promise<void> {}

  async createProject(title: string): Promise<void> {
    this.world.events.push(`create ${title}`);
  }

  async importAndPlace(
    name: string,
    mimeType: string,
    _bytes: Uint8Array,
    options: { readonly atFrame?: number } = {},
  ): Promise<void> {
    this.world.events.push(`import ${name} ${mimeType}`);
    const isStill = mimeType.startsWith('image/');
    const index = this.world.clips.length + 1;
    this.world.clips.push({
      id: `clip-${index}`,
      trackId: isStill && this.world.faults.stillOnOtherTrack === true ? 'track-v2' : 'track-v1',
      assetId: `asset-${index}`,
      displayName: name,
      startUs: options.atFrame === undefined ? 0 : Math.round((options.atFrame * 1_000_000) / FPS),
      durationUs: isStill ? STILL_US : VIDEO_US,
    });
  }

  async fillFrame(label: string): Promise<void> {
    this.world.events.push(`fill ${label}`);
  }

  async addDissolve(label: string): Promise<string> {
    this.world.events.push(`dissolve ${label}`);
    const [left, right] = this.world.clips;
    if (this.world.faults.noDissolve === true || left === undefined || right === undefined) {
      return 'Select two adjacent clips on one video track to add a transition.';
    }
    this.world.transitions.push({
      id: 'transition-1',
      type: this.world.faults.dissolveType ?? 'gl:fade',
      trackId: left.trackId,
      leftClipId: left.id,
      rightClipId: right.id,
      durationUs: DISSOLVE_US,
    });
    return 'Added Dissolve';
  }

  async readStorage(keys: readonly string[]): Promise<Readonly<Record<string, string | null>>> {
    const tracks = [...new Set(this.world.clips.map((clip) => clip.trackId))].map((trackId) => ({
      id: trackId,
      kind: 'video',
      family: 'video',
      clips: this.world.clips
        .filter((clip) => clip.trackId === trackId)
        .map((clip) => ({
          id: clip.id,
          kind: 'video',
          assetId: clip.assetId,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          sourceInUs: 0,
        })),
    }));
    const timeline = {
      schemaVersion: 0,
      id: PROJECT_ID,
      rootCompositionId: 'root',
      compositions: {
        root: { id: 'root', width: WIDTH, height: HEIGHT, frameRate: { num: FPS, den: 1 }, tracks },
      },
    };
    const visual = {
      id: PROJECT_ID,
      exportPreset: 'social-h264-aac',
      assets: Object.fromEntries(
        this.world.clips.map((clip) => [
          clip.assetId,
          { id: clip.assetId, displayName: clip.displayName },
        ]),
      ),
      transitions: this.world.transitions,
    };
    const log = (payload: unknown): string =>
      JSON.stringify({ projects: { [PROJECT_ID]: { snapshots: [{ payload }] } } });
    const stored: Record<string, string> = {
      [ACTIVE_PROJECT_KEY]: JSON.stringify({ projectId: PROJECT_ID }),
      [TIMELINE_LOG_KEY]: log(timeline),
      [VISUAL_LOG_KEY]: log(visual),
    };
    return Object.fromEntries(keys.map((key) => [key, stored[key] ?? null]));
  }

  async capturePreview(frame: number): Promise<Uint8Array> {
    if (this.world.faults.previewFails === true)
      throw new Error('the Monitor did not reach the frame');
    this.captures += 1;
    const shown = this.world.faults.previewLate === true ? frame + 45 : frame;
    const black = this.world.faults.previewBlackFirst === true && this.captures === 1;
    return new Uint8Array(Buffer.from(JSON.stringify({ frame: shown, black })));
  }

  async exportMp4(): Promise<Uint8Array> {
    if (this.world.faults.exportFails === true)
      throw new Error('the render did not verify: Failed — encoder');
    if (this.world.faults.emptyExport === true) return new Uint8Array();
    return new Uint8Array(Buffer.from(`dry-run export of ${this.world.durationUs()} µs`));
  }

  async snapshot(): Promise<{ readonly text: string; readonly png: Uint8Array }> {
    return { text: 'dry-run page text', png: new Uint8Array([137, 80, 78, 71]) };
  }
}

/** The scenario input of a dry run. Only the run id and the candidate may be chosen. */
export function dryRunInput(
  options: { readonly runId?: string; readonly candidateSha?: string } = {},
): ExportSemanticsInput {
  return {
    runId: options.runId ?? 'dry-run-00000000-0000-4000-8000-000000000000',
    candidateSha: options.candidateSha ?? DRY_RUN_CANDIDATE,
    exeSha256: DRY_RUN_EXE_SHA256,
    unpackedDir: 'dry-run: no app was used',
    library: DRY_RUN_LIBRARY,
    profile: 'C:\\dry-run\\profile',
    approvedOwnerFiles: DRY_RUN_OWNER_FILES,
  };
}

/** Runs the scenario once against the fake world. */
export async function runExportSemanticsDryRun(
  options: {
    readonly runId?: string;
    readonly candidateSha?: string;
    readonly faults?: DryRunFaults;
  } = {},
): Promise<{ readonly report: ExportSemanticsReport; readonly world: DryRunWorld }> {
  const world = new DryRunWorld(options.faults);
  const report = await runExportMediaSemantics(world, dryRunInput(options));
  return { report, world };
}
