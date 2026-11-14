/**
 * The export-semantics scenario (`desktop.export-media-semantics`).
 *
 * One process starts on a new profile made in the run folder, on the scratch asset library. Through the UI
 * it creates a project, imports the stereo test clip (h264-16x9-audio.mp4: 1280x720, 30 fps, 3 s, a 440 Hz
 * stereo tone) and adds it to the timeline, imports a still (picture-tiny.png, one solid blue) and adds it
 * after the clip, fills the frame with the still, and adds the Dissolve between them. It captures the
 * Monitor at four frames, exports the timeline with Export MP4, and closes the app. Every measurement is
 * then taken from the files in the run folder:
 *
 * - export-completed: the export finished, was downloaded through the page and is not empty.
 * - stream-layout-matches-preset: an MP4 with one H.264 video stream at the composition size and one AAC
 *   audio stream with two channels (the layout every export preset writes; export-core keeps the
 *   composition size for each preset).
 * - duration-matches-timeline: the file lasts as long as the timeline, within one frame.
 * - frame-count-matches-timeline: ffmpeg decodes exactly the timeline's frame count.
 * - audio-present: both audio channels carry sound (decoded RMS above MIN_AUDIO_RMS_DB).
 * - picture-matches-reference: at three frames, the export frame matches the Monitor capture
 *   (attended-frame-compare.ts: luma SSIM and mean RGB difference on a 160-pixel-wide copy).
 * - dissolve-checked: the timeline holds the Dissolve between the two clips, the export frame in the middle
 *   of it is the blend of the two clips at that progress (and not either clip alone), and it matches the
 *   Monitor capture at that frame.
 *
 * This module does no I/O. The machine side is ExportSemanticsDriver: the real one is in
 * tooling/release/attended/scenario-driver.mjs, and a fake one for the dry run is in
 * attended-export-semantics-dry-run.ts.
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
  EXPORT_FRAME_RATE,
  StepFailure,
  frameCountFor,
  guardBlockers,
  readGuards,
  sha256Hex,
  type AppHandle,
  type GuardDriver,
  type GuardReadings,
  type ScenarioStep,
  type ScenarioVerdict,
} from './attended-scenario.ts';
import { TIMELINE_LOG_KEY, VISUAL_LOG_KEY } from './attended-fresh-process.ts';
import {
  compareFrames,
  compareSizeFor,
  judgeDissolve,
  type FrameComparison,
  type RgbFrame,
} from './attended-frame-compare.ts';

export const EXPORT_SEMANTICS_SCENARIO = 'desktop.export-media-semantics' as const;

/** The stereo clip and the still the run imports, from C:\jgp\v111\fixtures (tooling/qa/fixtures/make-fixtures.ps1). */
export const VIDEO_FIXTURE = 'h264-16x9-audio.mp4';
export const STILL_FIXTURE = 'picture-tiny.png';
/** The video fixture's shape. The dissolve reference frame is read from it, so the composition must have this shape. */
export const VIDEO_FIXTURE_ASPECT = 16 / 9;
export const VIDEO_FIXTURE_FRAME_RATE = 30;

export const SEMANTICS_EXPORT_FILE = 'export.mp4';
export const ACTIVE_PROJECT_KEY = 'joy-media.active-project.v1';

/** The Dissolve card adds `gl:fade`; `dissolve` is the id saved before T-V08 and still resolves to it. */
export const DISSOLVE_TYPES: readonly string[] = ['gl:fade', 'dissolve'];

/** Two clips this close or closer are adjacent (the Transitions panel's junction tolerance). */
export const JUNCTION_TOLERANCE_US = 1_000;

/** A channel whose decoded RMS is at or below this is silent. The fixture's tone is about -21 dB. */
export const MIN_AUDIO_RMS_DB = -50;
export const EXPECTED_AUDIO_CHANNELS = 2;

/** The Monitor capture and export frames are read at these places; a clip shorter than this cannot be sampled. */
const MIN_SAMPLED_SPAN_FRAMES = 4;

export interface SemanticsNames {
  readonly projectTitle: string;
  readonly videoName: string;
  readonly stillName: string;
  /** The timeline labels: the file name without its extension. */
  readonly videoLabel: string;
  readonly stillLabel: string;
}

/** The names a run uses. They come from the run id, so two runs never share a project or a clip. */
export function semanticsNames(runId: string): SemanticsNames {
  const short = runId.replace(/[^0-9a-z]/giu, '').slice(0, 8);
  return {
    projectTitle: `ExportSemantics-${short}`,
    videoName: `semantics-clip-${short}.mp4`,
    stillName: `semantics-still-${short}.png`,
    videoLabel: `semantics-clip-${short}`,
    stillLabel: `semantics-still-${short}`,
  };
}

/** The editor page, as the scenario uses it. The machine side maps each call onto the real UI. */
export interface SemanticsEditorPage {
  /** The library folder the app reports through the bridge. */
  libraryDirectory(): Promise<string>;
  /** Waits until the project library shows its New project control. */
  waitForLibrary(): Promise<void>;
  /** Creates a project with this name and waits until the editor's File menu is shown. */
  createProject(title: string): Promise<void>;
  /**
   * Imports a file through the Media panel's Import media dialog and adds it to the timeline with its
   * card's Add button. With `atFrame`, the playhead is moved to that frame first.
   */
  importAndPlace(
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    options?: { readonly atFrame?: number; readonly frameRate?: number },
  ): Promise<void>;
  /** Selects the timeline clip with this label and presses Fill frame with clip. */
  fillFrame(label: string): Promise<void>;
  /** Selects the timeline clip with this label and adds the Dissolve card. Resolves with the app's notice. */
  addDissolve(label: string): Promise<string>;
  /** The browser storage values for these keys, or null for a key that is absent. */
  readStorage(keys: readonly string[]): Promise<Readonly<Record<string, string | null>>>;
  /**
   * Sets the Monitor to Fit, goes to the frame, and captures the Monitor's frame area (the composition,
   * without overlays) as a PNG.
   */
  capturePreview(
    frame: number,
    composition: { readonly width: number; readonly height: number; readonly frameRate: number },
  ): Promise<Uint8Array>;
  /** Export MP4, then the download of the verified file; resolves with the MP4 bytes. */
  exportMp4(): Promise<Uint8Array>;
  /** The page's visible text and a screenshot, taken when a step fails. */
  snapshot(): Promise<{ readonly text: string; readonly png: Uint8Array }>;
}

