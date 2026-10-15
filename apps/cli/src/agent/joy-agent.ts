/* global console */
import {
  JoyAgentEngine,
  type JoyAgentSafeEvent,
  type JoyAgentTraceRecord,
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
  summarizePlacements,
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
  readonly onTrace?: ((record: JoyAgentTraceRecord) => void) | undefined;
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
  /** Run-level notes already shown as their own "Model notes" line (e.g. frame-skip). */
  readonly modelNotes?: readonly string[];
  readonly checklist?: readonly JoyPlanChecklistItem[];
  readonly verified?: readonly string[];
  readonly placementSummary?: AppliedTimelineSummary;
  readonly resolvedModelId?: string;
}

const TRACE_LABELS: Record<JoyAgentTraceRecord['type'], string> = {
  tool_call: 'Tool call',
  observation: 'Observation',
  tool_error: 'Tool error',
  assistant_text: 'Model',
};

/**
 * Formats one transcript record for text output; tool errors and interim model text stay
 * visible. Interim text is trimmed (models often start it with blank lines), and text that is
 * empty or only whitespace prints nothing: the result is undefined.
 */
export function formatAgentTraceLine(record: JoyAgentTraceRecord): string | undefined {
  if (record.type === 'assistant_text') {
    const text = String(record.value).trim();
    return text ? `${TRACE_LABELS.assistant_text}: ${text}` : undefined;
  }
  const value =
    record.type === 'tool_error' &&
    typeof record.value === 'object' &&
    record.value !== null &&
    typeof (record.value as { error?: unknown }).error === 'string'
      ? (record.value as { error: string }).error
      : JSON.stringify(record.value);
  return `${TRACE_LABELS[record.type]}: ${record.name} ${value}`;
}

export function frameInspectionSkipNote(
  modelId: string,
  vision: boolean | undefined,
  explicitVision = false,
): string | undefined {
  if (explicitVision) return undefined;
  return vision === false || modelId === 'openrouter/free'
    ? 'frame inspection skipped: model has no vision'
    : undefined;
}

