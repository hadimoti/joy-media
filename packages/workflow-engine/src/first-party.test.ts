import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowBuilder, parseWorkflowJson, workflowToJson } from './authoring.js';
import {
  FIRST_PARTY_WORKFLOWS_VERSION,
  FIRST_PARTY_WORKFLOW_IDS,
  REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID,
  buildFirstPartyPipelinePacks,
  buildFirstPartyWorkflows,
  buildLongVideoDraftReelsWorkflow,
  buildMultilingualPromoWorkflow,
  buildPodcastCleanupWorkflow,
  buildInterviewDocumentaryAssemblyWorkflow,
  buildReferenceSocialCutdownWorkflow,
  firstPartyDefinitionFiles,
} from './first-party.js';
import type { JoyWorkflow } from './definition.js';
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
        researchBrief: track(
          'researchBrief',
          (args: { brief: unknown; media: unknown; references?: unknown }) => ({
            researchRef: 'research-1',
            brief: args.brief,
            media: args.media,
            ...(args.references !== undefined ? { references: args.references } : {}),
            providerRefs: ['provider:fixture-research'],
          }),
        ),
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
        buildContactSheet: track(
          'contactSheet',
          (args: { title: string; candidates: unknown }) => ({
            title: args.title,
            candidates:
              args.candidates !== null &&
              typeof args.candidates === 'object' &&
              Array.isArray((args.candidates as { candidates?: unknown }).candidates)
                ? (args.candidates as { candidates: readonly unknown[] }).candidates
                : args.candidates,
            contactSheetRef: 'contact-sheet-1',
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
        generateScript: track('script', (args: { brief: unknown }) => ({
          scriptRef: 'script-1',
          text: `Script: ${String(args.brief)}`,
        })),
        generateShotlist: track('shotlist', () => ({
          shots: [{ id: 'shot-1', sourceRef: 'asset-long-1' }],
        })),
      },
      editor: {
        executeCommandTransaction: (args: {
          readonly label: string;
          readonly commands: readonly unknown[];
        }) => {
          const list = calls.get('commandTransaction') ?? [];
          list.push(args);
          calls.set('commandTransaction', list);
          return { transactionId: `tx-${args.label.toLowerCase().replaceAll(' ', '-')}` };
        },
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
        inspect: track('inspect', (args: { reportRef?: string }) => ({
          reportRef: args.reportRef ?? 'report-fixture',
          findings: [{ code: 'fixture-pass', status: 'pass' }],
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
        writeDeliveryManifest: track('writeDeliveryManifest', (args: { fileName: string }) => ({
          written: true,
          fileName: args.fileName,
          deliveryRef: `delivery:${args.fileName}`,
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
    readonly reuseNondeterministic?: boolean;
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

const productionInputs = (overrides: Record<string, unknown> = {}) => ({
  brief: 'Make a polished social-ready edit from the selected media.',
  selectedMedia: { assetId: 'asset-long-1' },
  ...overrides,
});

const PORT_BACKED_NODE_PORTS = new Map<string, string>([
  ['analysis.researchBrief', 'analysis.researchBrief'],
  ['analysis.transcribe', 'analysis.transcribe'],
  ['analysis.silence', 'analysis.detectSilence'],
  ['analysis.loudness', 'analysis.measureLoudness'],
  ['analysis.hooks', 'analysis.detectHighlights'],
  ['analysis.speakers', 'analysis.detectSpeakers'],
  ['analysis.chapters', 'analysis.generateChapters'],
  ['transform.trim', 'transform.trim'],
  ['transform.caption', 'transform.applyCaptionTemplate'],
  ['transform.reframe', 'transform.reframe'],
  ['transform.denoise', 'transform.denoise'],
  ['transform.normalizeAudio', 'transform.normalizeAudio'],
  ['transform.sceneTemplate', 'transform.instantiateSceneTemplate'],
  ['transform.contactSheet', 'transform.buildContactSheet'],
  ['generation.speech', 'generation.synthesizeSpeech'],
  ['generation.image', 'generation.generateImage'],
  ['generation.translate', 'generation.translate'],
  ['generation.script', 'generation.generateScript'],
  ['generation.shotlist', 'generation.generateShotlist'],
  ['editor.commandTransaction', 'editor.executeCommandTransaction'],
  ['editor.createBranch', 'editor.createBranch'],
  ['render.preview', 'render.render'],
  ['render.final', 'render.render'],
  ['render.inspect', 'render.inspect'],
  ['output.folder', 'output.writeToFolder'],
  ['output.metadata', 'output.writeMetadataFile'],
  ['output.deliveryManifest', 'output.writeDeliveryManifest'],
]);

function isWorkflowLike(value: unknown): value is JoyWorkflow {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { readonly nodes?: unknown }).nodes)
  );
}

function collectRequiredPortsFromWorkflow(workflow: JoyWorkflow): readonly string[] {
  const ports = new Set<string>();
  const visit = (current: JoyWorkflow) => {
    for (const node of current.nodes) {
      const port = PORT_BACKED_NODE_PORTS.get(node.type);
      if (port !== undefined) {
        ports.add(port);
      }
      const nestedWorkflow = node.params['workflow'];
      if (isWorkflowLike(nestedWorkflow)) {
        visit(nestedWorkflow);
      }
    }
  };
  visit(workflow);
  return [...ports].sort();
}

// ---------------------------------------------------------------------------
// Definitions: versioned, registry-validated, pinned to committed artifacts.
// ---------------------------------------------------------------------------

describe('first-party workflow definitions (§23.4)', () => {
  it('every definition builds, validates against the v1 registry, and is versioned', () => {
    expect(FIRST_PARTY_WORKFLOW_IDS).toContain(REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID);
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

  it('declares production pack metadata, ports, approvals, capabilities, and report refs', () => {
    const packs = buildFirstPartyPipelinePacks();
    expect(packs.map((pack) => pack.workflow.id)).toEqual([...FIRST_PARTY_WORKFLOW_IDS]);
    expect(packs).toHaveLength(6);
    for (const pack of packs) {
      expect(pack.provider).toBe('production');
      expect(pack.label).toBe(
        pack.workflow.id === REFERENCE_SOCIAL_CUTDOWN_SLICE_WORKFLOW_ID
          ? 'Certified editor slice'
          : 'Production pack',
      );
      expect(pack.requiredPorts.length).toBeGreaterThan(0);
      expect(pack.capabilities.length).toBeGreaterThan(0);
      if (pack.workflow.id === 'joy.first-party.reference-social-cutdown.slice') {
        expect(pack.approvals).toEqual(['choose-candidates']);
        expect(pack.workflow.nodes.map((node) => node.id)).toEqual(
          expect.arrayContaining([
            'selected-media',
            'references',
            'approve-cutdown',
            'apply-cutdown',
          ]),
        );
        continue;
      }
      expect(pack.approvals).toContain('confirm-cost');
      expect(pack.reportRefs.length).toBeGreaterThan(0);
      const declaredPorts = new Set([...pack.requiredPorts, ...pack.optionalPorts]);
      const missingPorts = collectRequiredPortsFromWorkflow(pack.workflow).filter(
        (port) => !declaredPorts.has(port),
      );
      expect(missingPorts).toEqual([]);
      const declaredCapabilities = new Set(pack.capabilities);
      const missingCapabilities = pack.workflow.permissions
        .map((permission) => permission.capability)
        .filter((capability) => !declaredCapabilities.has(capability));
      expect(missingCapabilities).toEqual([]);
      expect(pack.workflow.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          'brief',
          'selected-media',
          'research',
          'script',
          'shotlist',
          'candidates',
          'contact-sheet',
          'confirm-cost',
          'manifest',
        ]),
      );
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
    expect(() =>
      registry.createNode('r', 'analysis.researchBrief', { briefFrom: { kind: 'input' } }),
    ).toThrowError(/mediaFrom/);
    expect(() =>
      registry.createNode('s', 'generation.script', {
        briefFrom: { kind: 'input', path: 'brief' },
        mediaFrom: { kind: 'input', path: 'selectedMedia' },
      }),
    ).toThrowError(/researchFrom/);
    expect(() =>
      registry.createNode('cs', 'transform.contactSheet', {
        title: 'x',
        candidatesFrom: { kind: 'input', path: 'candidates' },
        providerRefs: [1],
      }),
    ).toThrowError(/providerRefs/);
    expect(() =>
      registry.createNode('dm', 'output.deliveryManifest', {
        folderId: 'exports',
        source: { kind: 'input' },
      }),
    ).toThrowError(/fileName/);
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
      .node('research', 'analysis.researchBrief', {
        briefFrom: { kind: 'literal', value: 'brief' },
        mediaFrom: { kind: 'upstream', node: 'src' },
      })
      .edge('src', 'research')
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
    expect(result.checkpoint.nodes['research']?.failureCode).toBe(
      'workflow/port-unavailable:analysis.researchBrief',
    );
  });
});

// ---------------------------------------------------------------------------
// Long video → draft reels, end to end (§23.4).
// ---------------------------------------------------------------------------

describe('long video → draft reels', () => {
  it('runs cost approval → contact-sheet candidate approval → editable drafts → render QA → delivery', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildLongVideoDraftReelsWorkflow().workflow);
    const inputs = productionInputs();

    // 1. Research/script/shotlist/contact sheet run, then provider cost parks.
    const first = runHeadless(library, workflowJson, inputs, 'reels-run');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    const costRequest = first.checkpoint.nodes['confirm-cost']?.pendingRequest;
    expect(costRequest?.kind).toBe('confirm-cost');
    expect(count('researchBrief')).toBe(1);
    expect(count('script')).toBe(1);
    expect(count('shotlist')).toBe(1);
    expect(count('detectHighlights')).toBe(1);
    expect(count('contactSheet')).toBe(1);
    expect(count('createBranch')).toBe(0);

    // 2. Cost approval resumes to the contact-sheet candidate approval.
    const second = runHeadless(library, workflowJson, inputs, 'reels-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
      reuseNondeterministic: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('waiting_for_input');
    const candidateRequest = second.checkpoint.nodes['approve-candidates']?.pendingRequest;
    expect(candidateRequest?.kind).toBe('choose-candidates');
    const payload = candidateRequest?.payload as { candidates: readonly { title: string }[] };
    expect(payload.candidates.map((candidate) => candidate.title)).toEqual([
      'Hook A',
      'Hook B',
      'Hook C',
    ]);
    expect(count('script')).toBe(1);
    expect(count('detectHighlights')).toBe(1);

    // 3. Candidate approval applies one command transaction, then builds editable drafts.
    const chosen = payload.candidates.slice(0, 2);
    const third = runHeadless(library, workflowJson, inputs, 'reels-run', {
      resumeFromJson: JSON.stringify(second.checkpoint),
      humanInputs: { 'approve-candidates': { candidates: chosen } },
      reuseNondeterministic: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.state).toBe('waiting_for_input');
    const draftRequest = third.checkpoint.nodes['approve-drafts']?.pendingRequest;
    expect(draftRequest?.kind).toBe('approve-render');
    expect((draftRequest?.payload as { count: number }).count).toBe(2);
    expect(count('commandTransaction')).toBe(1);
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
    expect(count('script')).toBe(1);
    expect(count('detectHighlights')).toBe(1);

    // 4. Render approval creates final renders, bounded QA reports, delivery manifests, and run report.
    const approved = (draftRequest?.payload as { items: readonly unknown[] }).items;
    const fourth = runHeadless(library, workflowJson, inputs, 'reels-run', {
      resumeFromJson: JSON.stringify(third.checkpoint),
      humanInputs: { 'approve-drafts': { approved } },
      reuseNondeterministic: true,
    });
    expect(fourth.ok).toBe(true);
    if (!fourth.ok) {
      return;
    }
    expect(fourth.state).toBe('succeeded');
    expect(fourth.outputIssues).toEqual([]);
    expect(Object.keys(fourth.outputs)).toEqual(['manifest']);
    const renderModes = argsOf('render').map((args) => (args as { mode: string }).mode);
    expect(renderModes).toEqual(['preview', 'preview', 'final', 'final']);
    expect(count('inspect')).toBe(2);
    expect(count('writeDeliveryManifest')).toBe(2);
    expect(count('writeMetadata')).toBe(1);
    expect((argsOf('writeMetadata')[0] as { fileName: string }).fileName).toBe(
      'long-video-draft-reels-run.json',
    );
    expect(count('script')).toBe(1);
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
    const inputs = productionInputs({ rows });

    const first = runHeadless(library, workflowJson, inputs, 'promo-run');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    const costRequest = first.checkpoint.nodes['confirm-cost']?.pendingRequest;
    expect(costRequest?.kind).toBe('confirm-cost');
    expect(count('translate')).toBe(0);

    const second = runHeadless(library, workflowJson, inputs, 'promo-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'confirm-cost': { approved: true, approvalRef: 'cost-ok' } },
      reuseNondeterministic: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('waiting_for_input');
    const request = second.checkpoint.nodes['approve-copy']?.pendingRequest;
    expect(request?.kind).toBe('approve-transcript');
    expect(request?.payload).toMatchObject({ contactSheetRef: 'contact-sheet-1' });
    expect(count('translate')).toBe(0);

    const third = runHeadless(library, workflowJson, inputs, 'promo-run', {
      resumeFromJson: JSON.stringify(second.checkpoint),
      humanInputs: { 'approve-copy': { rows } },
      reuseNondeterministic: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) {
      return;
    }
    expect(third.state).toBe('succeeded');
    expect(third.outputIssues).toEqual([]);
    expect(Object.keys(third.outputs)).toEqual(['manifest']);

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
    expect(count('inspect')).toBe(2);
    expect(count('writeDeliveryManifest')).toBe(2);
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
    const inputs = productionInputs({ selectedMedia: { assetId: 'asset-episode-1' } });

    const first = runHeadless(library, workflowJson, inputs, 'podcast-run-park');
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.state).toBe('waiting_for_input');
    expect(first.checkpoint.nodes['confirm-cost']?.pendingRequest?.kind).toBe('confirm-cost');
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
    const inputs = productionInputs({ selectedMedia: { assetId: 'asset-episode-1' } });

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
        'confirm-cost': { approved: true, approvalRef: 'cost-ok' },
        'confirm-speakers': { speakers },
        'approve-edit-list': { ranges: approvedRanges },
      },
      reuseNondeterministic: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.state).toBe('succeeded');
    expect(second.outputIssues).toEqual([]);
    expect(Object.keys(second.outputs)).toEqual(['manifest']);

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
    expect(count('inspect')).toBe(3);
    expect(count('writeDeliveryManifest')).toBe(3);
    const topLevelManifest = argsOf('writeDeliveryManifest').find(
      (args) => (args as { fileName: string }).fileName === 'podcast-cleanup-run.json',
    ) as { approvals: { speakers: unknown; editList: unknown; chapters: unknown; clips: unknown } };
    expect(topLevelManifest.approvals.speakers).toEqual({ speakers });
    expect(topLevelManifest.approvals.editList).toEqual({ ranges: approvedRanges });
    expect(topLevelManifest.approvals.chapters).toBeDefined();
    expect(topLevelManifest.approvals.clips).toBeDefined();
    // No duplicated completed work across the resume (§36 Phase 7).
    expect(count('detectSpeakers')).toBe(1);
    expect(count('detectSilence')).toBe(1);
    expect(count('denoise')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// New production packs.
// ---------------------------------------------------------------------------

describe('new production pipeline packs', () => {
  it('runs the clean-room reference social cutdown through approval, render, inspect, and manifest', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildReferenceSocialCutdownWorkflow().workflow);
    const references = [
      { referenceId: 'ref-structure-1', note: 'fast cold open, no copied assets' },
    ];
    const inputs = productionInputs({ references });

    const first = runHeadless(library, workflowJson, inputs, 'cutdown-run');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.checkpoint.nodes['confirm-cost']?.pendingRequest?.kind).toBe('confirm-cost');
    expect((argsOf('researchBrief')[0] as { references?: unknown }).references).toEqual(references);

    const second = runHeadless(library, workflowJson, inputs, 'cutdown-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'confirm-cost': { approved: true } },
      reuseNondeterministic: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const request = second.checkpoint.nodes['approve-cutdown']?.pendingRequest;
    expect(request?.kind).toBe('choose-candidates');
    const payload = request?.payload as { candidates: readonly unknown[] };

    const third = runHeadless(library, workflowJson, inputs, 'cutdown-run', {
      resumeFromJson: JSON.stringify(second.checkpoint),
      humanInputs: { 'approve-cutdown': { candidates: payload.candidates.slice(0, 1) } },
      reuseNondeterministic: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.state).toBe('succeeded');
    expect(third.outputIssues).toEqual([]);
    expect(count('commandTransaction')).toBe(1);
    expect(count('inspect')).toBe(1);
    expect(count('writeDeliveryManifest')).toBe(1);
    expect(count('writeMetadata')).toBe(1);
  });

  it('runs the interview/documentary assembly pack with transcript and chapter evidence', () => {
    const { library, count, argsOf } = stubEnvironment();
    const workflowJson = workflowToJson(buildInterviewDocumentaryAssemblyWorkflow().workflow);
    const inputs = productionInputs({ selectedMedia: { assetId: 'interview-roll-1' } });

    const first = runHeadless(library, workflowJson, inputs, 'doc-run');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = runHeadless(library, workflowJson, inputs, 'doc-run', {
      resumeFromJson: JSON.stringify(first.checkpoint),
      humanInputs: { 'confirm-cost': { approved: true } },
      reuseNondeterministic: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const request = second.checkpoint.nodes['approve-assembly']?.pendingRequest;
    expect(request?.kind).toBe('choose-candidates');
    const payload = request?.payload as { candidates: readonly unknown[] };

    const third = runHeadless(library, workflowJson, inputs, 'doc-run', {
      resumeFromJson: JSON.stringify(second.checkpoint),
      humanInputs: { 'approve-assembly': { candidates: payload.candidates.slice(0, 1) } },
      reuseNondeterministic: true,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.state).toBe('succeeded');
    expect(third.outputIssues).toEqual([]);
    expect(count('transcribe')).toBe(1);
    expect(count('generateChapters')).toBe(1);
    expect((argsOf('writeMetadata')[0] as { fileName: string }).fileName).toBe(
      'interview-documentary-assembly-run.json',
    );
  });
});
