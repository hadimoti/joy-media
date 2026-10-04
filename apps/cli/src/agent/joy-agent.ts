/* global console */
import {
  JoyAgentEngine,
  type JoyAgentSafeEvent,
  type JoyAgentTaskKind,
  type JoyAgentProbeResult,
  type JoyPlanChecklistItem,
  KILO_MODEL_PRESETS,
} from '@joy-media/joy-agent-engine';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  ffmpegCaptionFontSize,
  ffmpegCaptionY,
  layoutFfmpegCaption,
} from '../render/caption-layout.js';
import { c, logInfo, logStep, logSuccess, logWarn } from '../utils/logger.js';
import {
  CliJoyAgentToolBridge,
  type AppliedTimelineSummary,
  type StagedOperationsSummary,
} from './bridge.js';
import {
  createModelFromConfig,
  resolveByokConfig,
  type ResolveProviderOptions,
} from './provider.js';

export interface RunAgentOptions {
  readonly project: JoyProjectV1;
  readonly revision: number;
  readonly prompt: string;
  readonly taskKind?: JoyAgentTaskKind | undefined;
  readonly apply?: boolean | undefined;
  readonly keepPartial?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly allowFrames?: boolean | undefined;
  readonly vision?: boolean | undefined;
  readonly providerOptions?: ResolveProviderOptions | undefined;
  readonly onEvent?: ((event: JoyAgentSafeEvent) => void) | undefined;
  readonly onTrace?:
    | ((record: {
        readonly type: 'tool_call' | 'observation';
        readonly name: string;
        readonly value: unknown;
      }) => void)
    | undefined;
  readonly onStagedChange?: ((summary: StagedOperationsSummary) => void) | undefined;
}

export interface RunAgentOutput {
  readonly resultText: string;
  readonly modelText: string;
  readonly capability: string;
  readonly steps: number;
  readonly staged: StagedOperationsSummary;
  readonly applied: boolean;
  readonly status: 'completed' | 'partial';
  readonly updatedProject: JoyProjectV1;
  readonly appliedCount: number;
  readonly appliedOperationIds?: readonly string[] | undefined;
  readonly errors: string[];
  readonly notes: string[];
  readonly checklist?: readonly JoyPlanChecklistItem[];
  readonly verified?: readonly string[];
  readonly placementSummary?: AppliedTimelineSummary;
  readonly resolvedModelId?: string;
}

export function frameInspectionSkipNote(
  modelId: string,
  vision: boolean | undefined,
): string | undefined {
  return vision === false || modelId === 'openrouter/free'
    ? 'frame inspection skipped: model has no vision'
    : undefined;
}

