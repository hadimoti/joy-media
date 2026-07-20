/**
 * P07 WP-07.4 — first-party workflows (§23.4): long-video→draft-reels,
 * multilingual promo, and podcast cleanup as tested, versioned definitions.
 *
 * Each definition is authored in code through `WorkflowBuilder` against the v1
 * node registry, so params are validated at authoring time and `build()` re-runs
 * full definition + registry validation. The serialized JSON artifacts live in
 * `packages/workflow-engine/workflows/*.json` (diffable, CLI-runnable via
 * `joy-workflow`); a test pins them byte-for-byte to the builder output, so any
 * definition change shows up as a reviewable JSON diff.
 *
 * Regenerate the JSON artifacts after `pnpm --filter @joy-media/workflow-engine build`:
 *
 *   node -e "import('./packages/workflow-engine/dist/first-party.js').then(m => { const fs = require('node:fs'); for (const f of m.firstPartyDefinitionFiles()) fs.writeFileSync('packages/workflow-engine/workflows/' + f.fileName, f.json); })"
 */

import { WorkflowBuilder, workflowToJson } from './authoring.js';
import type { JoyWorkflow } from './definition.js';
import type { ValueRef } from './library.js';
import { buildNodeLibrary } from './library.js';

/** Version of every first-party definition; bump when any definition changes. */
export const FIRST_PARTY_WORKFLOWS_VERSION = '1.0.0';

/** Caption template applied by all first-party workflows (P03 JOY templates). */
const CAPTION_TEMPLATE_ID = 'joy.caption.clean';

/** Opaque export-folder reference (§44: never a filesystem path). */
const EXPORT_FOLDER_ID = 'exports';

const input = (path?: string): ValueRef =>
  path === undefined ? { kind: 'input' } : { kind: 'input', path };

const upstream = (node: string, path?: string): ValueRef =>
  path === undefined ? { kind: 'upstream', node } : { kind: 'upstream', node, path };

const FINAL_RENDER_RETRY = { maxAttempts: 2, backoffMs: 1000 } as const;

export interface FirstPartyWorkflow {
  readonly workflow: JoyWorkflow;
  /** Deterministic topological execution order, from validation. */
  readonly order: readonly string[];
}

// ---------------------------------------------------------------------------
// 1. Long video → draft reels (§23.4).
// ---------------------------------------------------------------------------

/**
 * Per-candidate sub-workflow: branch → reframe(9:16) → caption → normalize/duck
 * → review proxy. Map items are approved hook candidates and must be
 * self-contained: each carries its `source` and `subjectHints`.
 */
function buildDraftReelItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.long-video-draft-reels.item',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Draft reel per approved candidate',
    inputs: {
      type: 'object',
      description:
        'One approved hook candidate; must carry its own source reference and subjectHints.',
    },
    outputs: { type: 'object' },
  })
    .node('branch', 'editor.createBranch', { name: 'draft-reel', source: input() })
    .node('reframe', 'transform.reframe', {
      aspect: '9:16',
      source: upstream('branch'),
      subjectHintsFrom: input('subjectHints'),
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

/** Per-approved-draft sub-workflow: final render → export folder. */
function buildFinalReelItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.long-video-draft-reels.final',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Final reel per approved draft',
    inputs: { type: 'object', description: 'One approved draft (self-contained render source).' },
    outputs: { type: 'object' },
  })
    .node(
      'final',
      'render.final',
      { profile: 'reel-vertical', source: input() },
      { retry: FINAL_RENDER_RETRY },
    )
    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('final') })
    .edge('final', 'save')
    .build().workflow;
}

/**
 * §23.4 "Long video to draft reels": transcribe → hook candidates → human
 * candidate choice (parks, §23.6) → one editable branch + captioned 9:16 review
 * proxy per candidate (map) → human render approval (parks) → finals + manifest.
 */
export function buildLongVideoDraftReelsWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.long-video-draft-reels',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Long video → draft reels',
    inputs: {
      type: 'object',
      required: ['asset'],
      properties: {
        asset: { type: 'object', description: 'Opaque source video asset reference.' },
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      required: ['manifest'],
      properties: { manifest: { type: 'object' } },
    },
  })
    .node('ingest', 'input.item', { path: 'asset' })
    .node('transcribe', 'analysis.transcribe', { source: upstream('ingest') })
    .node('hooks', 'analysis.hooks', {
      source: upstream('ingest'),
      transcriptFrom: upstream('transcribe'),
      maxCandidates: 5,
    })
    .node('approve-candidates', 'decision.approval', {
      kind: 'choose-candidates',
      prompt:
        'Choose which hook candidates become draft reels. Respond with {candidates: [...]}; each candidate must carry its source and subjectHints.',
      payloadFrom: upstream('hooks'),
    })
    .node('draft-reels', 'control.map', {
      workflow: buildDraftReelItemWorkflow(),
      itemsFrom: upstream('approve-candidates', 'response.candidates'),
    })
    .node('approve-drafts', 'decision.approval', {
      kind: 'approve-render',
      prompt:
        'Review the draft previews. Respond with {approved: [...]} listing the drafts to render as finals; each entry must be a self-contained render source.',
      payloadFrom: upstream('draft-reels'),
    })
    .node('final-reels', 'control.map', {
      workflow: buildFinalReelItemWorkflow(),
      itemsFrom: upstream('approve-drafts', 'response.approved'),
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'long-video-draft-reels-run.json',
      source: upstream('final-reels'),
    })
    .edge('ingest', 'transcribe')
    .edge('ingest', 'hooks')
    .edge('transcribe', 'hooks')
    .edge('hooks', 'approve-candidates')
    .edge('approve-candidates', 'draft-reels')
    .edge('draft-reels', 'approve-drafts')
    .edge('approve-drafts', 'final-reels')
    .edge('final-reels', 'manifest')
    .permission('provider.transcribe')
    .permission('provider.highlights')
    .permission('render.final')
    .permission('output.write')
    .build();
}

// ---------------------------------------------------------------------------
// 2. Multilingual restaurant promo (§23.4).
// ---------------------------------------------------------------------------

/**
 * Per-row sub-workflow: translate approved copy → voice-over → aligned captions
 * → compose scene variables → Product Card scene instance → final render →
 * export. Map items are approved rows; each carries name, priceText, image,
 * language, and copy.
 */
function buildPromoItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.multilingual-promo.item',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Promo render per menu row and language',
    inputs: {
      type: 'object',
      description: 'One approved menu row: name, priceText, image, language, copy.',
    },
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
    .node(
      'render',
      'render.final',
      { profile: 'promo-vertical', source: upstream('scene') },
      { retry: FINAL_RENDER_RETRY },
    )
    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('render') })
    .edge('translate', 'voice')
    .edge('voice', 'captions')
    .edge('translate', 'assemble')
    .edge('voice', 'assemble')
    .edge('captions', 'assemble')
    .edge('assemble', 'scene')
    .edge('scene', 'render')
    .edge('render', 'save')
    .build().workflow;
}

/**
 * §23.4 "Multilingual restaurant promo": rows in → human copy approval (parks,
 * §23.6; the response carries the final per-row copy) → one translated, voiced,
 * captioned Product Card render per row/language (map) → manifest.
 */
export function buildMultilingualPromoWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.multilingual-promo',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Multilingual restaurant promo',
    inputs: {
      type: 'object',
      required: ['rows'],
      properties: {
        rows: {
          type: 'array',
          minItems: 1,
          items: { type: 'object' },
          description: 'Menu rows: name, priceText, image, language, copy.',
        },
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      required: ['manifest'],
      properties: { manifest: { type: 'object' } },
    },
  })
    .node('rows', 'input.item', { path: 'rows' })
    .node('approve-copy', 'decision.approval', {
      kind: 'approve-transcript',
      prompt:
        'Approve the promo copy for every row. Respond with {rows: [...]} where each row carries its final copy plus name, priceText, image, and language.',
      payloadFrom: upstream('rows'),
    })
    .node('per-language', 'control.map', {
      workflow: buildPromoItemWorkflow(),
      itemsFrom: upstream('approve-copy', 'response.rows'),
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'multilingual-promo-run.json',
      source: upstream('per-language'),
    })
    .edge('rows', 'approve-copy')
    .edge('approve-copy', 'per-language')
    .edge('per-language', 'manifest')
    .permission('provider.translate')
    .permission('provider.tts')
    .permission('render.final')
    .permission('output.write')
    .build();
}

// ---------------------------------------------------------------------------
// 3. Podcast cleanup (§23.4).
// ---------------------------------------------------------------------------

/** Per-chapter sub-workflow: final clip render → export folder. */
function buildPodcastClipItemWorkflow(): JoyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.podcast-cleanup.clip',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Podcast clip per chapter',
    inputs: { type: 'object', description: 'One chapter (self-contained renderable reference).' },
    outputs: { type: 'object' },
  })
    .node(
      'clip',
      'render.final',
      { profile: 'podcast-clip', source: input() },
      { retry: FINAL_RENDER_RETRY },
    )
    .node('save', 'output.folder', { folderId: EXPORT_FOLDER_ID, source: upstream('clip') })
    .edge('clip', 'save')
    .build().workflow;
}

/**
 * §23.4 "Podcast cleanup": ingest → speaker detection + confirmation (parks;
 * the independent audio branch keeps running, §23.6) → denoise → normalize →
 * silence detection → human-approved edit list (parks; the approved ranges are
 * authoritative) → trim → transcript, chapters, captions → episode final render
 * + one clip per chapter (map) → audit manifest.
 */