/** Where a frame is read from: a video in the run folder, a picture in the run folder, or a fixture. */
export type FrameSource =
  | { readonly kind: 'run-video'; readonly name: string; readonly seconds: number }
  | { readonly kind: 'run-picture'; readonly name: string }
  | { readonly kind: 'fixture-video'; readonly name: string; readonly seconds: number };

export interface SemanticsVideoStream {
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
}

export interface SemanticsAudioStream {
  readonly codec: string;
  readonly channels: number;
  readonly sampleRate: number;
}

/** The fields of an ffprobe report that this scenario reads. */
export interface SemanticsProbe {
  readonly formatName: string;
  readonly durationSeconds: number;
  readonly video: readonly SemanticsVideoStream[];
  readonly audio: readonly SemanticsAudioStream[];
}

/** The machine side of the scenario. The guard readings come from GuardDriver. */
export interface ExportSemanticsDriver extends GuardDriver {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Creates a new, empty profile folder whose database names the given asset library. */
  seedProfile(profile: string, library: string): Promise<void>;
  /** A digest of the owner's Downloads folder. A run must leave it unchanged. */
  downloadsSignature(): Promise<string>;
  launch(attempt: number, profile: string): Promise<AppHandle>;
  attach(app: AppHandle): Promise<SemanticsEditorPage>;
  /** Closes the window, waits for every JOY process to exit, and disconnects the page. */
  close(app: AppHandle, page: SemanticsEditorPage | undefined): Promise<void>;
  /** A fixture's bytes, by file name. */
  readFixture(name: string): Promise<Uint8Array>;
  writeRunFile(name: string, bytes: Uint8Array): Promise<void>;
  /** ffprobe of a file in the run folder. */
  probe(name: string): Promise<SemanticsProbe>;
  /** The number of video frames ffmpeg decodes from a file in the run folder. */
  decodedFrameCount(name: string): Promise<number>;
  /** The decoded RMS level of each audio channel of a file in the run folder, in dB. */
  audioRmsDb(name: string): Promise<readonly number[]>;
  /** One frame, scaled to the size. A video frame is the first one at or after `seconds`. */
  frameOf(
    source: FrameSource,
    size: { readonly width: number; readonly height: number },
  ): Promise<RgbFrame>;
}

export interface ExportSemanticsInput {
  readonly runId: string;
  readonly candidateSha: string;
  readonly exeSha256: string;
  readonly unpackedDir: string;
  /** The scratch asset library, which the profile names. */
  readonly library: string;
  /** A new profile folder. It does not exist when the run starts. */
  readonly profile: string;
  /** The owner library count this run approves. The count before the launch must equal it. */
  readonly approvedOwnerFiles: number;
}

export interface ExportSemanticsReport {
  readonly scenario: typeof EXPORT_SEMANTICS_SCENARIO;
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
  /** What was measured, for reading a run afterwards: the timeline, the probe, every frame compare. */
  readonly measurements: Readonly<Record<string, unknown>>;
  readonly receipt: AttendedReceipt | undefined;
}

// ---------------------------------------------------------------------------------------------------
// The timeline as the editor stores it
// ---------------------------------------------------------------------------------------------------

export interface FactClip {
  readonly id: string;
  readonly trackId: string;
  /** The track's family (`video`, `audio`, …); `video` for a legacy track without one. */
  readonly trackFamily: string;
  readonly assetId?: string;
  readonly displayName?: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly sourceInUs: number;
}

export interface FactTransition {
  readonly id?: string;
  readonly type: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly durationUs: number;
}

export interface TimelineFacts {
  readonly projectId: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** False when the composition carries no frame rate and the editor's export rate was taken. */
  readonly frameRateFromProject: boolean;
  readonly preset?: string;
  readonly clips: readonly FactClip[];
  readonly transitions: readonly FactTransition[];
}