export async function probeAgent(providerOptions?: ResolveProviderOptions): Promise<{
  capability: string;
  provider: string;
  modelId: string;
  resolvedModelId?: string;
  failure?: JoyAgentProbeResult['failure'];
}> {
  const config = await resolveByokConfig(providerOptions);
  const model = createModelFromConfig(config);
  const bridge = new CliJoyAgentToolBridge(
    {
      schemaVersion: 1,
      id: 'probe',
      title: 'Probe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 1920,
          height: 1080,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1000000,
          background: '#000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    },
    1,
  );

  const engine = new JoyAgentEngine({ model, bridge, apiKeyForRedaction: config.apiKey });
  const probeResult = await engine.probe();
  return {
    capability: probeResult.capability,
    provider: config.provider,
    modelId: config.modelId,
    ...(probeResult.resolvedModelId ? { resolvedModelId: probeResult.resolvedModelId } : {}),
    ...(probeResult.failure ? { failure: probeResult.failure } : {}),
  };
}

export async function runJoyAgent(options: RunAgentOptions): Promise<RunAgentOutput> {
  const config = await resolveByokConfig(options.providerOptions);
  const model = createModelFromConfig(config);
  const frameNote = frameInspectionSkipNote(config.modelId, config.vision);
  const frameInspectionSkipped = frameNote !== undefined;

  const bridge = new CliJoyAgentToolBridge(
    options.project,
    options.revision,
    options.onStagedChange,
    options.apply ?? false,
  );

  const eventLogger = (event: JoyAgentSafeEvent): void => {
    options.onEvent?.(event);
    if (event.type === 'activity') {
      if (options.json) console.log(JSON.stringify(event));
      else logStep('Agent Phase', `${event.phase} (${event.activityCode})`);
    } else if (event.type === 'text-delta') {
      if (!options.json && event.text.trim()) console.log(`\nModel notes:\n${event.text}\n`);
    } else if (event.type === 'proposal') {
      if (options.json) console.log(JSON.stringify(event));
      else
        logInfo(
          `Staged proposal: ${event.operationCount} operations (hash: ${event.proposalHash})`,
        );
    } else if (event.type === 'usage') {
      if (options.json) console.log(JSON.stringify(event));
      else
        logStep(
          'Token Usage',
          `Prompt: ${event.inputTokens} | Output: ${event.outputTokens} | Total: ${event.totalTokens}`,
        );
    } else if (options.json) {
      console.log(JSON.stringify(event));
    }
  };

  const engine = new JoyAgentEngine({
    model,
    bridge,
    modelId: config.modelId,
    allowFrames: options.allowFrames === true,
    vision:
      !frameInspectionSkipped &&
      (options.vision === true ||
        config.vision === true ||
        KILO_MODEL_PRESETS.some((preset) => preset.id === config.modelId && preset.vision)),
    onEvent: eventLogger,
    ...(options.onTrace === undefined ? {} : { onTrace: options.onTrace }),
    apiKeyForRedaction: config.apiKey,
  });

  const runId = `cli-${Date.now().toString(36)}`;
  if (!options.json)
    logInfo(
      `Connecting to Joy Agent with model ${c(config.modelId, 'bold')} (${config.provider})...`,
    );
  if (frameNote && !options.json) logInfo(`Model notes: ${frameNote}.`);

  const runResult = await engine.run({
    taskKind: options.taskKind ?? 'joy-code-edit',
    runId,
    baseRevision: `rev-${options.revision}`,
    request: options.prompt,
    context: {
      projectId: options.project.id,
      title: options.project.title,
    },
  });

  if (!options.json) logSuccess(`Joy Agent finished in ${runResult.steps} step(s).`);
  if (runResult.resolvedModelId && runResult.resolvedModelId !== config.modelId) {
    if (!options.json) logInfo(`Model: ${config.modelId} → ${runResult.resolvedModelId}`);
  }

  const staged = bridge.getStagedOperations();

  let updatedProject = options.project;
  let appliedCount = 0;
  let appliedOperationIds: readonly string[] = [];
  let errors: string[] = bridge.getReportedIssues();
  let notes: string[] = frameNote ? [frameNote] : [];
  let applied = false;
  let placementSummary: AppliedTimelineSummary | undefined;
  const checklist = bridge.getPlanChecklist();
  let verified: string[] = [];

  if (options.apply && runResult.status === 'completed' && bridge.hasSubmittedPlan()) {
    if (!options.json) logInfo('Applying staged operations to project...');
    const applyRes = bridge.applyStaged();
    const candidateProject = applyRes.updatedProject;
    errors = [...errors, ...applyRes.errors];
    notes = [...notes, ...applyRes.notes];
    placementSummary = applyRes.placementSummary;
    const requestVerification = verifyRequestIntent(candidateProject, options.prompt);
    const verification = verifyPlanChecklist(candidateProject, checklist);
    verified = [...verification.verified, ...requestVerification.verified];
    errors = [
      ...errors,
      ...verification.unmet.map((item) => `Checklist not verified: ${item}`),
      ...requestVerification.unmet.map((item) => `Request not verified: ${item}`),
      ...missingOperationCoverage(staged, checklist, options.prompt),
    ];
    const clean = errors.length === 0 && applyRes.errors.length === 0 && applyRes.appliedCount > 0;
    applied = clean || (options.keepPartial === true && applyRes.appliedCount > 0);
    if (applied) {
      updatedProject = candidateProject;
      appliedCount = applyRes.appliedCount;
      appliedOperationIds = applyRes.appliedOperationIds;
    }
    if (errors.length > 0) {
      const heading = applied
        ? `Applied partial changes with ${errors.length} failed check(s):`
        : `Apply refused with ${errors.length} error(s):`;
      if (options.json) console.error(`${heading} ${errors.join('; ')}`);
      else {
        logWarn(heading);
        for (const err of errors) console.error(`  ${c('!', 'yellow')} ${err}`);
      }
    }
  }

  if (runResult.partialReason === 'no-plan' || (options.apply && !bridge.hasSubmittedPlan())) {
    errors = [...errors, 'No plan was submitted after the single retry.'];
  }

  return {
    resultText:
      runResult.status === 'partial'
        ? runResult.partialReason === 'no-plan'
          ? 'Partial run: no plan was submitted after one retry. Nothing was applied.'
          : `Partial plan stopped at the ${runResult.partialReason ?? 'safety'} limit. Nothing was applied.`
        : truthfulAgentSummary({
            applyRequested: options.apply === true,
            applied,
            appliedCount,
            appliedOperationIds,
            errors,
            notes,
            staged,
          }),
    modelText: runResult.text,
    capability: runResult.capability,
    steps: runResult.steps,
    staged,
    applied,
    status: errors.length > 0 || runResult.status === 'partial' ? 'partial' : runResult.status,
    updatedProject,
    appliedCount,
    appliedOperationIds,
    errors,
    notes,
    checklist,
    verified,
    ...(placementSummary === undefined ? {} : { placementSummary }),
    ...(runResult.resolvedModelId ? { resolvedModelId: runResult.resolvedModelId } : {}),
  };
}

export function missingOperationCoverage(
  staged: StagedOperationsSummary,
  checklist: readonly JoyPlanChecklistItem[],
  request: string,
): string[] {
  const issues = checklist.length === 0 ? ['Checklist not verified: checklist is empty'] : [];
  const operationKinds = [...staged.timelineOps, ...staged.documentOps].map(
    (operation) => operation.kind,
  );
  const checks = new Set(checklist.map((item) => item.kind));
  const intent = parseRequestIntent(request);
  const missing = new Set<string>();
  for (const kind of operationKinds) {
    const covered =
      (kind === 'trim' && (checks.has('trim') || intent.trimRange !== undefined)) ||
      (kind === 'add-effect' && (checks.has('look') || intent.look !== undefined)) ||
      ((kind === 'create-text' || kind === 'set-text') &&
        (checks.has('text') || intent.centerText)) ||
      (kind === 'set-property' && intent.centerText) ||
      ((kind === 'insert' || kind === 'move' || kind === 'split') &&
        (intent.startAtZero || intent.durationUs !== undefined));
    if (!covered) missing.add(kind);
  }
  return [
    ...issues,
    ...[...missing].map((kind) => `Checklist not verified: no check covers operation type ${kind}`),
  ];
}

interface RequestIntent {
  centerText: boolean;
  verticalCenterText?: boolean;
  startAtZero: boolean;
  trimRange?: readonly [number, number];
  look?: 'crt' | 'bw' | 'warm' | 'cool';
  durationUs?: number;
}

function parseRequestIntent(request: string): RequestIntent {
  const normalized = request.toLowerCase();
  const intent: RequestIntent = {
    centerText: /\b(center|centre|centered|centred|middle)\b|وسط.?چین|وسط/i.test(normalized),
    startAtZero:
      /\b(at the start|at 0|from the beginning|start at zero)\b|از ابتدا|از ابتدای|از شروع/i.test(
        normalized,
      ),
  };
  const range =
    /(?:from\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec(?:onds?)?)?\s*(?:to|تا|[-–])\s*(\d+(?:\.\d+)?)\s*(?:s|sec(?:onds?)?)?/i.exec(
      normalized,
    );
  if (
    range?.[1] &&
    range[2] &&
    /\b(trim|cut|source)\b|\bkeep\s+(?:only\b|source\b|(?:the\s+)?(?:part|section|range)\s+(?:from|between)\b)|برش|منبع|(?:کلیپ|منبع).{0,40}نگه[\s\u200c]*دار|نگه[\s\u200c]*دار.{0,40}(?:کلیپ|منبع)/i.test(
      normalized,
    )
  )
    intent.trimRange = [
      Math.round(Number(range[1]) * 1_000_000),
      Math.round(Number(range[2]) * 1_000_000),
    ];
  if (/\bcrt\b/i.test(normalized)) intent.look = 'crt';
  else if (/\b(bw|black\s*(?:and|&)\s*white|black-and-white)\b|سیاه.?سفید/i.test(normalized))
    intent.look = 'bw';
  else if (/\bwarm\b|گرم/i.test(normalized)) intent.look = 'warm';
  else if (/\bcool\b|سرد/i.test(normalized)) intent.look = 'cool';
  const duration = /(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s+long/i.exec(normalized);
  if (duration?.[1]) intent.durationUs = Math.round(Number(duration[1]) * 1_000_000);
  intent.verticalCenterText = /\b(middle|vertically)\b/i.test(normalized);
  return intent;
}

export function verifyRequestIntent(
  project: JoyProjectV1,
  request: string,
): { readonly verified: string[]; readonly unmet: string[] } {
  const intent = parseRequestIntent(request);
  const root = project.compositions[project.rootCompositionId];
  const clips = root?.tracks.flatMap((track) => track.clips) ?? [];
  const verified: string[] = [];
  const unmet: string[] = [];
  if (intent.centerText) {
    const root = project.compositions[project.rootCompositionId];
    const centeredVisualObject = Object.values(project.visualObjects).some(
      (object) =>
        object.kind === 'text' &&
        Math.abs(object.transform.x) < 0.001 &&
        (!intent.verticalCenterText || Math.abs(object.transform.y) < 0.001),
    );
    const centeredCaption =
      root?.tracks.some(
        (track) =>
          track.kind === 'caption' &&
          track.enabled &&
          track.clips.some((clip) => {
            if (clip.kind !== 'caption') return false;
            const document = project.captionDocuments[clip.captionDocumentId];
            if (!document) return false;
            return document.segments.some((segment) =>
              layoutFfmpegCaption({
                clipId: clip.id,
                document,
                segment,
                style: clip.style,
                width: root.width,
                height: root.height,
              }).some((node) => {
                const horizontalCenter =
                  node.align === 'center' &&
                  Math.abs(node.transform.translateX - root.width / 2) <= 2;
                if (!horizontalCenter) return false;
                if (!intent.verticalCenterText) return true;
                const top = ffmpegCaptionY(node, root.height);
                const centerY = top + ffmpegCaptionFontSize(node) / 2;
                return Math.abs(centerY - root.height / 2) <= 4;
              }),
            );
          }),
      ) ?? false;
    const centered = centeredVisualObject || centeredCaption;
    (centered ? verified : unmet).push(
      centered ? 'Request: centered text' : 'request asked for centered text',
    );
  }
  if (intent.startAtZero) {
    const startsAtZero = clips.some((clip) => clip.startUs === 0);
    (startsAtZero ? verified : unmet).push(
      startsAtZero ? 'Request: clip starts at 0' : 'request asked for a clip starting at 0',
    );
  }
  if (intent.trimRange) {
    const [sourceInUs, sourceOutUs] = intent.trimRange;
    const trimmed = clips.some(
      (clip) =>
        clip.kind === 'video' &&
        clip.sourceInUs === sourceInUs &&
        clip.sourceInUs + Math.round(clip.durationUs * (clip.playbackRate || 1)) === sourceOutUs,
    );
    (trimmed ? verified : unmet).push(
      trimmed
        ? `Request: source trim ${sourceInUs}–${sourceOutUs} µs`
        : `request asked for source trim ${sourceInUs}–${sourceOutUs} µs`,
    );
  }
  if (intent.look) {
    const hasLook = clips.some(
      (clip) => clip.kind === 'video' && clip.look?.preset === intent.look,
    );
    (hasLook ? verified : unmet).push(
      hasLook ? `Request: ${intent.look} look` : `request asked for ${intent.look} look`,
    );
  }
  if (intent.durationUs !== undefined) {
    const durationMatches = root?.durationUs === intent.durationUs;
    (durationMatches ? verified : unmet).push(
      durationMatches
        ? `Request: duration ${intent.durationUs} µs`
        : `request asked for duration ${intent.durationUs} µs`,
    );
  }
  return { verified, unmet };
}

export function verifyPlanChecklist(
  project: JoyProjectV1,
  checklist: readonly JoyPlanChecklistItem[],
): { readonly verified: string[]; readonly unmet: string[] } {
  const root = project.compositions[project.rootCompositionId];
  const clips = root?.tracks.flatMap((track) => track.clips) ?? [];
  const verified: string[] = [];
  const unmet: string[] = [];
  for (const item of checklist) {
    if (item.kind === 'trim') {
      const clip = clips.find((candidate) => candidate.id === item.clipId);
      const actualIn = clip?.kind === 'video' ? clip.sourceInUs : undefined;
      const rate =
        clip?.kind === 'video' && clip.playbackRate && clip.playbackRate > 0
          ? clip.playbackRate
          : 1;
      const actualOut =
        actualIn === undefined ? undefined : actualIn + Math.round(clip!.durationUs * rate);
      if (actualIn === item.sourceInUs && actualOut === item.sourceOutUs)
        verified.push(`Trim ${item.clipId}: source ${item.sourceInUs}–${item.sourceOutUs} µs`);
      else
        unmet.push(`trim ${item.clipId} expected source ${item.sourceInUs}–${item.sourceOutUs} µs`);
    } else if (item.kind === 'look') {
      const clip = clips.find((candidate) => candidate.id === item.clipId);
      if (clip?.kind === 'video' && clip.look?.preset === item.look)
        verified.push(`Look ${item.clipId}: ${item.look}`);
      else unmet.push(`look ${item.look} on clip ${item.clipId}`);
    } else {
      const found = Object.values(project.captionDocuments ?? {}).some((document) =>
        document.segments.some((segment) => {
          const text =
            segment.textOverride ??
            segment.wordIds.map((id) => document.words[id]?.text ?? '').join('');
          if (text !== item.text) return false;
          const caption = clips.find(
            (clip) => clip.kind === 'caption' && clip.captionDocumentId === document.id,
          );
          return (
            caption?.kind === 'caption' &&
            (item.position !== 'center' ||
              (caption.style?.positionX === 0 && caption.style?.positionY === 0))
          );
        }),
      );
      if (found)
        verified.push(`Text “${item.text}”${item.position === 'center' ? ' centered' : ''}`);
      else unmet.push(`text “${item.text}”${item.position === 'center' ? ' centered' : ''}`);
    }
  }
  return { verified, unmet };
}

export function truthfulAgentSummary(input: {
  readonly applyRequested: boolean;
  readonly applied: boolean;
  readonly appliedCount: number;
  readonly appliedOperationIds?: readonly string[] | undefined;
  readonly errors: readonly string[];
  readonly notes: readonly string[];
  readonly staged: StagedOperationsSummary;
}): string {
  const operations = [...input.staged.timelineOps, ...input.staged.documentOps];
  const descriptions = operations.map((operation) => `${operation.kind} (${operation.id})`);
  if (input.applyRequested && input.applied) {
    if (input.appliedCount === 0) return 'No changes were applied.';
    const operationById = new Map(operations.map((operation) => [operation.id, operation]));
    const applied = (input.appliedOperationIds ?? [])
      .map((id) => operationById.get(id))
      .filter((operation) => operation !== undefined)
      .map((operation) => `${operation.kind} (${operation.id})`);
    const detail = applied.length > 0 ? `: ${applied.join(', ')}` : '';
    return [
      `Applied ${input.appliedCount} change(s)${detail}.`,
      ...input.notes,
      ...(input.errors.length ? [`Requests not staged: ${input.errors.join('; ')}`] : []),
    ].join(' ');
  }
  if (input.applyRequested && input.errors.length > 0)
    return `No changes were applied. The apply was rejected: ${input.errors.join('; ')}`;
  if (operations.length > 0)
    return `Prepared ${operations.length} change(s) for review: ${descriptions.join(', ')}. Nothing was applied.${input.errors.length ? ` Requests not staged: ${input.errors.join('; ')}` : ''}`;
  if (input.errors.length > 0)
    return `No project changes were made. Requests not staged: ${input.errors.join('; ')}`;
  return 'No project changes were made.';
}
