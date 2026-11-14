/**
 * Host-side QC adapter (card T-B04b). It is the one object that backs the three
 * QC agent tools (`qc_report_read`, `media_frames_view`, `media_contact_sheet`)
 * on the trusted main thread, as ADR-0045 sections 3 to 5 describe.
 *
 * What it does:
 *  - Runs the timeline check on request: plans the samples, samples composed
 *    frames with the T-B03 sampler into a private evidence store, and builds one
 *    report from the sampler's safe-area and contrast results. The report lists
 *    the frame ids it holds and what it did not sample.
 *  - Serves frame review and contact sheets ONLY for frame ids that report lists.
 *  - Keeps every gate in front of any pixel: the cached image probe, privacy
 *    mode, the user consent card and the per-call frame cap. Each gate is checked
 *    in the bridge order and checked again inside `reviewFrames`, so a caller that
 *    skips the bridge still cannot send a frame. A missing port fails closed.
 *  - Exposes `runDesktopMediaQc`, the smallest typed call to the existing
 *    desktop QC job route (the file check). Nothing in the editor feeds it an
 *    export reference yet.
 *
 * What remains (nothing below is faked; each missing port refuses with a plain
 * reason):
 *  1. Composition capture. The editor has no isolated RenderFrameIR evaluator and
 *     renderer for evidence capture yet, so `timeline().composition` is supplied
 *     by the host as `undefined` today and the timeline check refuses with
 *     `composition-unavailable`. It will run as soon as the host supplies that
 *     request. The editor also has no projection of title and caption boxes from
 *     the document, so `textBoxes` is empty until one exists.
 *  2. The private one-shot image transport (`transport`) and the consent card
 *     (`requestConsent`). The existing worker transfer accepts source ranges
 *     only, and a QC frame is a composition frame, so it needs a composition
 *     range and a QC lease. Without both ports the image probe gate reports
 *     "unavailable" and no consent card is ever shown.
 *  3. The final export path. `final-encoded-export-decoder.ts` is not called
 *     here: an export has no reference the editor can hand to the Worker QC job
 *     and no decoded frame list. A file report is stored with
 *     `storeFileReport` and lists no frames, so frame tools refuse for it.
 */

import {
  createTimelineContactSheet,
  MAX_TIMELINE_CONTACT_SHEET_FRAMES,
} from '../media-observation/contact-sheet.js';
import type { CompositionObservationRequest } from '../media-observation/composition-observer.js';
import {
  createEvidenceStore,
  type EvidenceFrameArtifact,
  type EvidenceManifestLookup,
  type EvidenceStore,
} from '../media-observation/evidence-store.js';
import {
  createTimelineQcSampler,
  planTimelineQcSampling,
  timelineQcFrameId,
  type TimelineQcSampleRequest,
  type TimelineQcSampleResult,
  type TimelineQcTextAnalysis,
  type TimelineQcTextBox,
} from '../media-observation/qc-sampler.js';
import type { HostRpcHandlerContext, HostRpcJson } from './host-rpc.js';
import type {
  JoyAgentQcFrameReviewRefusal,
  JoyAgentQcFrameReviewRequest,
  JoyAgentQcFrameReviewSuccess,
  JoyAgentQcReportReadRequest,
  JoyAgentQcToolAdapter,
} from './tool-bridge.js';

/** Even-spaced frames per check (ADR-0045 section 8 default). Cuts and text midpoints add to it. */
export const DEFAULT_QC_EVEN_FRAME_COUNT = 12;
/** The report's hard frame ceiling, the largest per-run budget the tool loop accepts. */
export const MAX_QC_REPORT_FRAMES = 48;
const MAX_STORED_REPORTS = 8;
const MINIMUM_CONTRAST_FOR_MAJOR = 3;
const QC_FALLBACK_MODEL_ID = 'local-qc';
const QC_POLICY_DIGEST = 'qc-v1';
const LATEST_REPORT_ALIAS = 'latest';

