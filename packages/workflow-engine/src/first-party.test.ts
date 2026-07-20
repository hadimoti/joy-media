import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowBuilder, parseWorkflowJson, workflowToJson } from './authoring.js';
import {
  FIRST_PARTY_WORKFLOWS_VERSION,
  FIRST_PARTY_WORKFLOW_IDS,
  buildFirstPartyWorkflows,
  buildLongVideoDraftReelsWorkflow,
  buildMultilingualPromoWorkflow,
  buildPodcastCleanupWorkflow,
  firstPartyDefinitionFiles,
} from './first-party.js';
import { runWorkflowHeadless } from './headless.js';
import type { NodeLibrary } from './library.js';
import { buildNodeLibrary } from './library.js';

// ---------------------------------------------------------------------------
// Stub environment: every port records its calls and returns deterministic,
// self-describing values, so tests can assert both wiring and invocation counts
// (no duplicated completed work across resumes — §36 Phase 7 exit criterion).
// ---------------------------------------------------------------------------

function stubEnvironment() {
  const calls = new Map<string, unknown[]>();
  const track = <A>(name: string, result: (args: A) => unknown): ((args: A) => unknown) => {
    return (args: A) => {
      const list = calls.get(name) ?? [];
      list.push(args);
      calls.set(name, list);
      return result(args);
    };
  };
  const count = (name: string): number => calls.get(name)?.length ?? 0;
  const argsOf = (name: string): readonly unknown[] => calls.get(name) ?? [];

  let branchSeq = 0;
  const library = buildNodeLibrary({
    ports: {
      analysis: {
        transcribe: track('transcribe', () => ({
          language: 'fa',
          segments: [{ text: 'سلام و خوش آمدید', startUs: 0 }],
        })),
        detectSilence: track('detectSilence', () => ({
          ranges: [
            { startUs: 10_000_000, endUs: 12_500_000 },
            { startUs: 40_000_000, endUs: 43_000_000 },
          ],
        })),
        detectHighlights: track('detectHighlights', (args: { source: unknown }) => ({
          candidates: [
            { title: 'Hook A', source: args.source, subjectHints: { focus: 'speaker' } },
            { title: 'Hook B', source: args.source, subjectHints: { focus: 'product' } },
            { title: 'Hook C', source: args.source, subjectHints: { focus: 'wide' } },
          ],
        })),
        detectSpeakers: track('detectSpeakers', () => ({
          speakers: [{ id: 'spk-1' }, { id: 'spk-2' }],
        })),
        generateChapters: track('generateChapters', (args: { source: unknown }) => ({
          chapters: [
            { title: 'Intro', startUs: 0, endUs: 60_000_000, source: args.source },
            { title: 'Main topic', startUs: 60_000_000, endUs: 300_000_000, source: args.source },
          ],
        })),
      },
      transform: {
        trim: track('trim', (args: { source: unknown; ranges: unknown }) => ({
          trimmed: true,
          ranges: args.ranges,
        })),
        applyCaptionTemplate: track('caption', (args: { templateId: string }) => ({
          captioned: true,
          templateId: args.templateId,
        })),
        reframe: track('reframe', (args: { aspect: string; subjectHints?: unknown }) => ({
          reframed: args.aspect,
          subjectHints: args.subjectHints ?? null,
        })),
        denoise: track('denoise', () => ({ denoised: true })),
        normalizeAudio: track(
          'normalizeAudio',
          (args: { targetLufs?: number; duckMusic?: boolean }) => ({
            normalized: args.targetLufs ?? null,
            duckMusic: args.duckMusic === true,
          }),
        ),
        instantiateSceneTemplate: track(
          'scene',
          (args: { templateId: string; variables: unknown }) => ({
            sceneInstance: args.templateId,
            variables: args.variables,
          }),
        ),
      },
      generation: {
        synthesizeSpeech: track('speech', (args: { text: string; voiceId: string }) => ({
          voiceOver: args.text,
          voiceId: args.voiceId,
        })),
        translate: track('translate', (args: { text: string; targetLanguage: string }) => ({
          text: `[${args.targetLanguage}] ${args.text}`,
          targetLanguage: args.targetLanguage,
        })),
      },
      editor: {
        // Typed by hand: the port's return type is concrete ({branchId}).
        createBranch: (args: { readonly name: string; readonly source: unknown }) => {
          const list = calls.get('createBranch') ?? [];
          list.push(args);
          calls.set('createBranch', list);
          branchSeq += 1;
          return { branchId: `branch-${String(branchSeq)}` };
        },
      },
      render: {
        render: track('render', (args: { mode: 'preview' | 'final'; profile?: string }) => ({
          rendered: args.mode,
          profile: args.profile ?? null,
        })),
      },
      output: {
        writeToFolder: track('writeToFolder', (args: { folderId: string }) => ({
          written: true,
          folderId: args.folderId,
        })),
        writeMetadataFile: track('writeMetadata', (args: { fileName: string }) => ({
          written: true,
          fileName: args.fileName,
        })),
      },
    },
  });
  return { library, count, argsOf };
}