type Stores = Readonly<Record<string, string | null | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(text: string | null | undefined, label: string): unknown {
  if (typeof text !== 'string') throw new Error(`the browser storage has no ${label}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`the stored ${label} is not JSON: ${describeError(error)}`);
  }
}

/** The newest snapshot of one project in a stored log, or undefined when the log has none. */
function latestDocument(
  text: string | null | undefined,
  label: string,
  projectId: string,
): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  const database = parseJson(text, label);
  if (!isRecord(database) || !isRecord(database.projects)) return undefined;
  const project = database.projects[projectId];
  if (!isRecord(project) || !Array.isArray(project.snapshots)) return undefined;
  const latest: unknown = project.snapshots[project.snapshots.length - 1];
  return isRecord(latest) && isRecord(latest.payload) ? latest.payload : undefined;
}

function rateOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (isRecord(value) && typeof value.num === 'number' && typeof value.den === 'number') {
    const rate = value.num / value.den;
    return value.den > 0 && Number.isFinite(rate) && rate > 0 ? rate : undefined;
  }
  return undefined;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assetNames(documents: readonly Record<string, unknown>[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const document of documents) {
    if (!isRecord(document.assets)) continue;
    for (const asset of Object.values(document.assets)) {
      if (isRecord(asset) && typeof asset.id === 'string' && typeof asset.displayName === 'string') {
        names.set(asset.id, asset.displayName);
      }
    }
  }
  return names;
}

function transitionsIn(documents: readonly Record<string, unknown>[]): FactTransition[] {
  const found = new Map<string, FactTransition>();
  for (const document of documents) {
    if (!Array.isArray(document.transitions)) continue;
    for (const entry of document.transitions) {
      if (
        !isRecord(entry) ||
        typeof entry.type !== 'string' ||
        typeof entry.leftClipId !== 'string' ||
        typeof entry.rightClipId !== 'string' ||
        typeof entry.durationUs !== 'number'
      ) {
        continue;
      }
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      const key = id ?? `${entry.leftClipId}>${entry.rightClipId}:${entry.type}`;
      found.set(key, {
        ...(id === undefined ? {} : { id }),
        type: entry.type,
        leftClipId: entry.leftClipId,
        rightClipId: entry.rightClipId,
        durationUs: entry.durationUs,
      });
    }
  }
  return [...found.values()];
}

/**
 * The open project's timeline, from the browser storage the editor writes: the active project id, the
 * newest timeline snapshot (the root composition's size, frame rate, tracks and clips) and the newest
 * visual snapshot (asset names, transitions, export preset). Throws with the reason when a part is missing.
 */
export function timelineFactsFrom(stores: Stores): TimelineFacts {
  const active = parseJson(stores[ACTIVE_PROJECT_KEY], 'active project');
  const projectId = isRecord(active) ? active.projectId : undefined;
  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('the browser storage names no open project');
  }
  const timeline = latestDocument(stores[TIMELINE_LOG_KEY], 'timeline log', projectId);
  if (timeline === undefined) throw new Error(`the stored timeline has no snapshot of ${projectId}`);
  const visual = latestDocument(stores[VISUAL_LOG_KEY], 'visual log', projectId);
  const documents = visual === undefined ? [timeline] : [timeline, visual];

  const compositions = isRecord(timeline.compositions) ? timeline.compositions : {};
  const rootId =
    typeof timeline.rootCompositionId === 'string'
      ? timeline.rootCompositionId
      : Object.keys(compositions).length === 1
        ? Object.keys(compositions)[0]
        : undefined;
  const root = rootId === undefined ? undefined : compositions[rootId];
  if (!isRecord(root)) throw new Error('the stored timeline has no root composition');
  const { width, height } = root;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error('the root composition has no size');
  }
  const storedRate = rateOf(root.frameRate);

  const names = assetNames(documents);
  const clips: FactClip[] = [];
  for (const track of Array.isArray(root.tracks) ? root.tracks : []) {
    if (!isRecord(track) || typeof track.id !== 'string' || !Array.isArray(track.clips)) continue;
    const trackFamily =
      typeof track.family === 'string'
        ? track.family
        : typeof track.kind === 'string'
          ? track.kind
          : 'video';
    for (const clip of track.clips) {
      if (
        !isRecord(clip) ||
        typeof clip.id !== 'string' ||
        !isTime(clip.startUs) ||
        !isTime(clip.durationUs)
      ) {
        continue;
      }
      const assetId = typeof clip.assetId === 'string' ? clip.assetId : undefined;
      const displayName = assetId === undefined ? undefined : names.get(assetId);
      clips.push({
        id: clip.id,
        trackId: track.id,
        trackFamily,
        ...(assetId === undefined ? {} : { assetId }),
        ...(displayName === undefined ? {} : { displayName }),
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs: isTime(clip.sourceInUs) ? clip.sourceInUs : 0,
      });
    }
  }
  const preset = visual !== undefined && typeof visual.exportPreset === 'string' ? visual.exportPreset : undefined;
  return {
    projectId,
    width,
    height,
    frameRate: storedRate ?? EXPORT_FRAME_RATE,
    frameRateFromProject: storedRate !== undefined,
    ...(preset === undefined ? {} : { preset }),
    clips,
    transitions: transitionsIn(documents),
  };
}

/** The keys timelineFactsFrom reads. */
export const TIMELINE_FACT_KEYS: readonly string[] = [
  ACTIVE_PROJECT_KEY,
  TIMELINE_LOG_KEY,
  VISUAL_LOG_KEY,
];

export interface Placement {
  readonly video: FactClip;
  readonly still: FactClip;
}

/** The one picture-track clip of a named file. Audio-family rows (linked audio) are not counted. */
export function clipNamed(facts: TimelineFacts, name: string): FactClip {
  const found = facts.clips.filter(
    (clip) => clip.displayName === name && clip.trackFamily !== 'audio',
  );
  if (found.length !== 1) {
    throw new Error(`the timeline holds ${found.length} clips of ${name}, not 1`);
  }
  return found[0]!;
}

/**
 * The placement the scenario needs: the clip and the still on one track, with the still starting where
 * the clip ends, so there is a cut for the dissolve. Throws with the reason otherwise.
 */
export function placementOf(facts: TimelineFacts, names: SemanticsNames): Placement {
  const video = clipNamed(facts, names.videoName);
  const still = clipNamed(facts, names.stillName);
  if (video.trackId !== still.trackId) {
    throw new Error(`the still is on track ${still.trackId}, not on the clip's track ${video.trackId}`);
  }
  const videoEndUs = video.startUs + video.durationUs;
  if (Math.abs(still.startUs - videoEndUs) > JUNCTION_TOLERANCE_US) {
    throw new Error(
      `the still starts at ${still.startUs} µs, not where the clip ends (${videoEndUs} µs)`,
    );
  }
  return { video, still };
}

