/**
 * Production first-party workflow packs.
 *
 * The visible catalog is intentionally production-shaped: each pack declares the
 * ports/capabilities it needs and every effectful step is backed by a port that
 * fails closed when the host has not wired a real adapter. Fixture-only ports
 * live in the editor test/demo registry, not in these definitions.
 */

import { WorkflowBuilder, workflowToJson } from './authoring.js';
import type { JoyWorkflow } from './definition.js';
import type { ValueRef } from './library.js';
import { buildNodeLibrary } from './library.js';

/** Version of every production pipeline pack; bump when any definition changes. */
export const FIRST_PARTY_WORKFLOWS_VERSION = '2.0.0';
export const REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID =
  'joy.first-party.reference-social-cutdown.slice' as const;

const CAPTION_TEMPLATE_ID = 'joy.caption.clean';
const EXPORT_FOLDER_ID = 'exports';
const FINAL_RENDER_RETRY = { maxAttempts: 2, backoffMs: 1000 } as const;
const DEFAULT_PROVIDER_REFS = ['provider:analysis', 'provider:generation', 'provider:render'];

const input = (path?: string): ValueRef =>
  path === undefined ? { kind: 'input' } : { kind: 'input', path };

const upstream = (node: string, path?: string): ValueRef =>
  path === undefined ? { kind: 'upstream', node } : { kind: 'upstream', node, path };

const literal = (value: unknown): ValueRef => ({ kind: 'literal', value });

export interface FirstPartyWorkflow {
  readonly workflow: JoyWorkflow;
  /** Deterministic topological execution order, from validation. */
  readonly order: readonly string[];
}

export interface FirstPartyPipelinePack extends FirstPartyWorkflow {
  readonly label: string;
  readonly summary: string;
  readonly provider: 'production';
  readonly requiredPorts: readonly string[];
  readonly optionalPorts: readonly string[];
  readonly capabilities: readonly string[];
  readonly approvals: readonly string[];
  readonly reportRefs: readonly string[];
}

interface PackDescriptor {
  readonly id: FirstPartyWorkflowId;
  readonly fileName: string;
  readonly label: string;
  readonly summary: string;
  readonly requiredPorts: readonly string[];
  readonly optionalPorts?: readonly string[];
  readonly capabilities: readonly string[];
  readonly approvals: readonly string[];
  readonly reportRefs: readonly string[];
  readonly build: () => FirstPartyWorkflow;
}

const CONTENT_INPUTS = {
  type: 'object',
  required: ['brief', 'selectedMedia'],
  properties: {
    brief: {
      type: 'string',
      minLength: 1,
      description: 'Creative brief or client goal for this production run.',
      default: 'Create a polished, on-brand edit from the selected media.',
    },
    selectedMedia: {
      type: 'object',
      description: 'Opaque selected media references; never paths or URLs.',
    },
    references: {
      type: 'array',
      items: { type: 'object' },
      description: 'Optional clean-room reference notes or media fingerprints.',
    },
    rows: {
      type: 'array',
      items: { type: 'object' },
      description: 'Optional structured rows for promo variants.',
    },
    delivery: {
      type: 'object',
      description: 'Optional delivery promise: aspect, codec, captions, approval requirements.',
    },
  },
  additionalProperties: false,
} as const;

const REFERENCE_CONTENT_INPUTS = {
  ...CONTENT_INPUTS,
  required: ['brief', 'selectedMedia', 'references'],
} as const;

/**
 * Inputs for the certified editor-only reference cutdown slice.  The broad
 * reference pack above remains provider-backed; this smaller graph is the
 * deliberately bounded path that can be run with a connected EditorSession
 * and a plain file-backed clip. Commands arrive in the human approval response
 * so the approval is the authority for the mutation.
 */