const runHeadless = (
  library: NodeLibrary,
  workflowJson: string,
  inputs: unknown,
  runId: string,
  extras: {
    readonly resumeFromJson?: string;
    readonly humanInputs?: Readonly<Record<string, unknown>>;
  } = {},
) =>
  runWorkflowHeadless({
    workflowJson,
    inputs,
    handlers: library.handlers,
    registry: library.registry,
    runId,
    projectRevision: 'rev-fp',
    ...extras,
  });

// ---------------------------------------------------------------------------
// Definitions: versioned, registry-validated, pinned to committed artifacts.
// ---------------------------------------------------------------------------

describe('first-party workflow definitions (§23.4)', () => {
  it('every definition builds, validates against the v1 registry, and is versioned', () => {
    const built = buildFirstPartyWorkflows();
    expect(built.map((entry) => entry.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
    const { registry } = buildNodeLibrary();
    for (const { workflow, order } of built) {
      expect(workflow.version).toBe(FIRST_PARTY_WORKFLOWS_VERSION);
      expect(workflow.permissions.length).toBeGreaterThan(0);
      const parsed = parseWorkflowJson(workflowToJson(workflow), { registry });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.order).toEqual(order);
        expect(parsed.order).toHaveLength(workflow.nodes.length);
      }
    }
  });

  it('matches the committed workflows/*.json artifacts exactly (§23.7 version diff)', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
    for (const file of firstPartyDefinitionFiles()) {
      const committed = readFileSync(join(dir, file.fileName), 'utf8').replaceAll('\r\n', '\n');
      expect(committed).toBe(file.json);
    }
  });
});

// ---------------------------------------------------------------------------
// WP-07.4 library extensions.
// ---------------------------------------------------------------------------