/** The Dissolve between the clip and the still. Throws with the reason when there is none, or more than one. */
export function dissolveOf(facts: TimelineFacts, placement: Placement): FactTransition {
  const between = facts.transitions.filter(
    (transition) =>
      transition.leftClipId === placement.video.id &&
      transition.rightClipId === placement.still.id,
  );
  if (between.length !== 1) {
    throw new Error(`the timeline holds ${between.length} transitions between the clips, not 1`);
  }
  const transition = between[0]!;
  if (!DISSOLVE_TYPES.includes(transition.type)) {
    throw new Error(`the transition between the clips is ${transition.type}, not the Dissolve`);
  }
  if (!(transition.durationUs > 0 && transition.durationUs <= placement.video.durationUs)) {
    throw new Error(`the Dissolve lasts ${transition.durationUs} µs, which does not fit the clip`);
  }
  return transition;
}

export interface SemanticsExpectation {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly frameCount: number;
  readonly preset?: string;
}

/** What the export must come out as: the composition's size, the end of the last clip, and its frame count. */
export function expectationFrom(facts: TimelineFacts): SemanticsExpectation {
  const durationUs = facts.clips.reduce(
    (end, clip) => Math.max(end, clip.startUs + clip.durationUs),
    0,
  );
  if (durationUs < 1) throw new Error('the timeline has no duration to export');
  return {
    width: facts.width,
    height: facts.height,
    frameRate: facts.frameRate,
    durationUs,
    frameCount: frameCountFor(durationUs, facts.frameRate),
    ...(facts.preset === undefined ? {} : { preset: facts.preset }),
  };
}

export interface DissolveSample {
  /** The frame in the middle of the dissolve. */
  readonly frame: number;
  /** The dissolve's progress at that frame, 0 to 1. */
  readonly progress: number;
  /** The video fixture's time at that frame: the outgoing clip's own picture there. */
  readonly fromSourceSeconds: number;
  /** A frame of the still alone, after the dissolve: the incoming clip's picture. */
  readonly toFrame: number;
}

export interface SamplePlan {
  /** Three frames where one clip shows alone: two in the clip, one in the still. */
  readonly pictureFrames: readonly number[];
  readonly dissolve?: DissolveSample;
  /** Why no dissolve sample was planned, when a dissolve exists but cannot be sampled. */
  readonly dissolveProblem?: string;
}

/**
 * Where the Monitor and the export are sampled. The dissolve window is [still start - duration, still
 * start), as visual-object-renderer's transitionProgress has it. Throws when a clip is too short to sample.
 */
export function samplePlan(
  placement: Placement,
  transition: FactTransition | undefined,
  expectation: SemanticsExpectation,
): SamplePlan {
  const fps = expectation.frameRate;
  const frameUs = 1_000_000 / fps;
  const frameAt = (us: number): number => Math.round((us * fps) / 1_000_000);
  const dissolveUs = transition?.durationUs ?? 0;
  const windowStartUs = placement.still.startUs - dissolveUs;
  const videoAloneUs = windowStartUs - placement.video.startUs;
  if (videoAloneUs < MIN_SAMPLED_SPAN_FRAMES * frameUs) {
    throw new Error(`the clip shows alone for ${videoAloneUs} µs, too short to sample`);
  }
  if (placement.still.durationUs < MIN_SAMPLED_SPAN_FRAMES * frameUs) {
    throw new Error(`the still lasts ${placement.still.durationUs} µs, too short to sample`);
  }
  const stillFrame = frameAt(placement.still.startUs + placement.still.durationUs / 2);
  const pictureFrames = [
    frameAt(placement.video.startUs + videoAloneUs * 0.25),
    frameAt(placement.video.startUs + videoAloneUs * 0.75),
    Math.min(stillFrame, expectation.frameCount - 1),
  ];
  if (transition === undefined) return { pictureFrames };
  const middle = frameAt(windowStartUs + dissolveUs / 2);
  const progress = (middle * frameUs - windowStartUs) / dissolveUs;
  if (!(progress >= 0.25 && progress <= 0.75)) {
    return {
      pictureFrames,
      dissolveProblem: `the Dissolve lasts ${dissolveUs} µs, too short for a frame near its middle`,
    };
  }
  return {
    pictureFrames,
    dissolve: {
      frame: middle,
      progress,
      fromSourceSeconds:
        (middle * frameUs - placement.video.startUs + placement.video.sourceInUs) / 1_000_000,
      toFrame: pictureFrames[2]!,
    },
  };
}

/** The time a video frame is read at: a quarter frame before it, so the first frame at or after it is that frame. */
export function seekSecondsOf(frame: number, frameRate: number): number {
  return Math.max(0, (frame - 0.25) / frameRate);
}

export function previewFileName(frame: number): string {
  return `preview-frame-${String(frame).padStart(4, '0')}.png`;
}

// ---------------------------------------------------------------------------------------------------
// The measured checks, as pure functions of what was measured
// ---------------------------------------------------------------------------------------------------

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The fields this scenario reads from `ffprobe -print_format json -show_format -show_streams`. */
export function semanticsProbeFrom(value: unknown): SemanticsProbe {
  if (!isRecord(value)) throw new Error('the probe is not a JSON object');
  const streams = Array.isArray(value.streams) ? value.streams.filter(isRecord) : [];
  const format = isRecord(value.format) ? value.format : {};
  return {
    formatName: typeof format.format_name === 'string' ? format.format_name : '',
    durationSeconds: numberOr(format.duration, Number.NaN),
    video: streams
      .filter((stream) => stream.codec_type === 'video')
      .map((stream) => {
        const durationSeconds = numberOr(stream.duration, Number.NaN);
        return {
          codec: String(stream.codec_name ?? ''),
          width: numberOr(stream.width, 0),
          height: numberOr(stream.height, 0),
          ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
        };
      }),
    audio: streams
      .filter((stream) => stream.codec_type === 'audio')
      .map((stream) => ({
        codec: String(stream.codec_name ?? ''),
        channels: numberOr(stream.channels, 0),
        sampleRate: numberOr(stream.sample_rate, 0),
      })),
  };
}