const REFERENCE_CUTDOWN_SLICE_INPUTS = {
  type: 'object',
  required: ['selectedMedia', 'references'],
  properties: {
    selectedMedia: { type: 'object', description: 'Selected file-backed video reference.' },
    references: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
} as const;

const MANIFEST_OUTPUTS = {
  type: 'object',
  required: ['manifest'],
  properties: { manifest: { type: 'object' } },
} as const;

const unique = (...groups: readonly (readonly string[])[]): readonly string[] => [
  ...new Set(groups.flat()),
];

const BASE_PIPELINE_REQUIRED_PORTS = [
  'analysis.researchBrief',
  'generation.generateScript',
  'generation.generateShotlist',
  'analysis.detectHighlights',
  'transform.buildContactSheet',
] as const;

const APPROVAL_APPLY_REQUIRED_PORTS = ['editor.executeCommandTransaction'] as const;

const FINAL_DELIVERY_REQUIRED_PORTS = [
  'render.render',
  'render.inspect',
  'output.writeDeliveryManifest',
] as const;

const RUN_METADATA_REQUIRED_PORTS = ['output.writeMetadataFile'] as const;

const DRAFT_REEL_ITEM_REQUIRED_PORTS = [
  'editor.createBranch',
  'transform.reframe',
  'transform.applyCaptionTemplate',
  'transform.normalizeAudio',
  'render.render',
] as const;

const PROMO_ITEM_REQUIRED_PORTS = [
  'generation.translate',
  'generation.synthesizeSpeech',
  'transform.applyCaptionTemplate',
  'transform.instantiateSceneTemplate',
  'render.render',
  'render.inspect',
  'output.writeDeliveryManifest',
] as const;

const PODCAST_REQUIRED_PORTS = [
  'analysis.detectSpeakers',
  'analysis.detectSilence',
  'transform.denoise',
  'transform.normalizeAudio',
  'transform.trim',
  'analysis.transcribe',
  'analysis.generateChapters',
  'transform.applyCaptionTemplate',
  'render.render',
  'render.inspect',
  'output.writeDeliveryManifest',
] as const;

const INTERVIEW_EVIDENCE_REQUIRED_PORTS = [
  'analysis.transcribe',
  'analysis.generateChapters',
] as const;

const BASE_PIPELINE_CAPABILITIES = [
  'provider.research',
  'provider.script',
  'provider.highlights',
  'provider.cost',
  'editor.command',
  'render.final',
  'render.inspect',
  'output.write',
] as const;

function baseContentPipeline(
  builder: WorkflowBuilder,
  options: {
    readonly scriptStyle: string;
    readonly shotlistFormat: string;
    readonly candidateTitle: string;
    readonly candidateCount: number;
    readonly costUsd: number;
    readonly includeReferences?: boolean;
  },
): WorkflowBuilder {
  let current = builder
    .node('brief', 'input.item', { path: 'brief' })
    .node('selected-media', 'input.item', { path: 'selectedMedia' });
  if (options.includeReferences === true) {
    current = current.node('references', 'input.item', { path: 'references' });
  }

  current = current
    .node('research', 'analysis.researchBrief', {
      briefFrom: upstream('brief'),
      mediaFrom: upstream('selected-media'),
      ...(options.includeReferences === true ? { referencesFrom: upstream('references') } : {}),
    })
    .node('script', 'generation.script', {
      style: options.scriptStyle,
      briefFrom: upstream('brief'),
      researchFrom: upstream('research'),
      mediaFrom: upstream('selected-media'),
    })
    .node('shotlist', 'generation.shotlist', {
      format: options.shotlistFormat,
      scriptFrom: upstream('script'),
      mediaFrom: upstream('selected-media'),
    })
    .node('candidates', 'analysis.hooks', {
      source: upstream('selected-media'),
      transcriptFrom: upstream('script'),
      maxCandidates: options.candidateCount,
    })
    .node('contact-sheet', 'transform.contactSheet', {
      title: options.candidateTitle,
      candidatesFrom: upstream('candidates'),
      shotlistFrom: upstream('shotlist'),
      providerRefs: DEFAULT_PROVIDER_REFS,
    })
    .node('cost-brief', 'transform.compose', {
      fields: {
        estimatedUsd: literal(options.costUsd),
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        script: upstream('script'),
        shotlist: upstream('shotlist'),
        candidates: upstream('contact-sheet'),
      },
    })
    .node('confirm-cost', 'decision.approval', {
      kind: 'confirm-cost',
      prompt:
        'Confirm provider cost before candidate review. Respond with {approved: true} to continue.',
      payloadFrom: upstream('cost-brief'),
    })
    .edge('brief', 'research')
    .edge('selected-media', 'research');
  if (options.includeReferences === true) {
    current = current.edge('references', 'research');
  }

  return current
    .edge('brief', 'script')
    .edge('research', 'script')
    .edge('selected-media', 'script')
    .edge('script', 'shotlist')
    .edge('selected-media', 'shotlist')
    .edge('selected-media', 'candidates')
    .edge('script', 'candidates')
    .edge('candidates', 'contact-sheet')
    .edge('shotlist', 'contact-sheet')
    .edge('script', 'cost-brief')
    .edge('shotlist', 'cost-brief')
    .edge('contact-sheet', 'cost-brief')
    .edge('cost-brief', 'confirm-cost');
}

function addPackPermissions(builder: WorkflowBuilder): WorkflowBuilder {
  return builder
    .permission('provider.research')
    .permission('provider.script')
    .permission('provider.highlights')
    .permission('provider.cost')
    .permission('editor.command')
    .permission('render.final')
    .permission('render.inspect')
    .permission('output.write');
}

function buildApprovalApplyCommand(label: string): readonly unknown[] {
  return [
    {
      tool: 'artifact.create',
      arguments: {
        kind: 'workflow-approval',
        label,
        sourceRef: 'approval.response',
      },
    },
  ];
}

function buildFinalDeliveryWorkflow(id: string, name: string, profile: string): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id,
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name,
    inputs: { type: 'object', description: 'One approved render source.' },
    outputs: { type: 'object' },
  })
    .node('render', 'render.final', { profile, source: input() }, { retry: FINAL_RENDER_RETRY })
    .node('inspect', 'render.inspect', {
      source: upstream('render'),
      reportRef: `${id}.qa-report`,
    })
    .node('manifest', 'output.deliveryManifest', {
      folderId: EXPORT_FOLDER_ID,
      fileName: `${id.split('.').pop() ?? 'delivery'}.json`,
      source: upstream('render'),
      inspectionFrom: upstream('inspect'),
      providerRefs: DEFAULT_PROVIDER_REFS,
    })
    .edge('render', 'inspect')
    .edge('render', 'manifest')
    .edge('inspect', 'manifest')
    .build().workflow;
}

function buildDraftReelItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.long-video-draft-reels.item',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Draft reel per approved candidate',
    inputs: { type: 'object', description: 'One approved hook candidate.' },
    outputs: { type: 'object' },
  })
    .node('branch', 'editor.createBranch', { name: 'draft-reel', source: input() })
    .node('reframe', 'transform.reframe', {
      aspect: '9:16',
      source: upstream('branch'),
    })
    .node('caption', 'transform.caption', {
      templateId: CAPTION_TEMPLATE_ID,
      source: upstream('reframe'),
    })
    .node('mix', 'transform.normalizeAudio', {
      targetLufs: -14,
      duckMusic: true,
      source: upstream('caption'),
    })
    .node('preview', 'render.preview', { profile: 'review-proxy', source: upstream('mix') })
    .edge('branch', 'reframe')
    .edge('reframe', 'caption')
    .edge('caption', 'mix')
    .edge('mix', 'preview')
    .build().workflow;
}

export function buildLongVideoDraftReelsWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = baseContentPipeline(
    new WorkflowBuilder(registry, {
      id: 'joy.first-party.long-video-draft-reels',
      version: FIRST_PARTY_WORKFLOWS_VERSION,
      name: 'Long video draft reels',
      inputs: CONTENT_INPUTS,
      outputs: MANIFEST_OUTPUTS,
    }),
    {
      scriptStyle: 'short-form hook script',
      shotlistFormat: 'vertical-reels',
      candidateTitle: 'Draft reel contact sheet',
      candidateCount: 5,
      costUsd: 8,
    },
  )
    .node('approve-candidates', 'decision.approval', {
      kind: 'choose-candidates',
      prompt:
        'Choose hook candidates for editable draft reels. Respond with {candidates: [...]} where each candidate is self-contained.',
      payloadFrom: upstream('contact-sheet'),
    })
    .node('apply-approved-candidates', 'editor.commandTransaction', {
      label: 'Create draft-reel approval artifacts',
      commands: buildApprovalApplyCommand('Approved draft reel candidates'),
    })
    .node('draft-reels', 'control.map', {
      workflow: buildDraftReelItemWorkflow(),
      itemsFrom: upstream('approve-candidates', 'response.candidates'),
    })
    .node('approve-drafts', 'decision.approval', {
      kind: 'approve-render',
      prompt:
        'Review draft proxies. Respond with {approved: [...]} listing the drafts to render as finals.',
      payloadFrom: upstream('draft-reels'),
    })
    .node('final-reels', 'control.map', {
      workflow: buildFinalDeliveryWorkflow(
        'joy.first-party.long-video-draft-reels.final',
        'Final reel delivery per approved draft',
        'reel-vertical',
      ),
      itemsFrom: upstream('approve-drafts', 'response.approved'),
    })
    .node('run-report', 'transform.compose', {
      fields: {
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        costApproval: upstream('confirm-cost', 'response'),
        candidateApproval: upstream('approve-candidates', 'response'),
        renderApproval: upstream('approve-drafts', 'response'),
        deliveries: upstream('final-reels'),
      },
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'long-video-draft-reels-run.json',
      source: upstream('run-report'),
    })
    .edge('contact-sheet', 'approve-candidates')
    .edge('confirm-cost', 'approve-candidates')
    .edge('approve-candidates', 'apply-approved-candidates')
    .edge('approve-candidates', 'draft-reels')
    .edge('apply-approved-candidates', 'draft-reels')
    .edge('draft-reels', 'approve-drafts')
    .edge('approve-drafts', 'final-reels')
    .edge('confirm-cost', 'run-report')
    .edge('approve-candidates', 'run-report')
    .edge('approve-drafts', 'run-report')
    .edge('final-reels', 'run-report')
    .edge('run-report', 'manifest');
  return addPackPermissions(builder).build();
}

function buildPromoItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.multilingual-promo.item',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Promo render per approved row and language',
    inputs: { type: 'object', description: 'One approved row: copy, language, image, offer.' },
    outputs: { type: 'object' },
  })
    .node('translate', 'generation.translate', {
      textFrom: input('copy'),
      targetLanguageFrom: input('language'),
    })
    .node('voice', 'generation.speech', {
      voiceId: 'joy.voice.promo',
      textFrom: upstream('translate', 'text'),
    })
    .node('captions', 'transform.caption', {
      templateId: CAPTION_TEMPLATE_ID,
      source: upstream('voice'),
    })
    .node('assemble', 'transform.compose', {
      fields: {
        row: input(),
        translation: upstream('translate'),
        voiceOver: upstream('voice'),
        captions: upstream('captions'),
      },
    })
    .node('scene', 'transform.sceneTemplate', {
      templateId: 'joy.scene.product-card',
      variablesFrom: upstream('assemble'),
    })
    .node('render', 'render.final', { profile: 'promo-vertical', source: upstream('scene') })
    .node('inspect', 'render.inspect', {
      source: upstream('render'),
      reportRef: 'joy.first-party.multilingual-promo.qa-report',
    })
    .node('manifest', 'output.deliveryManifest', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'promo-delivery.json',
      source: upstream('render'),
      inspectionFrom: upstream('inspect'),
      providerRefs: DEFAULT_PROVIDER_REFS,
    })
    .edge('translate', 'voice')
    .edge('voice', 'captions')
    .edge('translate', 'assemble')
    .edge('voice', 'assemble')
    .edge('captions', 'assemble')
    .edge('assemble', 'scene')
    .edge('scene', 'render')
    .edge('render', 'inspect')
    .edge('render', 'manifest')
    .edge('inspect', 'manifest')
    .build().workflow;
}

export function buildMultilingualPromoWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = baseContentPipeline(
    new WorkflowBuilder(registry, {
      id: 'joy.first-party.multilingual-promo',
      version: FIRST_PARTY_WORKFLOWS_VERSION,
      name: 'Multilingual promo',
      inputs: CONTENT_INPUTS,
      outputs: MANIFEST_OUTPUTS,
    }),
    {
      scriptStyle: 'localized promo script',
      shotlistFormat: 'menu-promo',
      candidateTitle: 'Promo variant contact sheet',
      candidateCount: 4,
      costUsd: 12,
    },
  )
    .node('approve-copy', 'decision.approval', {
      kind: 'approve-transcript',
      prompt:
        'Approve localized promo rows. Respond with {rows: [...]} where each row has final copy and language.',
      payloadFrom: upstream('contact-sheet'),
    })
    .node('apply-approved-copy', 'editor.commandTransaction', {
      label: 'Create approved promo copy artifacts',
      commands: buildApprovalApplyCommand('Approved multilingual promo copy'),
    })
    .node('per-language', 'control.map', {
      workflow: buildPromoItemWorkflow(),
      itemsFrom: upstream('approve-copy', 'response.rows'),
    })
    .node('run-report', 'transform.compose', {
      fields: {
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        costApproval: upstream('confirm-cost', 'response'),
        copyApproval: upstream('approve-copy', 'response'),
        deliveries: upstream('per-language'),
      },
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'multilingual-promo-run.json',
      source: upstream('run-report'),
    })
    .edge('contact-sheet', 'approve-copy')
    .edge('confirm-cost', 'approve-copy')
    .edge('approve-copy', 'apply-approved-copy')
    .edge('approve-copy', 'per-language')
    .edge('apply-approved-copy', 'per-language')
    .edge('confirm-cost', 'run-report')
    .edge('approve-copy', 'run-report')
    .edge('per-language', 'run-report')
    .edge('run-report', 'manifest');
  return addPackPermissions(builder)
    .permission('provider.translate')
    .permission('provider.tts')
    .build();
}

function buildPodcastClipItemWorkflow(): JoyWorkflow {
  return buildFinalDeliveryWorkflow(
    'joy.first-party.podcast-cleanup.clip',
    'Podcast clip delivery per chapter',
    'podcast-clip',
  );
}