export type QcTimelineSourceUnavailableReason = 'composition-unavailable';

/** What the host knows about the current cut. All values are detached copies. */
export interface QcTimelineSource {
  readonly durationUs: number;
  readonly cutTimesUs: readonly number[];
  readonly textBoxes: readonly TimelineQcTextBox[];
  /** Undefined when the host cannot capture composed frames. */
  readonly composition: Omit<CompositionObservationRequest, 'outputTimesUs'> | undefined;
}

export interface QcTimelineLike {
  readonly rootCompositionId: string;
  readonly compositions: Readonly<
    Record<
      string,
      | {
          readonly tracks: readonly {
            readonly clips: readonly { readonly startUs: number; readonly durationUs: number }[];
          }[];
        }
      | undefined
    >
  >;
}

/**
 * Derives the duration and the hard cuts (clip starts after zero) from the
 * canonical timeline. It does not invent a composition renderer: that part is
 * supplied by the host or stays absent.
 */
export function qcTimelineSourceFromTimeline(
  timeline: QcTimelineLike,
  composition: QcTimelineSource['composition'] = undefined,
  textBoxes: readonly TimelineQcTextBox[] = [],
): QcTimelineSource | undefined {
  const root = timeline.compositions[timeline.rootCompositionId];
  if (root === undefined) return undefined;
  let durationUs = 0;
  const starts = new Set<number>();
  for (const track of root.tracks) {
    for (const clip of track.clips) {
      if (!Number.isSafeInteger(clip.startUs) || !Number.isSafeInteger(clip.durationUs)) continue;
      if (clip.startUs < 0 || clip.durationUs < 1) continue;
      durationUs = Math.max(durationUs, clip.startUs + clip.durationUs);
      starts.add(clip.startUs);
    }
  }
  if (durationUs < 1) return undefined;
  const cutTimesUs = [...starts]
    .filter((timeUs) => timeUs > 0 && timeUs < durationUs)
    .sort((left, right) => left - right);
  return Object.freeze({ durationUs, cutTimesUs, textBoxes, composition });
}

export interface QcHostIdentity {
  readonly runId: string;
  readonly projectId: string;
  readonly revision: string;
  readonly modelId: string;
  readonly promptPolicyDigest: string;
}

export interface QcFrameConsentRequest {
  readonly reportId: string;
  readonly tool: JoyAgentQcFrameReviewRequest['tool'];
  readonly frameIds: readonly string[];
  readonly frameCount: number;
  readonly approximateBytes: number;
  readonly modelId: string;
}

export interface QcFrameTransportInput {
  readonly reportId: string;
  readonly tool: JoyAgentQcFrameReviewRequest['tool'];
  readonly reason: string | undefined;
  readonly frames: readonly EvidenceFrameArtifact[];
  /** Present only for a contact sheet: the one picture that is sent instead of the frames. */
  readonly contactSheet: Blob | undefined;
  readonly signal: AbortSignal;
}

/** The private one-shot image call. It returns bounded analysis text and never bytes. */
export interface QcFrameTransport {
  analyze(
    input: QcFrameTransportInput,
  ): Promise<{ readonly ok: true; readonly analysis: string } | { readonly ok: false }>;
}