describe('WP-07.4 library extensions', () => {
  it('validates params for the new node types at authoring time', () => {
    const { registry } = buildNodeLibrary();
    expect(() => registry.createNode('r', 'transform.reframe', {})).toThrowError(/aspect/);
    expect(() => registry.createNode('t', 'generation.translate', { text: 'hi' })).toThrowError(
      /targetLanguage/,
    );
    expect(() =>
      registry.createNode('s', 'transform.sceneTemplate', { templateId: 'x' }),
    ).toThrowError(/variables/);
    expect(() => registry.createNode('c', 'transform.compose', { fields: { a: 42 } })).toThrowError(
      /value reference/,
    );
    expect(() => registry.createNode('h', 'analysis.hooks', { maxCandidates: 0 })).toThrowError(
      /maxCandidates/,
    );
  });

  it('rejects declaring generation.translate deterministic (§23.5)', () => {
    const { registry } = buildNodeLibrary();
    expect(() =>
      registry.createNode(
        't',
        'generation.translate',
        { text: 'x', targetLanguage: 'fa' },
        { deterministic: true },
      ),
    ).toThrowError(/deterministic/);
  });

  it('transform.compose is pure fan-in over named value references', () => {
    const { registry, handlers } = buildNodeLibrary();
    const { workflow } = new WorkflowBuilder(registry, {
      id: 'wf-compose',
      version: '1.0.0',
      name: 'Compose test',
    })
      .node('a', 'input.value', { value: 1 })
      .node('b', 'input.value', { value: { nested: 'x' } })
      .node('merge', 'transform.compose', {
        fields: {
          one: { kind: 'upstream', node: 'a' },
          nested: { kind: 'upstream', node: 'b', path: 'nested' },
          fromInputs: { kind: 'input', path: 'k' },
          lit: { kind: 'literal', value: true },
        },
      })
      .edge('a', 'merge')
      .edge('b', 'merge')
      .build();

    const result = runWorkflowHeadless({
      workflowJson: workflowToJson(workflow),
      inputs: { k: 'v' },
      handlers,
      registry,
      runId: 'compose-run',
      projectRevision: 'rev-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state).toBe('succeeded');
    expect(result.checkpoint.nodes['merge']?.output).toEqual({
      one: 1,
      nested: 'x',
      fromInputs: 'v',
      lit: true,
    });
  });

  it('port-backed extension nodes fail honestly with coded port-unavailable errors', () => {
    const { registry, handlers } = buildNodeLibrary(); // no ports at all
    const { workflow } = new WorkflowBuilder(registry, {
      id: 'wf-no-ports',
      version: '1.0.0',
      name: 'Missing port test',
    })
      .node('src', 'input.value', { value: { assetId: 'a' } })
      .node('hooks', 'analysis.hooks', { source: { kind: 'upstream', node: 'src' } })
      .edge('src', 'hooks')
      .build();

    const result = runWorkflowHeadless({
      workflowJson: workflowToJson(workflow),
      inputs: {},
      handlers,
      registry,
      runId: 'no-ports-run',
      projectRevision: 'rev-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state).toBe('failed');
    expect(result.checkpoint.nodes['hooks']?.failureCode).toBe(
      'workflow/port-unavailable:analysis.detectHighlights',
    );
  });
});

// ---------------------------------------------------------------------------
// Long video → draft reels, end to end (§23.4).
// ---------------------------------------------------------------------------

describe('long video → draft reels', () => {
  it('runs candidate approval → per-candidate editable drafts → render approval → finals', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildLongVideoDraftReelsWorkflow().workflow);
    const inputs = { asset: { assetId: 'asset-long-1' } };

    // 1. Runs to the candidate approval and parks (§23.6) — no Worker resources held.
    const first = runHeadless(library, workflowJson, inputs, 'reels-run');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    const candidateRequest = first.checkpoint.nodes['approve-candidates']?.pendingRequest;
    expect(candidateRequest?.kind).toBe('choose-candidates');
    const payload = candidateRequest?.payload as { candidates: readonly { title: string }[] };
    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
      'Hook A',
      'Hook B',
      'Hook C',
    ]);
    expect(count('transcribe')).toBe(1);
    expect(count('detectHighlights')).toBe(1);
    expect(count('createBranch')).toBe(0);

    // 2. Resume with two chosen candidates: one editable branch + review proxy each.
    const chosen = payload.candidates.slice(0, 2);
    const second = runHeadless(library, workflowJson, inputs, 'reels-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'approve-candidates': { candidates: chosen } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('waiting_for_input');
    const draftRequest = second.checkpoint.nodes['approve-drafts']?.pendingRequest;
    expect(draftRequest?.kind).toBe('approve-render');
    expect((draftRequest?.payload as { count: number }).count).toBe(2);
    // One input batch generated multiple *editable* project variants (§36 Phase 7).
    expect(count('createBranch')).toBe(2);
    expect(count('reframe')).toBe(2);
    expect(argsOf('reframe').map((args) => (args as { aspect: string }).aspect)).toEqual([
      '9:16',
      '9:16',
    ]);
    expect(count('caption')).toBe(2);
    expect(count('normalizeAudio')).toBe(2);
    expect(argsOf('render').map((args) => (args as { mode: string }).mode)).toEqual([
      'preview',
      'preview',
    ]);
    // Resuming did not duplicate completed work (§36 Phase 7).
    expect(count('transcribe')).toBe(1);
    expect(count('detectHighlights')).toBe(1);

    // 3. Resume with render approval: finals render and outputs are written once.
    const approved = (draftRequest?.payload as { items: readonly unknown[] }).items;
    const third = runHeadless(library, workflowJson, inputs, 'reels-run', {
      resumeFromJson: JSON.stringify(second.checkpoint),
      humanInputs: { 'approve-drafts': { approved } },
    });
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.state).toBe('succeeded');
    expect(third.outputIssues).toEqual([]);
    expect(Object.keys(third.outputs)).toEqual(['manifest']);
    const renderModes = argsOf('render').map((args) => (args as { mode: string }).mode);
    expect(renderModes).toEqual(['preview', 'preview', 'final', 'final']);
    expect(count('writeToFolder')).toBe(2);
    expect(count('writeMetadata')).toBe(1);
    expect((argsOf('writeMetadata')[0] as { fileName: string }).fileName).toBe(
      'long-video-draft-reels-run.json',
    );
    // Earlier stages still ran exactly once across all three sessions.
    expect(count('transcribe')).toBe(1);
    expect(count('createBranch')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multilingual restaurant promo, end to end (§23.4).
// ---------------------------------------------------------------------------

describe('multilingual restaurant promo', () => {
  it('approves copy once, then renders one translated, voiced promo per row/language', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildMultilingualPromoWorkflow().workflow);
    const rows = [
      {
        name: 'Koobideh',
        priceText: '€12',
        image: { assetId: 'img-koobideh' },
        language: 'fa',
        copy: 'کباب کوبیده تازه',
      },
      {
        name: 'Koobideh',
        priceText: '€12',
        image: { assetId: 'img-koobideh' },
        language: 'en',
        copy: 'Fresh koobideh kebab',
      },
    ];
    const inputs = { rows };

    const first = runHeadless(library, workflowJson, inputs, 'promo-run');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    const request = first.checkpoint.nodes['approve-copy']?.pendingRequest;
    expect(request?.kind).toBe('approve-transcript');
    expect(request?.payload).toEqual(rows);
    expect(count('translate')).toBe(0);

    const second = runHeadless(library, workflowJson, inputs, 'promo-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'approve-copy': { rows } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('succeeded');
    expect(second.outputIssues).toEqual([]);
    expect(Object.keys(second.outputs)).toEqual(['manifest']);

    // Approved copy was translated per row language, then voiced from the translation.
    expect(
      argsOf('translate').map((args) => (args as { targetLanguage: string }).targetLanguage),
    ).toEqual(['fa', 'en']);
    expect(argsOf('speech').map((args) => (args as { text: string }).text)).toEqual([
      '[fa] کباب کوبیده تازه',
      '[en] Fresh koobideh kebab',
    ]);
    // Each row instantiated the Product Card scene with the assembled variables.
    const sceneCalls = argsOf('scene') as readonly {
      templateId: string;
      variables: { row: unknown };
    }[];
    expect(sceneCalls).toHaveLength(2);
    for (const [index, call] of sceneCalls.entries()) {
      expect(call.templateId).toBe('joy.scene.product-card');
      expect(call.variables.row).toEqual(rows[index]);
    }
    expect(argsOf('render').map((args) => (args as { mode: string }).mode)).toEqual([
      'final',
      'final',
    ]);
    expect(count('writeToFolder')).toBe(2);
    expect(count('writeMetadata')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Podcast cleanup, end to end (§23.4).
// ---------------------------------------------------------------------------

describe('podcast cleanup', () => {
  it('parks both approvals while the independent audio branch keeps running', () => {
    const { library, count } = stubEnvironment();
    const workflowJson = workflowToJson(buildPodcastCleanupWorkflow().workflow);
    const inputs = { source: { assetId: 'asset-episode-1' } };

    const first = runHeadless(library, workflowJson, inputs, 'podcast-run-park');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    expect(first.checkpoint.nodes['confirm-speakers']?.pendingRequest?.kind).toBe(
      'choose-candidates',
    );
    expect(first.checkpoint.nodes['approve-edit-list']?.pendingRequest?.kind).toBe(
      'accept-edit-diff',
    );
    // The speaker approval parked, but the independent audio branch ran on (§23.6):
    expect(count('denoise')).toBe(1);
    expect(count('normalizeAudio')).toBe(1);
    expect(count('detectSilence')).toBe(1);
    // Nothing past the edit-list approval executed.
    expect(count('trim')).toBe(0);
    expect(count('transcribe')).toBe(0);
  });

  it('applies exactly the human-approved edit list, then exports the episode plus clips', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildPodcastCleanupWorkflow().workflow);
    const inputs = { source: { assetId: 'asset-episode-1' } };

    const first = runHeadless(library, workflowJson, inputs, 'podcast-run');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    // The human drops the second detected silence: the approved list is authoritative.
    const approvedRanges = [{ startUs: 10_000_000, endUs: 12_500_000 }];
    const speakers = [{ id: 'spk-1', name: 'Host' }];
    const second = runHeadless(library, workflowJson, inputs, 'podcast-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: {
        'confirm-speakers': { speakers },
        'approve-edit-list': { ranges: approvedRanges },
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('succeeded');
    expect(second.outputIssues).toEqual([]);
    expect(Object.keys(second.outputs).sort()).toEqual(['manifest', 'save-episode']);

    expect(count('trim')).toBe(1);
    expect((argsOf('trim')[0] as { ranges: unknown }).ranges).toEqual(approvedRanges);
    // Transcript/chapters run on the trimmed episode; episode + one clip per chapter render.
    expect(count('transcribe')).toBe(1);
    expect(count('generateChapters')).toBe(1);
    expect(
      argsOf('render')
        .map((args) => (args as { profile: string | null }).profile)
        .sort(),
    ).toEqual(['podcast-clip', 'podcast-clip', 'podcast-episode']);
    expect(count('writeToFolder')).toBe(3);
    // The audit manifest records the human decisions and generated structure.
    const metadata = (
      argsOf('writeMetadata')[0] as {
        metadata: { speakers: unknown; editList: unknown; chapters: unknown; clips: unknown };
      }
    ).metadata;
    expect(metadata.speakers).toEqual({ speakers });
    expect(metadata.editList).toEqual({ ranges: approvedRanges });
    expect(metadata.chapters).toBeDefined();
    expect(metadata.clips).toBeDefined();
    // No duplicated completed work across the resume (§36 Phase 7).
    expect(count('detectSpeakers')).toBe(1);
    expect(count('detectSilence')).toBe(1);
    expect(count('denoise')).toBe(1);
  });
});