export function buildPodcastCleanupWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = baseContentPipeline(
    new WorkflowBuilder(registry, {
      id: 'joy.first-party.podcast-cleanup',
      version: FIRST_PARTY_WORKFLOWS_VERSION,
      name: 'Podcast cleanup',
      inputs: CONTENT_INPUTS,
      outputs: MANIFEST_OUTPUTS,
      policy: { failure: 'continue-independent' },
    }),
    {
      scriptStyle: 'podcast cleanup plan',
      shotlistFormat: 'chaptered-audio',
      candidateTitle: 'Podcast chapter contact sheet',
      candidateCount: 3,
      costUsd: 6,
    },
  )
    .node('speakers', 'analysis.speakers', { source: upstream('selected-media') })
    .node('confirm-speakers', 'decision.approval', {
      kind: 'choose-candidates',
      prompt: 'Confirm or correct detected speakers. Respond with {speakers: [...]}.',
      payloadFrom: upstream('speakers'),
    })
    .node('denoise', 'transform.denoise', { source: upstream('selected-media') })
    .node('normalize', 'transform.normalizeAudio', { targetLufs: -16, source: upstream('denoise') })
    .node('silence', 'analysis.silence', {
      thresholdDb: -40,
      minSilenceMs: 1500,
      source: upstream('normalize'),
    })
    .node('approve-edit-list', 'decision.approval', {
      kind: 'accept-edit-diff',
      prompt:
        'Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly those ranges are removed.',
      payloadFrom: upstream('silence'),
    })
    .node('apply-approved-edits', 'editor.commandTransaction', {
      label: 'Create approved podcast edit artifacts',
      commands: buildApprovalApplyCommand('Approved podcast cleanup edits'),
    })
    .node('trim', 'transform.trim', {
      source: upstream('normalize'),
      rangesFrom: upstream('approve-edit-list', 'response.ranges'),
    })
    .node('transcribe', 'analysis.transcribe', { source: upstream('trim') })
    .node('chapters', 'analysis.chapters', {
      source: upstream('trim'),
      transcriptFrom: upstream('transcribe'),
    })
    .node('captions', 'transform.caption', {
      templateId: CAPTION_TEMPLATE_ID,
      source: upstream('transcribe'),
    })
    .node('render-episode', 'render.final', {
      profile: 'podcast-episode',
      source: upstream('captions'),
    })
    .node('inspect-episode', 'render.inspect', {
      source: upstream('render-episode'),
      reportRef: 'joy.first-party.podcast-cleanup.qa-report',
    })
    .node('clips', 'control.map', {
      workflow: buildPodcastClipItemWorkflow(),
      itemsFrom: upstream('chapters', 'chapters'),
    })
    .node('run-report', 'transform.compose', {
      fields: {
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        costApproval: upstream('confirm-cost', 'response'),
        speakers: upstream('confirm-speakers', 'response'),
        editList: upstream('approve-edit-list', 'response'),
        chapters: upstream('chapters'),
        episodeInspection: upstream('inspect-episode'),
        clips: upstream('clips'),
      },
    })
    .node('manifest', 'output.deliveryManifest', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'podcast-cleanup-run.json',
      source: upstream('render-episode'),
      inspectionFrom: upstream('inspect-episode'),
      approvalsFrom: upstream('run-report'),
      providerRefs: DEFAULT_PROVIDER_REFS,
    })
    .edge('selected-media', 'speakers')
    .edge('speakers', 'confirm-speakers')
    .edge('selected-media', 'denoise')
    .edge('denoise', 'normalize')
    .edge('normalize', 'silence')
    .edge('silence', 'approve-edit-list')
    .edge('approve-edit-list', 'apply-approved-edits')
    .edge('normalize', 'trim')
    .edge('approve-edit-list', 'trim')
    .edge('apply-approved-edits', 'trim')
    .edge('trim', 'transcribe')
    .edge('trim', 'chapters')
    .edge('transcribe', 'chapters')
    .edge('transcribe', 'captions')
    .edge('captions', 'render-episode')
    .edge('render-episode', 'inspect-episode')
    .edge('chapters', 'clips')
    .edge('confirm-cost', 'run-report')
    .edge('confirm-speakers', 'run-report')
    .edge('approve-edit-list', 'run-report')
    .edge('chapters', 'run-report')
    .edge('inspect-episode', 'run-report')
    .edge('clips', 'run-report')
    .edge('render-episode', 'manifest')
    .edge('inspect-episode', 'manifest')
    .edge('run-report', 'manifest');
  return addPackPermissions(builder)
    .permission('provider.audio-cleanup')
    .permission('provider.transcribe')
    .build();
}

export function buildReferenceSocialCutdownWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = baseContentPipeline(
    new WorkflowBuilder(registry, {
      id: 'joy.first-party.reference-social-cutdown',
      version: FIRST_PARTY_WORKFLOWS_VERSION,
      name: 'Reference social cutdown',
      inputs: REFERENCE_CONTENT_INPUTS,
      outputs: MANIFEST_OUTPUTS,
    }),
    {
      scriptStyle: 'clean-room social cutdown',
      shotlistFormat: 'reference-driven-cutdown',
      candidateTitle: 'Clean-room reference cutdown contact sheet',
      candidateCount: 6,
      costUsd: 10,
      includeReferences: true,
    },
  )
    .node('approve-cutdown', 'decision.approval', {
      kind: 'choose-candidates',
      prompt:
        'Choose clean-room social cutdown candidates. Respond with {candidates: [...]} using only reference-derived structure, not copied assets.',
      payloadFrom: upstream('contact-sheet'),
    })
    .node('apply-cutdown', 'editor.commandTransaction', {
      label: 'Create approved reference cutdown artifacts',
      commands: buildApprovalApplyCommand('Approved clean-room social cutdown'),
    })
    .node('finals', 'control.map', {
      workflow: buildFinalDeliveryWorkflow(
        'joy.first-party.reference-social-cutdown.delivery',
        'Reference social cutdown delivery',
        'social-cutdown-vertical',
      ),
      itemsFrom: upstream('approve-cutdown', 'response.candidates'),
    })
    .node('run-report', 'transform.compose', {
      fields: {
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        costApproval: upstream('confirm-cost', 'response'),
        creativeApproval: upstream('approve-cutdown', 'response'),
        deliveries: upstream('finals'),
      },
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'reference-social-cutdown-run.json',
      source: upstream('run-report'),
    })
    .edge('contact-sheet', 'approve-cutdown')
    .edge('confirm-cost', 'approve-cutdown')
    .edge('approve-cutdown', 'apply-cutdown')
    .edge('approve-cutdown', 'finals')
    .edge('apply-cutdown', 'finals')
    .edge('confirm-cost', 'run-report')
    .edge('approve-cutdown', 'run-report')
    .edge('finals', 'run-report')
    .edge('run-report', 'manifest');
  return addPackPermissions(builder).permission('provider.reference-analysis').build();
}

/**
 * The smallest real reference → social cutdown workflow.
 *
 * It intentionally contains no synthetic research/render/provider result. A
 * human approves a concrete timeline command list, and the connected editor
 * port applies that list as one durable, undoable transaction. Rendering and
 * delivery remain downstream concerns owned by the verified Worker path.
 */
export function buildReferenceSocialCutdownSliceWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = new WorkflowBuilder(registry, {
    id: REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Reference social cutdown (certified editor slice)',
    inputs: REFERENCE_CUTDOWN_SLICE_INPUTS,
    outputs: {
      type: 'object',
      required: ['transaction', 'selectedMedia', 'references'],
    },
  })
    .node('selected-media', 'input.item', { path: 'selectedMedia' })
    .node('references', 'input.item', { path: 'references' })
    .node('review', 'transform.compose', {
      fields: {
        selectedMedia: upstream('selected-media'),
        references: upstream('references'),
      },
    })
    .node('approve-cutdown', 'decision.approval', {
      kind: 'choose-candidates',
      prompt:
        'Approve the reference-derived cut. Respond with {commands: [...]} containing only timeline commands for the selected file-backed video.',
      payloadFrom: upstream('review'),
    })
    .node('apply-cutdown', 'editor.commandTransaction', {
      label: 'Apply approved reference social cutdown',
      commandsFrom: upstream('approve-cutdown', 'response.commands'),
    })
    .node('result', 'transform.compose', {
      fields: {
        transaction: upstream('apply-cutdown'),
        selectedMedia: upstream('selected-media'),
        references: upstream('references'),
        approval: upstream('approve-cutdown', 'response'),
      },
    })
    .edge('selected-media', 'review')
    .edge('references', 'review')
    .edge('review', 'approve-cutdown')
    .edge('approve-cutdown', 'apply-cutdown')
    .edge('selected-media', 'result')
    .edge('references', 'result')
    .edge('approve-cutdown', 'result')
    .edge('apply-cutdown', 'result');
  return builder.permission('editor.command').build();
}

export function buildInterviewDocumentaryAssemblyWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  const builder = baseContentPipeline(
    new WorkflowBuilder(registry, {
      id: 'joy.first-party.interview-documentary-assembly',
      version: FIRST_PARTY_WORKFLOWS_VERSION,
      name: 'Interview documentary assembly',
      inputs: CONTENT_INPUTS,
      outputs: MANIFEST_OUTPUTS,
    }),
    {
      scriptStyle: 'documentary assembly treatment',
      shotlistFormat: 'interview-documentary',
      candidateTitle: 'Documentary assembly contact sheet',
      candidateCount: 5,
      costUsd: 14,
    },
  )
    .node('transcribe', 'analysis.transcribe', { source: upstream('selected-media') })
    .node('chapters', 'analysis.chapters', {
      source: upstream('selected-media'),
      transcriptFrom: upstream('transcribe'),
    })
    .node('approve-assembly', 'decision.approval', {
      kind: 'choose-candidates',
      prompt:
        'Choose the interview/documentary assembly structure. Respond with {candidates: [...]} for renderable assemblies.',
      payloadFrom: upstream('contact-sheet'),
    })
    .node('apply-assembly', 'editor.commandTransaction', {
      label: 'Create approved documentary assembly artifacts',
      commands: buildApprovalApplyCommand('Approved interview documentary assembly'),
    })
    .node('finals', 'control.map', {
      workflow: buildFinalDeliveryWorkflow(
        'joy.first-party.interview-documentary-assembly.delivery',
        'Interview documentary delivery',
        'documentary-assembly',
      ),
      itemsFrom: upstream('approve-assembly', 'response.candidates'),
    })
    .node('run-report', 'transform.compose', {
      fields: {
        providerRefs: literal(DEFAULT_PROVIDER_REFS),
        costApproval: upstream('confirm-cost', 'response'),
        assemblyApproval: upstream('approve-assembly', 'response'),
        transcript: upstream('transcribe'),
        chapters: upstream('chapters'),
        deliveries: upstream('finals'),
      },
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'interview-documentary-assembly-run.json',
      source: upstream('run-report'),
    })
    .edge('selected-media', 'transcribe')
    .edge('transcribe', 'chapters')
    .edge('selected-media', 'chapters')
    .edge('contact-sheet', 'approve-assembly')
    .edge('confirm-cost', 'approve-assembly')
    .edge('approve-assembly', 'apply-assembly')
    .edge('approve-assembly', 'finals')
    .edge('apply-assembly', 'finals')
    .edge('confirm-cost', 'run-report')
    .edge('approve-assembly', 'run-report')
    .edge('transcribe', 'run-report')
    .edge('chapters', 'run-report')
    .edge('finals', 'run-report')
    .edge('run-report', 'manifest');
  return addPackPermissions(builder).permission('provider.transcribe').build();
}

export const FIRST_PARTY_WORKFLOW_IDS = [
  'joy.first-party.long-video-draft-reels',
  'joy.first-party.multilingual-promo',
  'joy.first-party.podcast-cleanup',
  'joy.first-party.reference-social-cutdown',
  REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
  'joy.first-party.interview-documentary-assembly',
] as const;

export type FirstPartyWorkflowId = (typeof FIRST_PARTY_WORKFLOW_IDS)[number];