export function buildPodcastCleanupWorkflow(): FirstPartyWorkflow {
  const { registry } = buildNodeLibrary();
  return new WorkflowBuilder(registry, {
    id: 'joy.first-party.podcast-cleanup',
    version: FIRST_PARTY_WORKFLOWS_VERSION,
    name: 'Podcast cleanup',
    inputs: {
      type: 'object',
      required: ['source'],
      properties: {
        source: { type: 'object', description: 'Opaque episode audio/video asset reference.' },
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      required: ['save-episode', 'manifest'],
      properties: { 'save-episode': { type: 'object' }, manifest: { type: 'object' } },
    },
  })
    .node('ingest', 'input.item', { path: 'source' })
    .node('speakers', 'analysis.speakers', { source: upstream('ingest') })
    .node('confirm-speakers', 'decision.approval', {
      kind: 'choose-candidates',
      prompt: 'Confirm or correct the detected speakers. Respond with {speakers: [...]}.',
      payloadFrom: upstream('speakers'),
    })
    .node('denoise', 'transform.denoise', { source: upstream('ingest') })
    .node('normalize', 'transform.normalizeAudio', { targetLufs: -16, source: upstream('denoise') })
    .node('silence', 'analysis.silence', {
      thresholdDb: -40,
      minSilenceMs: 1500,
      source: upstream('normalize'),
    })
    .node('approve-edit-list', 'decision.approval', {
      kind: 'accept-edit-diff',
      prompt:
        'Approve the silence-removal edit list. Respond with {ranges: [...]}; exactly the approved ranges are removed.',
      payloadFrom: upstream('silence'),
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
    .node(
      'render-episode',
      'render.final',
      { profile: 'podcast-episode', source: upstream('captions') },
      { retry: FINAL_RENDER_RETRY },
    )
    .node('save-episode', 'output.folder', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'episode',
      source: upstream('render-episode'),
    })
    .node('clips', 'control.map', {
      workflow: buildPodcastClipItemWorkflow(),
      itemsFrom: upstream('chapters', 'chapters'),
    })
    .node('audit', 'transform.compose', {
      fields: {
        speakers: upstream('confirm-speakers', 'response'),
        editList: upstream('approve-edit-list', 'response'),
        chapters: upstream('chapters'),
        clips: upstream('clips'),
      },
    })
    .node('manifest', 'output.metadata', {
      folderId: EXPORT_FOLDER_ID,
      fileName: 'podcast-cleanup-run.json',
      source: upstream('audit'),
    })
    .edge('ingest', 'speakers')
    .edge('speakers', 'confirm-speakers')
    .edge('ingest', 'denoise')
    .edge('denoise', 'normalize')
    .edge('normalize', 'silence')
    .edge('silence', 'approve-edit-list')
    .edge('normalize', 'trim')
    .edge('approve-edit-list', 'trim')
    .edge('trim', 'transcribe')
    .edge('trim', 'chapters')
    .edge('transcribe', 'chapters')
    .edge('transcribe', 'captions')
    .edge('captions', 'render-episode')
    .edge('render-episode', 'save-episode')
    .edge('chapters', 'clips')
    .edge('confirm-speakers', 'audit')
    .edge('approve-edit-list', 'audit')
    .edge('chapters', 'audit')
    .edge('clips', 'audit')
    .edge('audit', 'manifest')
    .permission('provider.audio-cleanup')
    .permission('provider.transcribe')
    .permission('render.final')
    .permission('output.write')
    .build();
}

// ---------------------------------------------------------------------------
// Catalog + serialized artifacts.
// ---------------------------------------------------------------------------

export const FIRST_PARTY_WORKFLOW_IDS = [
  'joy.first-party.long-video-draft-reels',
  'joy.first-party.multilingual-promo',
  'joy.first-party.podcast-cleanup',
] as const;

/** Builds every first-party workflow (registry-validated). */
export function buildFirstPartyWorkflows(): readonly FirstPartyWorkflow[] {
  return [
    buildLongVideoDraftReelsWorkflow(),
    buildMultilingualPromoWorkflow(),
    buildPodcastCleanupWorkflow(),
  ];
}

export interface FirstPartyDefinitionFile {
  /** File name under `packages/workflow-engine/workflows/`. */
  readonly fileName: string;
  /** Stable `workflowToJson` serialization (diffable, `joy-workflow` CLI-runnable). */
  readonly json: string;
}

/** The committed JSON artifacts; a test pins the files byte-for-byte to these. */
export function firstPartyDefinitionFiles(): readonly FirstPartyDefinitionFile[] {
  return [
    {
      fileName: 'long-video-draft-reels.json',
      json: workflowToJson(buildLongVideoDraftReelsWorkflow().workflow),
    },
    {
      fileName: 'multilingual-promo.json',
      json: workflowToJson(buildMultilingualPromoWorkflow().workflow),
    },
    {
      fileName: 'podcast-cleanup.json',
      json: workflowToJson(buildPodcastCleanupWorkflow().workflow),
    },
  ];
}