export interface QcHostAdapterDeps {
  readonly evidenceStore: EvidenceStore;
  readonly identity: () => QcHostIdentity | undefined;
  readonly timeline: () => QcTimelineSource | undefined;
  readonly sampler?: {
    sample(request: TimelineQcSampleRequest): Promise<TimelineQcSampleResult>;
  };
  /** Cached synthetic probe result for the active model. Never triggers a probe. */
  readonly isCachedImageSupported: () => boolean;
  readonly isPrivacyModeAllowed: () => boolean;
  /** The consent card. Resolves true only after the user's explicit approval. */
  readonly requestConsent?: (
    request: QcFrameConsentRequest,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly transport?: QcFrameTransport;
  readonly createContactSheet?: typeof createTimelineContactSheet;
  readonly evenFrameCount?: number;
  readonly now?: () => number;
  /** SHA-256 hex of a text. Defaults to the platform digest. */
  readonly digest?: (text: string) => Promise<string>;
}

export type QcTimelineCheckResult =
  | { readonly ok: true; readonly reportId: string }
  | {
      readonly ok: false;
      readonly code:
        | QcTimelineSourceUnavailableReason
        | 'authority-unavailable'
        | 'sampling-failed'
        | 'cancelled';
      readonly message: string;
    };

export interface QcHostAdapter extends JoyAgentQcToolAdapter {
  /** Host action: sample the current cut and store one report. Not a model tool. */
  runTimelineCheck(signal: AbortSignal): Promise<QcTimelineCheckResult>;
  /** Keeps a file report (the Worker's output) so it can be read back. It lists no frames. */
  storeFileReport(report: Readonly<Record<string, unknown>>): string | undefined;
  dispose(): void;
}

interface StoredReport {
  readonly report: { readonly [key: string]: HostRpcJson };
  readonly lookup: EvidenceManifestLookup | undefined;
  readonly frameIds: ReadonlySet<string>;
  readonly approvedFrameIds: Set<string>;
}

/** Builds one adapter for one agent run. */
export function createQcHostAdapter(deps: QcHostAdapterDeps): QcHostAdapter {
  const reports = new Map<string, StoredReport>();
  let latestReportId: string | undefined;
  let counter = 0;
  let inflight: Promise<QcTimelineCheckResult> | undefined;
  let disposed = false;
  const now = deps.now ?? Date.now;
  const digest = deps.digest ?? sha256Hex;
  const sheetFactory = deps.createContactSheet ?? createTimelineContactSheet;
  const evenCount = clampInteger(deps.evenFrameCount ?? DEFAULT_QC_EVEN_FRAME_COUNT, 1, 16);

  const remember = (reportId: string, stored: StoredReport): void => {
    reports.set(reportId, stored);
    latestReportId = reportId;
    while (reports.size > MAX_STORED_REPORTS) {
      const oldest = reports.keys().next().value;
      if (oldest === undefined || oldest === reportId) break;
      reports.delete(oldest);
    }
  };

  const resolveStored = (reportId: string): { id: string; stored: StoredReport } | undefined => {
    const id = reportId === LATEST_REPORT_ALIAS ? latestReportId : reportId;
    const stored = id === undefined ? undefined : reports.get(id);
    return id === undefined || stored === undefined ? undefined : { id, stored };
  };

  const runCheck = async (signal: AbortSignal): Promise<QcTimelineCheckResult> => {
    const identity = deps.identity();
    if (identity === undefined)
      return failure('authority-unavailable', 'The project changed, so no check was started.');
    const source = deps.timeline();
    if (source === undefined || source.composition === undefined || deps.sampler === undefined)
      return failure(
        'composition-unavailable',
        'This build cannot capture composed frames of the cut yet, so no timeline check ran.',
      );

    let plan: ReturnType<typeof planTimelineQcSampling>;
    try {
      plan = planTimelineQcSampling({
        durationUs: source.durationUs,
        cutTimesUs: source.cutTimesUs,
        textBoxes: source.textBoxes,
        maxFrames: MAX_QC_REPORT_FRAMES,
        strategy: {
          kind: 'evenly-spaced-plus-cuts',
          count: Math.min(evenCount, Math.max(1, source.durationUs)),
        },
      });
    } catch {
      return failure('sampling-failed', 'The cut could not be planned for sampling.');
    }

    counter += 1;
    const reportId = `qc-report-${identity.runId}-${counter}`;
    const scope = {
      runId: identity.runId,
      identity: {
        projectId: identity.projectId,
        assetDigest: await digest(`${identity.projectId}:${identity.revision}:timeline`),
        projectRevision: identity.revision,
        modelId: identity.modelId.length > 0 ? identity.modelId : QC_FALLBACK_MODEL_ID,
        promptPolicyDigest:
          identity.promptPolicyDigest.length > 0 ? identity.promptPolicyDigest : QC_POLICY_DIGEST,
      },
    };
    const lookup: EvidenceManifestLookup = { manifestId: `timeline-${reportId}`, scope };
    try {
      deps.evidenceStore.createManifest({
        id: lookup.manifestId,
        scope,
        mode: 'overview',
        persistence: 'ephemeral',
        intendedFrameIdPages: chunk(plan.frameIds, 512),
      });
    } catch {
      return failure('sampling-failed', 'JOY could not open a private frame store for this check.');
    }

    const result = await deps.sampler.sample({
      plan,
      composition: source.composition,
      evidenceStore: deps.evidenceStore,
      evidenceLookup: lookup,
      signal,
    });
    if (result.status === 'cancelled') return failure('cancelled', 'The check was cancelled.');
    if (result.status !== 'captured')
      return failure('sampling-failed', 'The cut could not be sampled, so there is no report.');

    remember(reportId, {
      report: buildTimelineReport({
        reportId,
        projectId: identity.projectId,
        createdAt: new Date(now()).toISOString(),
        durationUs: source.durationUs,
        timesUs: plan.timesUs,
        coverage: plan.coverage,
        missedCutTimesUs: plan.missedCutTimesUs,
        textChecks: result.textChecks,
      }),
      lookup,
      frameIds: new Set(plan.frameIds),
      approvedFrameIds: new Set(),
    });
    return { ok: true, reportId };
  };

  const checkAndStore = (signal: AbortSignal): Promise<QcTimelineCheckResult> => {
    // One check at a time: a second request joins the one that is running.
    if (inflight !== undefined) return inflight;
    const running = runCheck(signal).finally(() => {
      if (inflight === running) inflight = undefined;
    });
    inflight = running;
    return running;
  };

  const selectionIsListed = (input: JoyAgentQcFrameReviewRequest): StoredReport | undefined => {
    if (disposed) return undefined;
    const resolved = resolveStored(input.reportId);
    if (resolved === undefined || resolved.stored.lookup === undefined) return undefined;
    const { stored } = resolved;
    const lookup = stored.lookup!;
    if (input.frameIds.length < 1 || input.frameIds.length > MAX_TIMELINE_CONTACT_SHEET_FRAMES)
      return undefined;
    for (const frameId of input.frameIds) {
      if (!stored.frameIds.has(frameId)) return undefined;
      if (deps.evidenceStore.readFrameArtifact({ ...lookup, frameId }) === undefined)
        return undefined;
    }
    return stored;
  };

  const imageGate = (): boolean => deps.transport !== undefined && deps.isCachedImageSupported();

  const refusal = (
    code: JoyAgentQcFrameReviewRefusal['code'],
    message: string,
    framesSent = 0,
  ): JoyAgentQcFrameReviewRefusal => ({ ok: false, code, message, framesSent });

  return {
    runTimelineCheck: checkAndStore,

    storeFileReport(report) {
      if (disposed) return undefined;
      const reportId = report['reportId'];
      if (
        typeof reportId !== 'string' ||
        report['version'] !== 1 ||
        !Array.isArray(report['findings'])
      )
        return undefined;
      remember(reportId, {
        report: report as { readonly [key: string]: HostRpcJson },
        lookup: undefined,
        frameIds: new Set(),
        approvedFrameIds: new Set(),
      });
      return reportId;
    },

    async readReport(input: JoyAgentQcReportReadRequest, context: HostRpcHandlerContext) {
      if (disposed) return unavailable('The saved QC report is no longer available.');
      let resolved = resolveStored(input.reportId);
      if (resolved === undefined && input.reportId === LATEST_REPORT_ALIAS) {
        // The model has no report id before a check exists. Asking for the
        // latest one is the agent's request for the host to run the check.
        const checked = await checkAndStore(context.signal);
        if (!checked.ok) return unavailable(checked.message);
        resolved = resolveStored(checked.reportId);
      }
      if (resolved === undefined) return unavailable('No saved QC report has that id.');
      const { report } = resolved.stored;
      if (input.includeFindings) return report;
      const { findings, ...summary } = report;
      return {
        ...summary,
        findingCount: Array.isArray(findings) ? findings.length : 0,
      } as HostRpcJson;
    },

    isReportFrameSelectionValid: (input) => selectionIsListed(input) !== undefined,

    isCachedImageSupported: () => imageGate(),

    isPrivacyModeAllowed: () => deps.isPrivacyModeAllowed(),

    async hasApprovedConsent(input, context) {
      const stored = selectionIsListed(input);
      if (stored === undefined || deps.requestConsent === undefined) return false;
      if (input.frameIds.every((frameId) => stored.approvedFrameIds.has(frameId))) return true;
      const lookup = stored.lookup!;
      let bytes = 0;
      for (const frameId of input.frameIds)
        bytes += deps.evidenceStore.readFrameArtifact({ ...lookup, frameId })?.jpeg.size ?? 0;
      const approved = await deps.requestConsent(
        {
          reportId: resolveStored(input.reportId)!.id,
          tool: input.tool,
          frameIds: input.frameIds,
          frameCount: input.frameIds.length,
          approximateBytes: bytes,
          modelId: deps.identity()?.modelId ?? '',
        },
        context.signal,
      );
      if (approved === true)
        for (const frameId of input.frameIds) stored.approvedFrameIds.add(frameId);
      return approved === true;
    },

    async reviewFrames(
      input,
      context,
    ): Promise<JoyAgentQcFrameReviewSuccess | JoyAgentQcFrameReviewRefusal> {
      // Every gate is checked again here: no pixel is read before all of them pass.
      const stored = selectionIsListed(input);
      if (stored === undefined)
        return refusal(
          'JOY_AGENT_QC_FRAME_NOT_LISTED',
          'Those frame IDs are not listed by the saved QC report. No frames were sent.',
        );
      if (!imageGate() || deps.transport === undefined)
        return refusal(
          'JOY_AGENT_QC_CAPABILITY_UNAVAILABLE',
          'Image review is not available for this model or build. No frames were sent.',
        );
      if (!deps.isPrivacyModeAllowed())
        return refusal(
          'JOY_AGENT_QC_PRIVACY_BLOCKED',
          'Privacy settings keep these frames on this device. No frames were sent.',
        );
      if (!input.frameIds.every((frameId) => stored.approvedFrameIds.has(frameId)))
        return refusal(
          'JOY_AGENT_QC_CONSENT_REQUIRED',
          'Approve the image review in the consent card before sending frames.',
        );

      const lookup = stored.lookup!;
      const frames: EvidenceFrameArtifact[] = [];
      for (const frameId of input.frameIds) {
        const frame = deps.evidenceStore.readFrameArtifact({ ...lookup, frameId });
        if (frame === undefined)
          return refusal(
            'JOY_AGENT_QC_FRAME_NOT_LISTED',
            'A listed frame is no longer stored. No frames were sent.',
          );
        frames.push(frame);
      }
      let contactSheet: Blob | undefined;
      if (input.tool === 'media_contact_sheet') {
        try {
          contactSheet = await sheetFactory({ frames, columns: input.columns });
        } catch {
          return refusal('JOY_AGENT_QC_REVIEW_FAILED', 'JOY could not build the contact sheet.');
        }
      }
      // From here a provider may have seen pixels, so every failure is charged.
      try {
        const sent = await deps.transport.analyze({
          reportId: resolveStored(input.reportId)!.id,
          tool: input.tool,
          reason: input.tool === 'media_frames_view' ? input.reason : undefined,
          frames,
          contactSheet,
          signal: context.signal,
        });
        deps.evidenceStore.recordFrames({
          ...lookup,
          stage: 'submitted',
          frameIds: input.frameIds,
        });
        if (!sent.ok)
          return refusal(
            'JOY_AGENT_QC_REVIEW_FAILED',
            'The image review did not complete.',
            frames.length,
          );
        deps.evidenceStore.recordFrames({
          ...lookup,
          stage: 'reviewed',
          frameIds: input.frameIds,
        });
        return {
          ok: true,
          analysis: sent.analysis,
          submittedFrameIds: [...input.frameIds],
          framesSent: frames.length,
        };
      } catch {
        return refusal(
          'JOY_AGENT_QC_REVIEW_FAILED',
          'The image review did not complete.',
          frames.length,
        );
      }
    },

    dispose() {
      disposed = true;
      reports.clear();
      latestReportId = undefined;
      inflight = undefined;
    },
  };
}

export interface EditorQcAdapterInput {
  readonly runId: string;
  readonly projectId: string;
  readonly revision: string;
  readonly modelId: string;
  readonly promptPolicyDigest: string;
  /** True only while this run still owns the project at this revision. */
  readonly isCurrent: () => boolean;
  readonly getTimeline: () => QcTimelineLike;
  readonly isCachedImageSupported: () => boolean;
  readonly isPrivacyModeAllowed: () => boolean;
  /** The host's composition request. Absent today; see the note at the top of this file. */
  readonly getComposition?: () => QcTimelineSource['composition'];
}

/**
 * The editor's adapter for one run: a private evidence store, the T-B03 sampler,
 * and the live timeline. Both the Joy Code panel and the recipe host build it
 * here, so there is one construction path.
 */
export function createEditorQcAdapter(input: EditorQcAdapterInput): QcHostAdapter {
  return createQcHostAdapter({
    evidenceStore: createEvidenceStore(),
    identity: () =>
      input.isCurrent()
        ? {
            runId: input.runId,
            projectId: input.projectId,
            revision: input.revision,
            modelId: input.modelId,
            promptPolicyDigest: input.promptPolicyDigest,
          }
        : undefined,
    timeline: () => qcTimelineSourceFromTimeline(input.getTimeline(), input.getComposition?.(), []),
    sampler: createTimelineQcSampler(),
    isCachedImageSupported: input.isCachedImageSupported,
    isPrivacyModeAllowed: input.isPrivacyModeAllowed,
  });
}

function failure(
  code: Extract<QcTimelineCheckResult, { ok: false }>['code'],
  message: string,
): QcTimelineCheckResult {
  return { ok: false, code, message };
}

function unavailable(message: string): HostRpcJson {
  return { ok: false, code: 'JOY_AGENT_QC_REPORT_UNAVAILABLE', message };
}

interface TimelineReportInput {
  readonly reportId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly durationUs: number;
  readonly timesUs: readonly number[];
  readonly coverage: {
    readonly sampledFrameCount: number;
    readonly sampledCutCount: number;
    readonly totalCutCount: number;
  };
  readonly missedCutTimesUs: readonly number[];
  readonly textChecks: readonly TimelineQcTextAnalysis[];
}

/** The ADR-0045 section 11 shape for a timeline target. Layer 1 only: no model claim in it. */
function buildTimelineReport(input: TimelineReportInput): { readonly [key: string]: HostRpcJson } {
  const findings: HostRpcJson[] = [];
  const add = (finding: { readonly [key: string]: HostRpcJson }): void => {
    findings.push({ id: `qc-finding-${findings.length + 1}`, state: 'measured', ...finding });
  };
  for (const check of input.textChecks) {
    const midpointUs = Math.floor(check.startUs + (check.endUs - check.startUs) / 2);
    if (!check.safeArea.inside90Percent)
      add({
        type: 'safe-area',
        severity: 'minor',
        startUs: check.startUs,
        endUs: check.endUs,
        label: `A ${check.kind} sits outside the 90 percent safe area.`,
        measured: { insideSafeArea: false },
        fixable: true,
        evidenceIds: [timelineQcFrameId(midpointUs)],
      });
    if (check.legibility.status === 'measured' && !check.legibility.meetsMinimumContrast)
      add({
        type: 'text-legibility',
        severity: check.legibility.contrastRatio < MINIMUM_CONTRAST_FOR_MAJOR ? 'major' : 'minor',
        startUs: check.startUs,
        endUs: check.endUs,
        label: `A ${check.kind} is hard to read against the picture behind it.`,
        measured: { contrastRatio: Math.round(check.legibility.contrastRatio * 100) / 100 },
        fixable: true,
        evidenceIds: [timelineQcFrameId(check.legibility.sampledAtUs)],
      });
  }
  const sampledRanges = input.timesUs.map((timeUs) => ({ startUs: timeUs, endUs: timeUs + 1 }));
  const unsampledRanges: { startUs: number; endUs: number }[] = [];
  let cursor = 0;
  for (const timeUs of input.timesUs) {
    if (timeUs > cursor) unsampledRanges.push({ startUs: cursor, endUs: timeUs });
    cursor = timeUs + 1;
  }
  if (cursor < input.durationUs) unsampledRanges.push({ startUs: cursor, endUs: input.durationUs });
  return Object.freeze({
    version: 1,
    reportId: input.reportId,
    projectId: input.projectId,
    createdAt: input.createdAt,
    target: {
      kind: 'timeline',
      range: { domain: 'composition', startUs: 0, endUs: input.durationUs },
    },
    run: { layer1: true, layer2: false, modelId: null, framesSent: 0, framesSkipped: 0 },
    coverage: {
      completeSourceCoverage: false,
      sampledRanges,
      unsampledRanges,
      sampledFrameCount: input.coverage.sampledFrameCount,
      sampledCutCount: input.coverage.sampledCutCount,
      totalCutCount: input.coverage.totalCutCount,
      missedCutTimesUs: [...input.missedCutTimesUs],
    },
    findings,
    notes: [],
    frames: input.timesUs.map((timeUs) => ({ frameId: timelineQcFrameId(timeUs), timeUs })),
    modelComprehensionGuaranteed: false,
  } as { readonly [key: string]: HostRpcJson });
}

interface DesktopQcBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

export interface DesktopMediaQcOptions {
  /** The library reference of the finished file to check. */
  readonly refId: string;
  readonly signal: AbortSignal;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * The file check through the desktop's existing Worker route: submit one
 * `media.qc` job, poll its status, return the report it carries. The report holds
 * numbers and sentences only; the desktop never returns a path in it.
 */
export async function runDesktopMediaQc(
  bridge: DesktopQcBridge,
  options: DesktopMediaQcOptions,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.now ?? Date.now;
  const deadline = clock() + (options.timeoutMs ?? 10 * 60_000);
  const submitted = (await bridge.invoke('desktop.media.qc.run', {
    refId: options.refId,
    payload: {},
  })) as { readonly jobId?: unknown } | undefined;
  const jobId = submitted?.jobId;
  if (typeof jobId !== 'string') return undefined;
  while (clock() < deadline) {
    if (options.signal.aborted) break;
    const job = (await bridge.invoke('desktop.media.job.status', { jobId })) as
      { readonly status?: unknown; readonly report?: unknown } | undefined;
    if (job?.status === 'done') {
      const report = job.report;
      return typeof report === 'object' && report !== null && !Array.isArray(report)
        ? (report as Readonly<Record<string, unknown>>)
        : undefined;
    }
    if (job?.status === 'failed' || job?.status === 'cancelled') return undefined;
    await sleep(options.pollMs ?? 500);
  }
  try {
    await bridge.invoke('desktop.media.job.cancel', { jobId });
  } catch {
    // A cancel that cannot be delivered leaves the job to its own timeout.
  }
  return undefined;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const pages: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    pages.push(values.slice(index, index + size));
  return pages;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