/** The problems with the file's streams: an MP4 with one H.264 video at the composition size and one stereo AAC. */
export function streamLayoutBlockers(
  probe: SemanticsProbe,
  expectation: SemanticsExpectation,
): string[] {
  const blockers: string[] = [];
  if (!probe.formatName.split(',').includes('mp4')) {
    blockers.push(`the container is ${probe.formatName || 'unknown'}, not mp4`);
  }
  if (probe.video.length !== 1) blockers.push(`there are ${probe.video.length} video streams, not 1`);
  if (probe.audio.length !== 1) blockers.push(`there are ${probe.audio.length} audio streams, not 1`);
  const video = probe.video[0];
  if (video !== undefined) {
    if (video.codec !== 'h264') blockers.push(`the video codec is ${video.codec}, not h264`);
    if (video.width !== expectation.width || video.height !== expectation.height) {
      blockers.push(
        `the video is ${video.width}x${video.height}, not the composition's ${expectation.width}x${expectation.height}`,
      );
    }
  }
  const audio = probe.audio[0];
  if (audio !== undefined) {
    if (audio.codec !== 'aac') blockers.push(`the audio codec is ${audio.codec}, not aac`);
    if (audio.channels !== EXPECTED_AUDIO_CHANNELS) {
      blockers.push(`the audio has ${audio.channels} channels, not ${EXPECTED_AUDIO_CHANNELS}`);
    }
    if (!(audio.sampleRate > 0)) blockers.push('the audio has no sample rate');
  }
  return blockers;
}

/** The problems with the file's duration: the container, and the video stream when it says, within one frame. */
export function durationBlockers(
  probe: SemanticsProbe,
  expectation: SemanticsExpectation,
): string[] {
  const expected = expectation.durationUs / 1_000_000;
  const tolerance = 1 / expectation.frameRate + 1e-6;
  const blockers: string[] = [];
  if (!(Math.abs(probe.durationSeconds - expected) <= tolerance)) {
    blockers.push(
      `the file lasts ${probe.durationSeconds} s, not the timeline's ${expected.toFixed(3)} s within one frame`,
    );
  }
  const stream = probe.video[0]?.durationSeconds;
  if (stream !== undefined && !(Math.abs(stream - expected) <= tolerance)) {
    blockers.push(
      `the video stream lasts ${stream} s, not the timeline's ${expected.toFixed(3)} s within one frame`,
    );
  }
  return blockers;
}

export function frameCountBlockers(decoded: number, expectation: SemanticsExpectation): string[] {
  if (!Number.isSafeInteger(decoded) || decoded < 0) return ['the decoded frame count was not read'];
  return decoded === expectation.frameCount
    ? []
    : [`ffmpeg decoded ${decoded} frames, not the timeline's ${expectation.frameCount}`];
}

/** The problems with the sound: one stream, two channels, and each channel above the silence level. */
export function audioBlockers(probe: SemanticsProbe, rmsDb: readonly number[]): string[] {
  if (probe.audio.length === 0) return ['the file has no audio stream'];
  const blockers: string[] = [];
  if (rmsDb.length !== EXPECTED_AUDIO_CHANNELS) {
    blockers.push(`${rmsDb.length} audio channels were decoded, not ${EXPECTED_AUDIO_CHANNELS}`);
  }
  rmsDb.forEach((level, index) => {
    if (!(level > MIN_AUDIO_RMS_DB)) {
      blockers.push(
        `audio channel ${index + 1} is silent (RMS ${level} dB, at or below ${MIN_AUDIO_RMS_DB} dB)`,
      );
    }
  });
  return blockers;
}

/**
 * The RMS level of each channel from ffmpeg's `astats` report (stderr), in channel order. `-inf` is
 * silence. The Overall section is ignored.
 */
export function parseAstatsRms(text: string): number[] {
  const levels: number[] = [];
  let channel: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const heading = /\]\s*Channel:\s*(\d+)\s*$/u.exec(line);
    if (heading !== null) {
      channel = Number(heading[1]);
      continue;
    }
    if (/\]\s*Overall\s*$/u.test(line)) {
      channel = undefined;
      continue;
    }
    const rms = /RMS level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/u.exec(line);
    if (rms !== null && channel !== undefined && levels[channel - 1] === undefined) {
      const value = rms[1]!;
      levels[channel - 1] = value.endsWith('inf') ? Number.NEGATIVE_INFINITY : Number(value);
    }
  }
  return levels.filter((level) => level !== undefined);
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

function normalizeDirectory(path: string): string {
  return path.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();
}

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

async function stage<T>(check: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(check, describeError(error));
  }
}

function orderedChecks(
  results: ReadonlyMap<string, AttendedCheck>,
  required: readonly string[],
): AttendedCheck[] {
  return required.map(
    (name): AttendedCheck => results.get(name) ?? { name, status: 'not-run', detail: 'not reached' },
  );
}

function comparisonSummary(comparison: FrameComparison): Record<string, unknown> {
  return {
    ssim: Number(comparison.ssim.toFixed(4)),
    meanDifference: Number(comparison.meanDifference.toFixed(3)),
    passed: comparison.passed,
    ...(comparison.reason === '' ? {} : { reason: comparison.reason }),
  };
}

interface Session {
  readonly app: AppHandle;
  page: SemanticsEditorPage | undefined;
  closed: boolean;
}

/** The required artifacts: the export and the four Monitor captures. */
const EXPECTED_ARTIFACTS = 5;