const PACK_DESCRIPTORS: readonly PackDescriptor[] = [
  {
    id: 'joy.first-party.long-video-draft-reels',
    fileName: 'long-video-draft-reels.json',
    label: 'Production pack',
    summary:
      'Brief-to-research reel pipeline with contact sheet, approvals, final QA, and manifest.',
    requiredPorts: unique(
      BASE_PIPELINE_REQUIRED_PORTS,
      APPROVAL_APPLY_REQUIRED_PORTS,
      DRAFT_REEL_ITEM_REQUIRED_PORTS,
      FINAL_DELIVERY_REQUIRED_PORTS,
      RUN_METADATA_REQUIRED_PORTS,
    ),
    capabilities: BASE_PIPELINE_CAPABILITIES,
    approvals: ['confirm-cost', 'choose-candidates', 'approve-render'],
    reportRefs: ['joy.first-party.long-video-draft-reels.final.qa-report'],
    build: buildLongVideoDraftReelsWorkflow,
  },
  {
    id: 'joy.first-party.multilingual-promo',
    fileName: 'multilingual-promo.json',
    label: 'Production pack',
    summary: 'Localized promo pipeline with copy approval, TTS, final QA, and delivery manifest.',
    requiredPorts: unique(
      BASE_PIPELINE_REQUIRED_PORTS,
      APPROVAL_APPLY_REQUIRED_PORTS,
      PROMO_ITEM_REQUIRED_PORTS,
      RUN_METADATA_REQUIRED_PORTS,
    ),
    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.translate', 'provider.tts']),
    approvals: ['confirm-cost', 'approve-transcript'],
    reportRefs: ['joy.first-party.multilingual-promo.qa-report'],
    build: buildMultilingualPromoWorkflow,
  },
  {
    id: 'joy.first-party.podcast-cleanup',
    fileName: 'podcast-cleanup.json',
    label: 'Production pack',
    summary:
      'Podcast cleanup with approved speakers/edit list, episode render, clips, QA, and manifest.',
    requiredPorts: unique(
      BASE_PIPELINE_REQUIRED_PORTS,
      APPROVAL_APPLY_REQUIRED_PORTS,
      PODCAST_REQUIRED_PORTS,
    ),
    capabilities: unique(BASE_PIPELINE_CAPABILITIES, [
      'provider.audio-cleanup',
      'provider.transcribe',
    ]),
    approvals: ['confirm-cost', 'choose-candidates', 'accept-edit-diff'],
    reportRefs: ['joy.first-party.podcast-cleanup.qa-report'],
    build: buildPodcastCleanupWorkflow,
  },
  {
    id: 'joy.first-party.reference-social-cutdown',
    fileName: 'reference-social-cutdown.json',
    label: 'Production pack',
    summary:
      'Clean-room reference-driven social cutdown from brief/media/references to QA delivery.',
    requiredPorts: unique(
      BASE_PIPELINE_REQUIRED_PORTS,
      APPROVAL_APPLY_REQUIRED_PORTS,
      FINAL_DELIVERY_REQUIRED_PORTS,
      RUN_METADATA_REQUIRED_PORTS,
    ),
    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.reference-analysis']),
    approvals: ['confirm-cost', 'choose-candidates'],
    reportRefs: ['joy.first-party.reference-social-cutdown.delivery.qa-report'],
    build: buildReferenceSocialCutdownWorkflow,
  },
  {
    id: REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
    fileName: 'reference-social-cutdown.slice.json',
    label: 'Certified editor slice',
    summary: 'Certified editor-only reference cutdown with one durable timeline transaction.',
    requiredPorts: ['editor.executeCommandTransaction'],
    capabilities: ['editor.command'],
    approvals: ['choose-candidates'],
    reportRefs: ['joy.first-party.reference-social-cutdown.slice.qa-report'],
    build: buildReferenceSocialCutdownSliceWorkflow,
  },
  {
    id: 'joy.first-party.interview-documentary-assembly',
    fileName: 'interview-documentary-assembly.json',
    label: 'Production pack',
    summary:
      'Interview/documentary assembly with transcript/chapter evidence, approval, QA, and manifest.',
    requiredPorts: unique(
      BASE_PIPELINE_REQUIRED_PORTS,
      INTERVIEW_EVIDENCE_REQUIRED_PORTS,
      APPROVAL_APPLY_REQUIRED_PORTS,
      FINAL_DELIVERY_REQUIRED_PORTS,
      RUN_METADATA_REQUIRED_PORTS,
    ),
    capabilities: unique(BASE_PIPELINE_CAPABILITIES, ['provider.transcribe']),
    approvals: ['confirm-cost', 'choose-candidates'],
    reportRefs: ['joy.first-party.interview-documentary-assembly.delivery.qa-report'],
    build: buildInterviewDocumentaryAssemblyWorkflow,
  },
];

export function buildFirstPartyPipelinePacks(): readonly FirstPartyPipelinePack[] {
  return PACK_DESCRIPTORS.map((descriptor) => {
    const built = descriptor.build();
    return {
      ...built,
      label: descriptor.label,
      summary: descriptor.summary,
      provider: 'production',
      requiredPorts: descriptor.requiredPorts,
      optionalPorts: descriptor.optionalPorts ?? [],
      capabilities: descriptor.capabilities,
      approvals: descriptor.approvals,
      reportRefs: descriptor.reportRefs,
    };
  });
}

/** Builds every first-party workflow (registry-validated). */
export function buildFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
  return buildFirstPartyPipelinePacks().map(({ workflow, order }) => ({ workflow, order }));
}

export interface FirstPartyDefinitionFile {
  /** File name under `packages/workflow-engine/workflows/`. */
  readonly fileName: string;
  /** Stable `workflowToJson` serialization (diffable, `joy-workflow` CLI-runnable). */
  readonly json: string;
}

/** The committed JSON artifacts; a test pins the files byte-for-byte to these. */
export function firstPartyDefinitionFiles(): readonly FirstPartyDefinitionFile[] {
  return PACK_DESCRIPTORS.map((descriptor) => ({
    fileName: descriptor.fileName,
    json: workflowToJson(descriptor.build().workflow),
  }));
}