/** One-line warning when --vision overrides a routed or text-only model's default. */
export function visionOverrideWarning(
  modelId: string,
  vision: boolean | undefined,
  explicitVision: boolean,
  allowFrames: boolean,
): string | undefined {
  if (!explicitVision || !allowFrames) return undefined;
  if (modelId === 'openrouter/free')
    return '--vision: openrouter/free routes to a model that may not support images; frame reads can fail or be ignored.';
  if (vision === false)
    return `--vision overrides the text-only default for ${modelId}; frame reads can fail if the model rejects images.`;
  return undefined;
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
  const explicitVision = options.vision === true;
  const frameNote = frameInspectionSkipNote(config.modelId, config.vision, explicitVision);
  const visionWarning = visionOverrideWarning(
    config.modelId,
    config.vision,
    explicitVision,
    options.allowFrames === true,
  );

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
      explicitVision ||
      (frameNote === undefined &&
        (config.vision === true ||
          KILO_MODEL_PRESETS.some((preset) => preset.id === config.modelId && preset.vision))),
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
  if (visionWarning) {
    if (options.json) console.error(visionWarning);
    else logWarn(visionWarning);
  }

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

  if (!options.json) {
    if (runResult.status === 'partial')
      logWarn(`Joy Agent stopped after ${runResult.steps} step(s) without a final plan.`);
    else logSuccess(`Joy Agent finished in ${runResult.steps} step(s).`);
  }
  const limitHit =
    runResult.partialReason === 'step-limit' || runResult.partialReason === 'tool-call-limit';
  if (runResult.resolvedModelId && runResult.resolvedModelId !== config.modelId) {
    if (!options.json) logInfo(`Model: ${config.modelId} → ${runResult.resolvedModelId}`);
  }

  const staged = bridge.getStagedOperations();

  let updatedProject = options.project;
  let appliedCount = 0;
  let appliedOperationIds: readonly string[] = [];
  let errors: string[] = bridge.getReportedIssues();
  // The frame-skip note is printed once as "Model notes" above; it is kept out of the
  // apply notes so it is not spliced into the summary sentence.
  let notes: string[] = [];
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
    const requestVerification = verifyRequestIntent(
      candidateProject,
      options.prompt,
      options.project,
    );
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

  if (limitHit) {
    errors = [...errors, partialLimitMessage(runResult.partialReason, runResult.limit)];
  } else if (
    runResult.partialReason === 'no-plan' ||
    (options.apply && !bridge.hasSubmittedPlan())
  ) {
    // The engine retries only after a frame-only turn; do not claim a retry that did not happen.
    errors = [...errors, 'No plan was submitted, so nothing was applied.'];
  } else if (runResult.status === 'partial') {
    errors = [...errors, partialLimitMessage(runResult.partialReason, runResult.limit)];
  }

  return {
    resultText:
      runResult.status === 'partial'
        ? runResult.partialReason === 'no-plan'
          ? 'Partial run: no plan was submitted. Nothing was applied.'
          : partialLimitMessage(runResult.partialReason, runResult.limit)
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
    modelNotes: frameNote ? [frameNote] : [],
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
      (kind === 'set-speed' && (checks.has('speed') || intent.speed !== undefined)) ||
      (kind === 'add-transition' &&
        (checks.has('transition') || intent.transition !== undefined)) ||
      ((kind === 'create-text' || kind === 'set-text' || kind === 'update-text') &&
        (checks.has('text') || intent.centerText || intent.textSize !== undefined)) ||
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
  /** The request asks to add or remove a transition between clips (F1). */
  transition?: TransitionIntent;
  /** The request asks for a fade in/out (from/to black), which is not supported. */
  fadeInOut?: boolean;
  /** Requested playback rate ("2x speed", "twice as fast", "half speed"). */
  speed?: number;
  /** "make the title smaller/bigger": compared with the text before the run (F3). */
  textSize?: 'smaller' | 'larger';
  /** Quoted caption text with the time range the request gave it (`"Hi" from 0s to 4s`). */
  captionTimes?: readonly { text: string; startUs: number; endUs: number }[];
}

const QUOTED_TIMED_TEXT =
  /["“«]([^"“”«»]{1,400})["”»]\s*,?\s*\(?\s*(?:from|between|at|از)?\s*(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?|ثانیه)?\s*(?:to|until|and|[-–]|تا)\s*(\d+(?:\.\d+)?)\s*(?:s\b|secs?\b|seconds?\b|ثانیه)?/giu;

interface TransitionIntent {
  readonly mode: 'add' | 'remove';
  /** A named type other than crossfade/dissolve (slide, wipe, ...): unsupported. */
  readonly unsupportedType?: string;
  /** Clip pairs the request asks a transition for, in request order. */
  readonly pairs: readonly (readonly [string, string])[];
  /** Clip pairs a negated clause names ("do not crossfade A and B"): must not get a new one. */
  readonly negatedPairs: readonly (readonly [string, string])[];
  /** False when only negated clauses mention transitions (then only negatedPairs are checked). */
  readonly positive?: boolean;
}

const FA_TRANSITION = '\u062a\u0631\u0646\u0632\u06cc\u0634\u0646'; // transition (loanword)
const FA_MOVE_OR_TRANSITION = '\u0627\u0646\u062a\u0642\u0627\u0644'; // move / transfer / transition
const FA_FADE_WORDS =
  '\u0645\u062d\u0648|\u06a9\u0631\u0627\u0633[\\s\u200c]?\u0641\u06cc\u062f|' + FA_TRANSITION;
const FA_WITHOUT = '\u0628\u062f\u0648\u0646';
const FA_REMOVE = '\u062d\u0630\u0641';
const TRANSITION_WORDS = new RegExp(
  '\\b(cross-?fades?|cross-?dissolves?|dissolves?|transitions?)\\b|\\bfade (?:between|from one|into the next)\\b|' +
    FA_TRANSITION +
    '|\u06a9\u0631\u0627\u0633[\\s\u200c]?\u0641\u06cc\u062f|' +
    // انتقال alone means "move": only a transition next to a fade word.
    FA_MOVE_OR_TRANSITION +
    '.{0,20}(?:' +
    FA_FADE_WORDS +
    ')|(?:' +
    FA_FADE_WORDS +
    ').{0,20}' +
    FA_MOVE_OR_TRANSITION,
  'u',
);
// Negation spans. Each match covers the negation AND the transition word it negates, so stripping
// the matches leaves any positive transition request in the same clause intact.
const NEGATED_PAIR_TAIL =
  '(?:\\s+between\\s+(?:the\\s+)?(?:clips?\\s+)?[a-z0-9][\\w-]*\\s+(?:and|&)\\s+(?:the\\s+)?(?:clips?\\s+)?[a-z0-9][\\w-]*)?';
const TRANSITION_NEGATED_SOURCE =
  // English: the negation word, an optional verb, an optional determiner, then the transition word,
  // with nothing else between (so "avoid jump cuts with a crossfade" stays positive). A named pair
  // right after it ("no transition between A and B") belongs to the negated span.
  "(?:\\b(?:no|without|zero|never|avoid|dont)\\b|\\bdo not\\b|\\bdon[\u2019']t\\b)(?:\\s+(?:add|use|put|insert|apply|do))?(?:\\s+(?:any|a|an|the|more|other))?\\s+(?:transitions?|cross-?fades?|dissolves?)\\b" +
  NEGATED_PAIR_TAIL +
  '|\\bhard cuts?\\b' +
  NEGATED_PAIR_TAIL +
  '|' +
  // "بدون ترنزیشن/انتقال": without (a) transition.
  FA_WITHOUT +
  '\\s*(?:' +
  FA_TRANSITION +
  '|' +
  FA_MOVE_OR_TRANSITION +
  ')\\u06cc?' +
  // "هیچ ترنزیشنی": no transition at all.
  '|\\u0647\\u06cc\\u0686\\s*(?:' +
  FA_TRANSITION +
  '|' +
  FA_MOVE_OR_TRANSITION +
  ')\\u06cc?' +
  // "ترنزیشن(ی) نذار/نگذار/نزار/نزن": the negated verb right after the transition word only.
  '|(?:' +
  FA_TRANSITION +
  '|' +
  FA_MOVE_OR_TRANSITION +
  ')\\u06cc?\\s*(?:(?:\\u0631\\u0648|\\u0631\\u0627)\\s*)?\\u0646(?:\\u06af\\u0630\\u0627\\u0631|\\u0630\\u0627\\u0631|\\u0632\\u0627\\u0631|\\u0632\\u0646)';
const TRANSITION_NEGATED_ALL = new RegExp(TRANSITION_NEGATED_SOURCE, 'gu');
const TRANSITION_REMOVE = new RegExp(
  '\\b(?:remove|delete|drop|get rid of|take out)\\b[^.]{0,40}\\b(?:transitions?|cross-?fades?|dissolves?)\\b|' +
    FA_REMOVE,
  'u',
);
const UNSUPPORTED_TRANSITION_TYPE =
  /\b(slide|wipe|zoom|push|spin|whip|glitch|iris|swipe|cube|flip)\b/;
const PAIR_REF = '(?:the\\s+)?(?:clips?\\s+)?(?!(?:between|from)\\b)([a-z0-9][\\w-]*)';
/** "between A and B", or "crossfade A and/into B" (the clip pair a clause talks about). */
const NAMED_PAIR = new RegExp(
  '(?:\\bbetween|\\b(?:cross-?fades?|dissolves?))\\s+' +
    PAIR_REF +
    '\\s+(?:and|&|into|to|with)\\s+' +
    PAIR_REF,
  'gi',
);
/**
 * Clause boundaries: punctuation (Latin and Persian) and ":", "but", "then", "ولی", "اما", " و ",
 * and "and" when a new verb follows ("crossfade A and B and don't add ...").
 */
const CLAUSE_SPLIT =
  /[.;,!?\u060c\u061b]|(?<!\d):(?!\d)|\bbut\b|\bthen\b|\band\s+(?=(?:add|put|use|insert|apply|make|keep|do|don|never|avoid|crossfade|cross-fade|dissolve|remove|delete|drop)\b)|\u0648\u0644\u06cc|\u0627\u0645\u0627|\s\u0648\s(?![0-9\u06f0-\u06f9]|\u06a9\u0644\u06cc\u067e|[a-z]\b)/u;

const FA_CLIP = '(?:\u06a9\u0644\u06cc\u067e\\s*)?'; // optional "کلیپ"
const FA_NAMED_PAIR = new RegExp(
  '\u0628\u06cc\u0646\\s+' + // "بین" (between)
    FA_CLIP +
    '([0-9\u06f0-\u06f9]+|[a-z])\\s+\u0648\\s*' + // "و" (and)
    FA_CLIP +
    '([0-9\u06f0-\u06f9]+|[a-z])',
  'gu',
);

function persianDigits(value: string): string {
  return value.replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function parseTransitionIntent(normalized: string): TransitionIntent | undefined {
  if (!TRANSITION_WORDS.test(normalized)) return undefined;
  const pairsIn = (text: string) => [
    ...[...text.matchAll(NAMED_PAIR)].map((match) => [match[1]!, match[2]!] as const),
    // Persian: "بین کلیپ ۱ و ۲" (between clip 1 and 2), Persian or ASCII digits or a letter.
    ...[...text.matchAll(FA_NAMED_PAIR)].map(
      (match) => [persianDigits(match[1]!), persianDigits(match[2]!)] as const,
    ),
  ];
  const unsupported = UNSUPPORTED_TRANSITION_TYPE.exec(normalized)?.[1];
  if (TRANSITION_REMOVE.test(normalized))
    return {
      mode: 'remove',
      pairs: pairsIn(normalized),
      negatedPairs: [],
      ...(unsupported === undefined ? {} : { unsupportedType: unsupported }),
    };
  // Decide per clause: "Do not crossfade A and B, but add a crossfade between B and C" asks for
  // B-C and forbids A-B. A request with only negated clauses and no named pair checks nothing.
  const pairs: (readonly [string, string])[] = [];
  const negatedPairs: (readonly [string, string])[] = [];
  let positive = false;
  for (const clause of normalized.split(CLAUSE_SPLIT)) {
    // "…between B and C, not between A and B": a bare "not between X and Y" clause in a
    // transition request forbids that pair.
    if (/^\s*not\s+between\b/.test(clause)) {
      negatedPairs.push(...pairsIn(clause));
      continue;
    }
    if (!TRANSITION_WORDS.test(clause) && !/\bhard cuts?\b/.test(clause)) continue;
    // Strip only the negated spans; whatever transition request is left is still positive. When in
    // doubt this keeps the check (unmet) rather than skipping it.
    const spans = [...clause.matchAll(TRANSITION_NEGATED_ALL)].map((match) => match[0]);
    const rest = clause.replace(TRANSITION_NEGATED_ALL, ' ');
    if (TRANSITION_WORDS.test(rest)) {
      positive = true;
      // Pairs come from what is left, so "hard cut between A and B" does not require A-B.
      pairs.push(...pairsIn(rest));
      negatedPairs.push(...spans.flatMap(pairsIn));
    } else if (spans.length > 0) negatedPairs.push(...pairsIn(clause));
  }
  if (!positive && negatedPairs.length === 0) return undefined;
  return {
    mode: 'add',
    positive,
    pairs,
    negatedPairs,
    ...(unsupported === undefined ? {} : { unsupportedType: unsupported }),
  };
}

type TransitionLike = { id?: string; leftClipId: string; rightClipId: string; type: string };

function transitionsOf(project: JoyProjectV1 | undefined): readonly TransitionLike[] {
  return (project as { transitions?: readonly TransitionLike[] } | undefined)?.transitions ?? [];
}

/** Resolves "B", "clip B", "clip-b" or "2" to a clip id (by id, then by letter/number order). */
function resolveClipRef(ref: string, clipsByStart: readonly { id: string }[]): string | undefined {
  const token = ref.toLowerCase();
  const direct = clipsByStart.find(
    (clip) => clip.id.toLowerCase() === token || clip.id.toLowerCase() === 'clip-' + token,
  );
  if (direct) return direct.id;
  if (/^[a-z]$/.test(token)) return clipsByStart[token.charCodeAt(0) - 97]?.id;
  if (/^\d+$/.test(token)) return clipsByStart[Number(token) - 1]?.id;
  return undefined;
}

function samePair(transition: TransitionLike, a: string, b: string): boolean {
  return (
    (transition.leftClipId === a && transition.rightClipId === b) ||
    (transition.leftClipId === b && transition.rightClipId === a)
  );
}

function verifyTransitionIntent(
  intent: TransitionIntent,
  project: JoyProjectV1,
  before: JoyProjectV1 | undefined,
  clips: readonly { id: string; startUs: number }[],
  verified: string[],
  unmet: string[],
): void {
  const after = transitionsOf(project);
  const previous = transitionsOf(before);
  const clipsByStart = [...clips].sort((a, b) => a.startUs - b.startUs);
  const pairs = intent.pairs.map(([a, b]) => ({
    label: `${a} and ${b}`,
    ids: [resolveClipRef(a, clipsByStart), resolveClipRef(b, clipsByStart)] as const,
  }));
  if (intent.mode === 'remove') {
    if (pairs.length > 0) {
      for (const pair of pairs) {
        const [a, b] = pair.ids;
        const gone = a !== undefined && b !== undefined && !after.some((t) => samePair(t, a, b));
        (gone ? verified : unmet).push(
          gone
            ? `Request: no transition between ${pair.label}`
            : `request asked to remove the transition between ${pair.label}, but it is still there`,
        );
      }
      return;
    }
    if (before === undefined) return; // nothing to compare against
    const fewer = after.length < previous.length;
    (fewer ? verified : unmet).push(
      fewer
        ? 'Request: transition removed'
        : 'request asked to remove a transition, but the timeline has as many as before',
    );
    return;
  }
  const keyOf = (t: TransitionLike) => `${t.id ?? ''}|${t.leftClipId}|${t.rightClipId}|${t.type}`;
  const before_ = new Set(before === undefined ? [] : previous.map(keyOf));
  const newTransitions = after.filter((t) => !before_.has(keyOf(t)));
  for (const [a, b] of intent.negatedPairs) {
    const ids = [resolveClipRef(a, clipsByStart), resolveClipRef(b, clipsByStart)] as const;
    if (ids[0] === undefined || ids[1] === undefined) continue;
    if (newTransitions.some((t) => samePair(t, ids[0]!, ids[1]!)))
      unmet.push(`request asked for no transition between ${a} and ${b}, but this run added one`);
  }
  if (intent.positive === false) return;
  if (intent.unsupportedType !== undefined) {
    unmet.push(
      `request asked for a ${intent.unsupportedType} transition; only crossfade is supported`,
    );
    return;
  }
  // Only transitions this run added (or changed) count; a crossfade that was already there does not.
  const key = (t: TransitionLike) => `${t.id ?? ''}|${t.leftClipId}|${t.rightClipId}|${t.type}`;
  const existing = new Set(before === undefined ? [] : previous.map(key));
  const added = after.filter((t) => isCrossfade(t.type) && !existing.has(key(t)));
  if (pairs.length > 0) {
    for (const pair of pairs) {
      const [a, b] = pair.ids;
      const has = a !== undefined && b !== undefined && added.some((t) => samePair(t, a, b));
      (has ? verified : unmet).push(
        has
          ? `Request: crossfade between ${pair.label}`
          : `request asked for a crossfade between ${pair.label}, but this run added none there`,
      );
    }
    return;
  }
  const has = added.length > 0;
  (has ? verified : unmet).push(
    has
      ? 'Request: crossfade transition'
      : before === undefined
        ? 'request asked for a crossfade transition between clips, but the timeline has none'
        : 'request asked for a crossfade transition between clips, but this run added none',
  );
}

function isCrossfade(type: string): boolean {
  return type === 'dissolve' || type === 'crossfade';
}

function parseRequestedSpeed(normalized: string): number | undefined {
  if (/\btwice as fast\b|\bdouble (?:the )?speed\b/.test(normalized)) return 2;
  if (/\bhalf (?:the )?speed\b|\bhalf as fast\b/.test(normalized)) return 0.5;
  const multiple =
    /(\d+(?:\.\d+)?)\s*[x×]\s*(?:speed|faster|slower|playback)?/.exec(normalized) ??
    /\bspeed (?:of |to )?(\d+(?:\.\d+)?)\s*[x×]?/.exec(normalized);
  if (
    !multiple?.[1] ||
    !/\b(speed|fast|faster|slow|slower|playback|slow-?mo)\b|سرعت|تند|کند/.test(normalized)
  )
    return undefined;
  const rate = Number(multiple[1]);
  return rate > 0 ? rate : undefined;
}

function parseCaptionTimes(request: string): { text: string; startUs: number; endUs: number }[] {
  return [...request.matchAll(QUOTED_TIMED_TEXT)].flatMap((match) => {
    const startUs = Math.round(Number(match[2]) * 1_000_000);
    const endUs = Math.round(Number(match[3]) * 1_000_000);
    return endUs > startUs ? [{ text: match[1]!.trim(), startUs, endUs }] : [];
  });
}

function parseRequestIntent(request: string): RequestIntent {
  const normalized = request.toLowerCase();
  const intent: RequestIntent = {
    centerText: /\b(center|centre|centered|centred|middle)\b|وسط.?چین|وسط/i.test(normalized),
    startAtZero:
      /\b(at the start|at 0(?!\d|[:.,]\d)|from the beginning|start at zero)\b|از ابتدا|از ابتدای|از شروع/i.test(
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
  if (
    /\b(smaller|shrink|tinier|reduce (?:the )?(?:font |text )?size)\b|کوچک[\s\u200c]*تر/i.test(
      normalized,
    )
  )
    intent.textSize = 'smaller';
  else if (
    /\b(bigger|larger|enlarge|increase (?:the )?(?:font |text )?size)\b|بزرگ[\s\u200c]*تر/i.test(
      normalized,
    )
  )
    intent.textSize = 'larger';
  const transition = parseTransitionIntent(normalized);
  if (transition !== undefined) intent.transition = transition;
  if (
    transition === undefined &&
    /\bfade[- ]?(?:in|out|ins|outs)\b|\b(?:from|to) black\b/.test(normalized)
  )
    intent.fadeInOut = true;
  const speed = parseRequestedSpeed(normalized);
  if (speed !== undefined) intent.speed = speed;
  const captionTimes = parseCaptionTimes(request);
  if (captionTimes.length > 0) intent.captionTimes = captionTimes;
  return intent;
}

export function verifyRequestIntent(
  project: JoyProjectV1,
  request: string,
  /** The project before the run; enables checks of edits relative to it (smaller/larger). */
  before?: JoyProjectV1,
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
    // Audit item 2: when this run moved clips, one of the moved clips must be the one at 0; a
    // clip that already sat at 0 does not prove "move clip B to the start".
    const startBefore = new Map(
      (before?.compositions[before.rootCompositionId]?.tracks ?? [])
        .flatMap((track) => track.clips)
        .map((clip) => [clip.id, clip.startUs] as const),
    );
    const moved = clips.filter(
      (clip) => startBefore.has(clip.id) && startBefore.get(clip.id) !== clip.startUs,
    );
    // FT2 review HIGH: with a `before` project, only clips this run moved, added or changed
    // count; an untouched clip that already sat at 0 does not prove "move clip C to start at 0".
    const clipBefore = new Map(
      (before?.compositions[before.rootCompositionId]?.tracks ?? [])
        .flatMap((track) => track.clips)
        .map((clip) => [clip.id, JSON.stringify(clip)] as const),
    );
    const touched = clips.filter((clip) => clipBefore.get(clip.id) !== JSON.stringify(clip));
    const candidates = before === undefined ? clips : moved.length > 0 ? moved : touched;
    const startsAtZero = candidates.some((clip) => clip.startUs === 0);
    (startsAtZero ? verified : unmet).push(
      startsAtZero
        ? 'Request: clip starts at 0'
        : before === undefined || candidates.length > 0
          ? 'request asked for a clip starting at 0'
          : 'request asked for a clip starting at 0, but this run moved no clip',
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
    // Audit item 4: "both/all/every/each clip(s)" needs the look on every video clip.
    const videoClips = clips.filter((clip) => clip.kind === 'video');
    // "all clips", "both videos", "each of the shots", "both of them"; not "keep all audio".
    const everyClip =
      /\b(?:both|all|every|each)\s+(?:of\s+)?(?:(?:the|my|these|those)\s+)?(?:\w+\s+)?(?:clips?|videos?|shots?|them)\b/.test(
        request.toLowerCase(),
      );
    const hasLook = everyClip
      ? videoClips.length > 0 &&
        videoClips.every((clip) => clip.kind === 'video' && clip.look?.preset === intent.look)
      : videoClips.some((clip) => clip.kind === 'video' && clip.look?.preset === intent.look);
    (hasLook ? verified : unmet).push(
      hasLook ? `Request: ${intent.look} look` : `request asked for ${intent.look} look`,
    );
  }
  if (intent.transition)
    verifyTransitionIntent(intent.transition, project, before, clips, verified, unmet);
  if (before !== undefined && !requestsExplicitGap(request)) {
    // #7: a trim that leaves a hole between clips renders black there. Only holes this run
    // created and that have content after them count; a shorter ending is not a black gap.
    const durationUs = root?.durationUs ?? 0;
    const interior = (source: JoyProjectV1) =>
      summarizePlacements(source).blackRegions.filter((region) => region.endUs < durationUs);
    const earlier = interior(before);
    for (const region of interior(project)) {
      const existed = earlier.some(
        (old) => old.startUs <= region.startUs && old.endUs >= region.endUs,
      );
      if (!existed)
        unmet.push(
          `this run left a black gap at ${formatSeconds(region.startUs)}–${formatSeconds(region.endUs)} (no clip covers it); close the gap or ask for it explicitly`,
        );
    }
  }
  if (intent.fadeInOut)
    unmet.push('request asked for a fade in/out; fades from or to black are not supported');
  if (intent.speed !== undefined) {
    const rate = intent.speed;
    const sped = clips.some(
      (clip) => clip.kind === 'video' && Math.abs((clip.playbackRate ?? 1) - rate) < 1e-6,
    );
    (sped ? verified : unmet).push(
      sped
        ? `Request: ${rate}x speed`
        : `request asked for ${rate}x speed; no clip plays at ${rate}x`,
    );
  }
  if (intent.textSize !== undefined && before !== undefined) {
    const sizes = (source: JoyProjectV1) =>
      new Map(
        (source.compositions[source.rootCompositionId]?.tracks ?? [])
          .flatMap((track) => track.clips)
          .flatMap((clip) =>
            clip.kind === 'caption' ? [[clip.id, clip.style?.fontSize ?? 1] as const] : [],
          ),
      );
    const previous = sizes(before);
    const now = sizes(project);
    // Only checkable when there was text to resize; a new title is not "the title, smaller".
    if (previous.size > 0) {
      const changed = [...previous].some(([clipId, size]) => {
        const after = now.get(clipId);
        return after !== undefined && (intent.textSize === 'smaller' ? after < size : after > size);
      });
      (changed ? verified : unmet).push(
        changed
          ? `Request: existing text made ${intent.textSize}`
          : `request asked to make the existing text ${intent.textSize}, but no existing text got ${intent.textSize} (edit it with update-text instead of adding new text)`,
      );
    }
  }
  for (const wanted of intent.captionTimes ?? []) {
    const matches = captionClipsWithText(project, clips, wanted.text);
    const placed = matches.some(
      (clip) => clip.startUs === wanted.startUs && clip.startUs + clip.durationUs === wanted.endUs,
    );
    const range = `${seconds(wanted.startUs)} to ${seconds(wanted.endUs)}`;
    if (placed) verified.push(`Request: caption “${wanted.text}” from ${range}`);
    else
      unmet.push(
        `request asked for caption “${wanted.text}” from ${range}; ${
          matches.length === 0
            ? 'no caption has that text'
            : `it is at ${matches.map((clip) => `${seconds(clip.startUs)} to ${seconds(clip.startUs + clip.durationUs)}`).join(', ')}`
        }`,
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

function seconds(us: number): string {
  return `${Number((us / 1_000_000).toFixed(3))}s`;
}

type TimelineClip = NonNullable<
  JoyProjectV1['compositions'][string]
>['tracks'][number]['clips'][number];

function captionText(project: JoyProjectV1, documentId: string): string | undefined {
  const document = project.captionDocuments?.[documentId];
  return document?.segments
    .map(
      (segment) =>
        segment.textOverride ??
        segment.wordIds.map((id) => document.words[id]?.text ?? '').join(''),
    )
    .join(' ');
}

/** Caption clips whose text is exactly `text`. */
function captionClipsWithText(
  project: JoyProjectV1,
  clips: readonly TimelineClip[],
  text: string,
): TimelineClip[] {
  return clips.filter(
    (clip) => clip.kind === 'caption' && captionText(project, clip.captionDocumentId) === text,
  );
}

function checklistItemStart(
  project: JoyProjectV1,
  clips: readonly TimelineClip[],
  item: JoyPlanChecklistItem,
): number | undefined {
  if (item.kind === 'text') {
    const matches = captionClipsWithText(project, clips, item.text);
    return (
      matches.find((clip) => clip.startUs === item.timelineStartUs)?.startUs ?? matches[0]?.startUs
    );
  }
  // A transition starts at its cut, where the right clip starts.
  const clipId = item.kind === 'transition' ? item.rightClipId : item.clipId;
  return clips.find((clip) => clip.id === clipId)?.startUs;
}

/**
 * R1: a transition is anchored at its cut (where the right clip starts), but some models report
 * where the blend begins (cut - duration). Both describe the same crossfade, so any start in
 * [cut - duration, cut] is accepted.
 */
function transitionStartAccepted(
  project: JoyProjectV1,
  item: JoyPlanChecklistItem & { kind: 'transition' },
  cutUs: number,
  claimedUs: number,
): boolean {
  const transition = (
    project as { transitions?: readonly (TransitionLike & { durationUs?: number })[] }
  ).transitions?.find((candidate) => samePair(candidate, item.leftClipId, item.rightClipId));
  if (!transition) return false;
  const durationUs = transition.durationUs ?? 1_000_000;
  return claimedUs >= cutUs - durationUs && claimedUs <= cutUs;
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
    if (item.timelineStartUs !== undefined) {
      const start = checklistItemStart(project, clips, item);
      const label =
        item.kind === 'text'
          ? `text “${item.text}”`
          : item.kind === 'transition'
            ? `transition ${item.leftClipId} → ${item.rightClipId}`
            : `${item.kind} ${item.clipId}`;
      if (
        start === item.timelineStartUs ||
        (item.kind === 'transition' &&
          start !== undefined &&
          transitionStartAccepted(project, item, start, item.timelineStartUs))
      )
        verified.push(`Start of ${label}: ${seconds(item.timelineStartUs)}`);
      else
        unmet.push(
          `${label} expected to start at ${seconds(item.timelineStartUs)} but starts at ${start === undefined ? 'nothing' : seconds(start)}`,
        );
    }
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
    } else if (item.kind === 'transition') {
      const transitions =
        (
          project as {
            transitions?: readonly { leftClipId: string; rightClipId: string; type: string }[];
          }
        ).transitions ?? [];
      const has = transitions.some(
        (transition) =>
          transition.leftClipId === item.leftClipId &&
          transition.rightClipId === item.rightClipId &&
          isCrossfade(transition.type),
      );
      if (has) verified.push(`Crossfade ${item.leftClipId} → ${item.rightClipId}`);
      else unmet.push(`crossfade between ${item.leftClipId} and ${item.rightClipId}`);
    } else if (item.kind === 'speed') {
      const clip = clips.find((candidate) => candidate.id === item.clipId);
      if (clip?.kind === 'video' && Math.abs((clip.playbackRate ?? 1) - item.rate) < 1e-6)
        verified.push(`Speed ${item.clipId}: ${item.rate}x`);
      else unmet.push(`speed ${item.rate}x on clip ${item.clipId}`);
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
            (item.position === undefined || textAtPosition(caption.style, item.position))
          );
        }),
      );
      const where = item.position === undefined ? '' : ` ${positionLabel(item.position)}`;
      if (found) verified.push(`Text “${item.text}”${where}`);
      else unmet.push(`text “${item.text}”${where}`);
    }
  }
  return { verified, unmet };
}

/**
 * Checklist positions in CLI units (x from the centre; y = -positionY, measured from the
 * template's bottom title line, negative = up). "center" is horizontal centring, which is what
 * "centred near the bottom" means; bottom/middle/top are vertical bands of the frame.
 */
export function textAtPosition(
  style: { readonly positionX?: number; readonly positionY?: number } | undefined,
  position: NonNullable<Extract<JoyPlanChecklistItem, { kind: 'text' }>['position']>,
): boolean {
  const x = style?.positionX ?? 0;
  const y = -(style?.positionY ?? 0);
  if (position === 'center') return Math.abs(x) <= 0.05;
  if (position === 'bottom') return y >= -0.2;
  if (position === 'middle') return y < -0.2 && y > -0.5;
  return y <= -0.5;
}

function positionLabel(position: string): string {
  return position === 'center' ? 'centered' : `at the ${position}`;
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

function partialLimitMessage(reason: string | undefined, value?: number): string {
  const limit =
    reason === 'step-limit' ? 'step' : reason === 'tool-call-limit' ? 'tool-call' : 'safety';
  const count =
    value === undefined || limit === 'safety'
      ? ''
      : ` (${value} ${limit === 'step' ? 'steps' : 'tool calls'})`;
  return `Run stopped at the ${limit} limit${count} before the plan was final; nothing was applied.`;
}

/**
 * True only for an explicit ask to leave a gap ("leave a 2s black gap", "add 2 seconds of black").
 * "don't leave any gaps", "the title can stay blank" and "black and white look" are not.
 */
function requestsExplicitGap(request: string): boolean {
  const text = request.toLowerCase().replace(/black[\s-]*(?:and|&)[\s-]*white/g, ' ');
  const verb =
    "(?<!\\b(?:don'?t|do not|never|not|no)\\s+)\\b(?:leave|keep|add|insert|put|create|want)";
  const amount = '(?:\\d+(?:\\.\\d+)?\\s*(?:s|secs?|seconds?)\\s+)?';
  return (
    new RegExp(
      `${verb}\\s+(?:a\\s+|an\\s+|the\\s+)?${amount}(?:black\\s+|blank\\s+|empty\\s+)?gaps?\\b`,
    ).test(text) ||
    new RegExp(`${verb}\\s+${amount.slice(0, -1)}\\s*of\\s+(?:black|blank)\\b`).test(text)
  );
}

function formatSeconds(microseconds: number): string {
  return `${(microseconds / 1_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}