/**
 * Runs the export-semantics scenario once. The report carries a receipt only when every required check
 * passed, the guards held before and after, the Downloads folder was left as it was, every artifact was
 * written, and the receipt passes the contract.
 */
export async function runExportMediaSemantics(
  driver: ExportSemanticsDriver,
  input: ExportSemanticsInput,
): Promise<ExportSemanticsReport> {
  if (!Number.isInteger(input.approvedOwnerFiles) || input.approvedOwnerFiles < 1) {
    throw new Error('a run needs an approved owner library count before it can start');
  }
  const required = REQUIRED_ATTENDED_CHECKS[EXPORT_SEMANTICS_SCENARIO];
  const names = semanticsNames(input.runId);
  const startedAt = driver.now().toISOString();
  const results = new Map<string, AttendedCheck>();
  const steps: ScenarioStep[] = [];
  const measurements: Record<string, unknown> = { names };
  const note = (step: string, detail: string): void => {
    steps.push({ at: driver.now().toISOString(), step, detail });
  };
  const pass = (name: string, detail: string): void => {
    results.set(name, { name, status: 'passed', detail });
    note(name, detail);
  };
  const fail = (name: string, detail: string): void => {
    results.set(name, { name, status: 'failed', detail });
    note(name, `failed: ${detail}`);
  };

  const beforeReading = await readGuards(driver);
  const before = beforeReading.guards;
  let downloadsBefore: string | undefined;
  let downloadsError: string | undefined;
  try {
    downloadsBefore = await driver.downloadsSignature();
  } catch (error) {
    downloadsError = describeError(error);
  }
  const refusals = [
    ...beforeReading.readErrors,
    ...guardBlockers(before, 'before launch', undefined, beforeReading.unread, input.approvedOwnerFiles),
    ...(downloadsError === undefined ? [] : [`could not read the Downloads folder: ${downloadsError}`]),
  ];
  const finish = (parts: {
    readonly verdict: ScenarioVerdict;
    readonly launches: number;
    readonly after: GuardReadings | undefined;
    readonly blockers: readonly string[];
    readonly receipt: AttendedReceipt | undefined;
  }): ExportSemanticsReport => ({
    scenario: EXPORT_SEMANTICS_SCENARIO,
    runId: input.runId,
    candidateSha: input.candidateSha,
    verdict: parts.verdict,
    startedAt,
    finishedAt: driver.now().toISOString(),
    launches: parts.launches,
    before,
    after: parts.after,
    checks: orderedChecks(results, required),
    steps,
    blockers: parts.blockers,
    measurements,
    receipt: parts.receipt,
  });
  if (refusals.length > 0) {
    note('refused', refusals.join('; '));
    return finish({ verdict: 'refused', launches: 0, after: undefined, blockers: refusals, receipt: undefined });
  }

  const sessions: Session[] = [];
  const closeErrors: string[] = [];
  const artifacts: AttendedArtifact[] = [];
  let launches = 0;
  let fatal: string | undefined;
  const addArtifact = (name: string, bytes: Uint8Array): void => {
    artifacts.push({ name, path: name, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
  };
  const closeSession = async (session: Session): Promise<void> => {
    if (session.closed) return;
    session.closed = true;
    try {
      await driver.close(session.app, session.page);
    } catch (error) {
      closeErrors.push(`process ${session.app.pid} did not close: ${describeError(error)}`);
    }
  };
  const captureFailure = async (check: string): Promise<void> => {
    const open = [...sessions].reverse().find((session) => !session.closed && session.page !== undefined);
    if (open?.page === undefined) return;
    try {
      const snapshot = await withTimeout(open.page.snapshot(), 45_000);
      await driver.writeRunFile(`failure-${check}.txt`, Buffer.from(snapshot.text, 'utf8'));
      await driver.writeRunFile(`failure-${check}.png`, snapshot.png);
      note('failure-snapshot', `failure-${check}.txt and failure-${check}.png were written`);
    } catch (error) {
      note('failure-snapshot', `not written: ${describeError(error)}`);
    }
  };
  /** A measured check: a failure is recorded for that check only, and the run goes on to the next one. */
  const measure = async (check: string, work: () => Promise<string>): Promise<void> => {
    if (results.has(check)) return;
    try {
      pass(check, await work());
    } catch (error) {
      fail(check, describeError(error));
    }
  };

  try {
    const videoBytes = await stage('export-completed', () => driver.readFixture(VIDEO_FIXTURE));
    const stillBytes = await stage('export-completed', () => driver.readFixture(STILL_FIXTURE));
    await stage('export-completed', () => driver.seedProfile(input.profile, input.library));
    launches += 1;
    const app = await stage('export-completed', () => driver.launch(launches, input.profile));
    const session: Session = { app, page: undefined, closed: false };
    sessions.push(session);
    const page = await stage('export-completed', () => driver.attach(app));
    session.page = page;
    await stage('export-completed', () => page.waitForLibrary());
    const library = await stage('export-completed', () => page.libraryDirectory());
    if (normalizeDirectory(library) !== normalizeDirectory(input.library)) {
      throw new StepFailure('export-completed', `the profile's library is ${library}, not ${input.library}`);
    }
    await stage('export-completed', () => page.createProject(names.projectTitle));
    note('project-created', `${names.projectTitle} on the scratch library ${library}`);

    // Place the stereo clip, then the still where the clip ends, filling the frame.
    const readFacts = (): Promise<TimelineFacts> =>
      stage('export-completed', async () => timelineFactsFrom(await page.readStorage(TIMELINE_FACT_KEYS)));
    await stage('export-completed', () => page.importAndPlace(names.videoName, 'video/mp4', videoBytes));
    const afterVideo = await readFacts();
    const placedVideo = await stage('export-completed', async () => clipNamed(afterVideo, names.videoName));
    const videoEndFrame = Math.round(
      ((placedVideo.startUs + placedVideo.durationUs) * afterVideo.frameRate) / 1_000_000,
    );
    await stage('export-completed', () =>
      page.importAndPlace(names.stillName, 'image/png', stillBytes, {
        atFrame: videoEndFrame,
        frameRate: afterVideo.frameRate,
      }),
    );
    await stage('export-completed', () => page.fillFrame(names.stillLabel));
    let facts = await readFacts();
    const placement = await stage('export-completed', async () => placementOf(facts, names));
    note(
      'media-placed',
      `${names.videoName} at ${placement.video.startUs}–${placement.video.startUs + placement.video.durationUs} µs, ` +
        `${names.stillName} at ${placement.still.startUs}–${placement.still.startUs + placement.still.durationUs} µs, on track ${placement.video.trackId}`,
    );

    // The Dissolve. A failure here fails only the dissolve check; the export and the other checks still run.
    let transition: FactTransition | undefined;
    try {
      const notice = await page.addDissolve(names.stillLabel);
      facts = await readFacts();
      transition = dissolveOf(facts, placement);
      note('dissolve-added', `${transition.type}, ${transition.durationUs} µs; the app said "${notice}"`);
    } catch (error) {
      fail('dissolve-checked', `the Dissolve was not added between the clips: ${describeError(error)}`);
      await captureFailure('dissolve-checked');
    }

    const expectation = await stage('export-completed', async () => expectationFrom(facts));
    measurements.timeline = {
      composition: `${facts.width}x${facts.height}`,
      frameRate: facts.frameRate,
      frameRateFromProject: facts.frameRateFromProject,
      preset: facts.preset ?? 'not stored',
      clips: facts.clips,
      transitions: facts.transitions,
    };
    measurements.expectation = expectation;
    const plan = await stage('picture-matches-reference', async () =>
      samplePlan(placement, transition, expectation),
    );
    measurements.samplePlan = plan;
    if (plan.dissolveProblem !== undefined) fail('dissolve-checked', plan.dissolveProblem);

    // The Monitor captures, before the export. A capture that fails is noted; its check fails below.
    const previews = new Map<number, string>();
    const previewErrors = new Map<number, string>();
    const captureFrames = [
      ...plan.pictureFrames,
      ...(plan.dissolve === undefined ? [] : [plan.dissolve.frame]),
    ];
    for (const frame of captureFrames) {
      try {
        const png = await page.capturePreview(frame, {
          width: facts.width,
          height: facts.height,
          frameRate: facts.frameRate,
        });
        if (png.byteLength === 0) throw new Error('the capture is empty');
        const name = previewFileName(frame);
        await driver.writeRunFile(name, png);
        addArtifact(name, png);
        previews.set(frame, name);
        note('preview-captured', `frame ${frame} as ${name}`);
      } catch (error) {
        previewErrors.set(frame, describeError(error));
        note('preview-captured', `frame ${frame} failed: ${describeError(error)}`);
      }
    }

    // The export, through the UI.
    const exported = await stage('export-completed', () => page.exportMp4());
    if (exported.byteLength === 0) throw new StepFailure('export-completed', 'the export is empty');
    await stage('export-completed', () => driver.writeRunFile(SEMANTICS_EXPORT_FILE, exported));
    addArtifact(SEMANTICS_EXPORT_FILE, exported);
    pass(
      'export-completed',
      `Export MP4 finished and was verified by the app; ${SEMANTICS_EXPORT_FILE} is ${exported.byteLength} bytes, ` +
        `sha256 ${sha256Hex(exported)}`,
    );

    // Everything else is measured from the files, so the app is closed first.
    await closeSession(session);

    let probed: Promise<SemanticsProbe> | undefined;
    const probe = (): Promise<SemanticsProbe> => (probed ??= driver.probe(SEMANTICS_EXPORT_FILE));
    await measure('stream-layout-matches-preset', async () => {
      const report = await probe();
      measurements.probe = report;
      const problems = streamLayoutBlockers(report, expectation);
      if (problems.length > 0) throw new Error(problems.join('; '));
      const audio = report.audio[0]!;
      return (
        `mp4 with one h264 ${expectation.width}x${expectation.height} stream and one aac stream, ` +
        `${audio.channels} channels at ${audio.sampleRate} Hz (preset ${expectation.preset ?? 'not stored'})`
      );
    });
    await measure('duration-matches-timeline', async () => {
      const report = await probe();
      const problems = durationBlockers(report, expectation);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return `${report.durationSeconds.toFixed(3)} s; the timeline ends at ${(expectation.durationUs / 1_000_000).toFixed(3)} s`;
    });
    await measure('frame-count-matches-timeline', async () => {
      const decoded = await driver.decodedFrameCount(SEMANTICS_EXPORT_FILE);
      measurements.decodedFrames = decoded;
      const problems = frameCountBlockers(decoded, expectation);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return `ffmpeg decoded ${decoded} frames, the timeline's ${expectation.frameCount} at ${expectation.frameRate} fps`;
    });
    await measure('audio-present', async () => {
      const report = await probe();
      const levels = await driver.audioRmsDb(SEMANTICS_EXPORT_FILE);
      measurements.audioRmsDb = levels;
      const problems = audioBlockers(report, levels);
      if (problems.length > 0) throw new Error(problems.join('; '));
      return `both channels carry sound: RMS ${levels.map((level) => `${level.toFixed(1)} dB`).join(', ')}`;
    });

    const size = compareSizeFor(expectation.width, expectation.height);
    const exportFrame = (frame: number): Promise<RgbFrame> =>
      driver.frameOf(
        { kind: 'run-video', name: SEMANTICS_EXPORT_FILE, seconds: seekSecondsOf(frame, expectation.frameRate) },
        size,
      );
    const previewFrame = (frame: number): Promise<RgbFrame> => {
      const name = previews.get(frame);
      if (name === undefined) {
        return Promise.reject(
          new Error(`the Monitor capture of frame ${frame} failed: ${previewErrors.get(frame) ?? 'not taken'}`),
        );
      }
      return driver.frameOf({ kind: 'run-picture', name }, size);
    };
    await measure('picture-matches-reference', async () => {
      const compared: Record<string, unknown> = {};
      measurements.picture = compared;
      const problems: string[] = [];
      for (const frame of plan.pictureFrames) {
        const comparison = compareFrames(await previewFrame(frame), await exportFrame(frame));
        compared[`frame-${frame}`] = comparisonSummary(comparison);
        if (!comparison.passed) problems.push(`frame ${frame}: ${comparison.reason}`);
      }
      if (problems.length > 0) throw new Error(problems.join('; '));
      return (
        `the export matches the Monitor at frames ${plan.pictureFrames.join(', ')} ` +
        `(${size.width}x${size.height}; SSIM ${plan.pictureFrames
          .map((frame) => (compared[`frame-${frame}`] as { ssim: number }).ssim.toFixed(3))
          .join(', ')})`
      );
    });
    await measure('dissolve-checked', async () => {
      const sample = plan.dissolve;
      if (sample === undefined || transition === undefined) throw new Error('no Dissolve to check');
      if (Math.abs(expectation.width / expectation.height - VIDEO_FIXTURE_ASPECT) > 0.01) {
        throw new Error(
          `the composition is ${expectation.width}x${expectation.height}, not 16:9 like ${VIDEO_FIXTURE}, so its frame is not a reference`,
        );
      }
      const middle = await exportFrame(sample.frame);
      const from = await driver.frameOf(
        {
          kind: 'fixture-video',
          name: VIDEO_FIXTURE,
          seconds: Math.max(0, sample.fromSourceSeconds - 0.25 / VIDEO_FIXTURE_FRAME_RATE),
        },
        size,
      );
      const to = await exportFrame(sample.toFrame);
      const judgement = judgeDissolve({ middle, from, to, progress: sample.progress });
      const monitor = compareFrames(await previewFrame(sample.frame), middle);
      measurements.dissolve = {
        frame: sample.frame,
        progress: Number(sample.progress.toFixed(4)),
        residual: Number(judgement.residual.toFixed(3)),
        fromDistance: Number(judgement.fromDistance.toFixed(3)),
        toDistance: Number(judgement.toDistance.toFixed(3)),
        clipDifference: Number(judgement.clipDifference.toFixed(3)),
        monitor: comparisonSummary(monitor),
      };
      const problems = [
        ...(judgement.passed ? [] : [judgement.reason]),
        ...(monitor.passed ? [] : [`the Monitor at frame ${sample.frame} differs: ${monitor.reason}`]),
      ];
      if (problems.length > 0) throw new Error(problems.join('; '));
      return (
        `${transition.type} of ${transition.durationUs} µs; frame ${sample.frame} at progress ${sample.progress.toFixed(2)} ` +
        `is ${judgement.residual.toFixed(2)} levels from the blend (${judgement.fromDistance.toFixed(2)} from the clip, ` +
        `${judgement.toDistance.toFixed(2)} from the still) and matches the Monitor (SSIM ${monitor.ssim.toFixed(3)})`
      );
    });
  } catch (error) {
    if (error instanceof StepFailure) {
      fail(error.check, error.message);
      await captureFailure(error.check);
    } else {
      fatal = describeError(error);
      note('error', fatal);
    }
  } finally {
    for (const session of sessions) await closeSession(session);
  }

  const afterReading = await readGuards(driver);
  const after = afterReading.guards;
  const blockers: string[] = [];
  if (fatal !== undefined) blockers.push(fatal);
  blockers.push(...closeErrors, ...afterReading.readErrors);
  blockers.push(...guardBlockers(after, 'after the run', before, afterReading.unread));
  try {
    if ((await driver.downloadsSignature()) !== downloadsBefore) {
      blockers.push('the Downloads folder changed during the run');
    }
  } catch (error) {
    blockers.push(`could not read the Downloads folder after the run: ${describeError(error)}`);
  }

  const checks = orderedChecks(results, required);
  const allPassed = checks.every((check) => check.status === 'passed');
  let receipt: AttendedReceipt | undefined;
  if (allPassed && blockers.length === 0 && artifacts.length === EXPECTED_ARTIFACTS) {
    const candidate: AttendedReceipt = {
      schema: ATTENDED_RECEIPT_SCHEMA,
      scenario: { id: EXPORT_SEMANTICS_SCENARIO, status: 'passed', firstAttemptPassed: true, retries: 0 },
      candidateSha: input.candidateSha,
      app: { exeSha256: input.exeSha256, unpackedDir: input.unpackedDir },
      run: {
        id: input.runId,
        attempt: 1,
        startedAt,
        finishedAt: driver.now().toISOString(),
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
    const problems = validateAttendedReceipt(candidate, {
      scenarioId: EXPORT_SEMANTICS_SCENARIO,
      candidateSha: input.candidateSha,
    });
    if (problems.length === 0) receipt = candidate;
    else blockers.push(...problems.map((problem) => `receipt refused: ${problem}`));
  } else if (allPassed && blockers.length === 0) {
    blockers.push(`${artifacts.length} artifacts were written, not ${EXPECTED_ARTIFACTS}`);
  }

  return finish({
    verdict: receipt === undefined ? 'failed' : 'passed',
    launches,
    after,
    blockers,
    receipt,
  });
}
