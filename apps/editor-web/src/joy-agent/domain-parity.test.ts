import type { CommandTransaction } from '@joy-media/commands';
import { trimCommand } from '@joy-media/timeline-engine';
import {
  canonicalBindingKey,
  textDocumentFromString,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import { type JoyCodePlanOperationV1, validateJoyCodeModelPlan } from '@joy-media/agent-tools';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_POLICY } from '../agent-policy-settings.js';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  compileJoyCodeCompoundDraft,
  type JoyCodeCompoundDraft,
} from '../joy-code-compound-compiler.js';
import { JoyCodeCompoundRunner } from '../joy-code-compound-runner.js';
import { textTemplateById } from '../text-template-catalog.js';
import { prepareTextTemplateInsertion } from '../text-template-transaction.js';
import { audioStateFromProject, prepareTimelinePresentation } from '../timeline-presentation.js';
import { buildTimelineClipMoveTransaction } from '../timeline-clip-interaction.js';
import { PreparedChangeStore, type PreparedChangeAuthority } from './prepared-change-store.js';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function authorityFor(session: EditorSession): PreparedChangeAuthority {
  return {
    projectId: session.timelineProject.id,
    hostRunId: `split-parity-${session.timelineProject.id}`,
    sessionIdentity: session,
    sessionEpoch: 1,
    revision: session.projectRevisionId,
    policy: DEFAULT_AGENT_POLICY,
  };
}

function splitOperation(
  overrides: Partial<Extract<JoyCodePlanOperationV1, { kind: 'timeline.splitClip' }>> = {},
): Extract<JoyCodePlanOperationV1, { kind: 'timeline.splitClip' }> {
  return {
    id: 'split-product',
    dependsOn: [],
    kind: 'timeline.splitClip',
    compositionId: 'root',
    trackId: 'track-0',
    clipId: 'product',
    atUs: 15_000_000,
    ...overrides,
  };
}

function compileSplitDraft(session: EditorSession, planId = 'timeline-split-parity') {
  return compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    operations: [splitOperation()],
  });
}

/** Mirrors App.tsx's manual timeline dispatcher without reaching into React. */
function dispatchManualTimeline(session: EditorSession, timeline: CommandTransaction): void {
  const prepared = prepareTimelinePresentation(
    session.visualProject,
    audioStateFromProject(session.visualProject),
    session.timelineProject,
    timeline,
  );
  if (prepared.project === session.visualProject) session.dispatchTimeline(timeline);
  else session.dispatchCompound(timeline.label, { timeline, document: prepared.project });
}

function approvedDraft(
  draft: JoyCodeCompoundDraft,
  authority: PreparedChangeAuthority,
): {
  readonly store: PreparedChangeStore;
  readonly view: ReturnType<PreparedChangeStore['prepare']>;
  readonly approval: ReturnType<PreparedChangeStore['approve']>;
} {
  const store = new PreparedChangeStore();
  const view = store.prepare(draft, authority);
  return { store, view, approval: store.approve(view.changeSetId, authority) };
}

function clipIds(session: EditorSession): readonly string[] {
  return (
    session.timelineProject.compositions.root?.tracks
      .find((track) => track.id === 'track-0')
      ?.clips.map((clip) => clip.id) ?? []
  );
}

describe('F5 timeline.splitClip vertical parity', () => {
  it('uses the exact manual command path after approval, then survives Undo, Redo, and reload', () => {
    const durableStorage = storage();
    const manualSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const agentSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeTimeline = agentSession.timelineProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileSplitDraft(agentSession);
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.timeline === undefined) return;
    expect(draft.timeline.commands).toHaveLength(1);
    expect(draft.timeline.commands[0]).toMatchObject({
      type: 'timeline.splitClip',
      payload: { clipId: 'product', newClipId: 'timeline-split-parity-split-0' },
    });

    // The human dispatcher receives the compiler's exact canonical command,
    // rather than a separately reconstructed state mutation.
    dispatchManualTimeline(manualSession, draft.timeline);
    const authority = authorityFor(agentSession);
    const prepared = approvedDraft(draft, authority);
    expect(agentSession.timelineProject).toEqual(beforeTimeline);

    const applied = new JoyCodeCompoundRunner().apply(
      agentSession,
      prepared.store,
      prepared.approval,
      authority,
    );
    expect(applied).toMatchObject({ applied: true, replayed: false });
    expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);
    // The operation's visual presentation is identical. `updatedAt` is an
    // intentionally fresh document timestamp for each independently-dispatched
    // transaction, not an operation-specific creative result.
    expect({
      ...agentSession.visualProject,
      updatedAt: manualSession.visualProject.updatedAt,
    }).toEqual(manualSession.visualProject);
    expect(clipIds(agentSession)).toEqual([
      'intro',
      'product',
      'timeline-split-parity-split-0',
      'outro',
    ]);
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    agentSession.redo();
    expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);

    const reopened = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.timelineProject).toEqual(agentSession.timelineProject);
    expect(clipIds(reopened)).toEqual([
      'intro',
      'product',
      'timeline-split-parity-split-0',
      'outro',
    ]);
  });

  it('rejects malformed, stale, and unsupported split requests without creating a durable edit', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const malformed = compileJoyCodeCompoundDraft({
      planId: 'timeline-split-malformed',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      operations: [splitOperation({ atUs: 10_000_000 })],
    });
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', operationId: 'split-product' },
    });

    const unsupported = compileJoyCodeCompoundDraft({
      planId: 'timeline-split-unsupported',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      operations: [
        {
          id: 'unsupported-timeline-action',
          dependsOn: [],
          kind: 'timeline.freezeFrame',
          compositionId: 'root',
          trackId: 'track-0',
          clipId: 'product',
        } as unknown as JoyCodePlanOperationV1,
      ],
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_INVALID_OPERATION' },
    });

    const draft = compileSplitDraft(session, 'timeline-split-stale');
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const authority = authorityFor(session);
    const prepared = approvedDraft(draft, authority);
    const executionId = prepared.store.getApprovedView(prepared.approval, authority).executionId;
    session.renameProjectTitle('Concurrent manual change');
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toThrow('JOY_CODE_STALE_REVISION');
    expect(clipIds(session)).toEqual(['intro', 'product', 'outro']);
    expect(session.agentIdempotency.getExecutionReceipt(executionId)).toBeUndefined();
  });
});

function trimOperation(
  overrides: Partial<Extract<JoyCodePlanOperationV1, { kind: 'timeline.trimClip' }>> = {},
): Extract<JoyCodePlanOperationV1, { kind: 'timeline.trimClip' }> {
  return {
    id: 'trim-product',
    dependsOn: [],
    kind: 'timeline.trimClip',
    compositionId: 'root',
    trackId: 'track-0',
    clipId: 'product',
    newStartUs: 12_000_000,
    newEndUs: 18_000_000,
    ...overrides,
  };
}

function moveOperation(
  overrides: Partial<Extract<JoyCodePlanOperationV1, { kind: 'timeline.moveClip' }>> = {},
): Extract<JoyCodePlanOperationV1, { kind: 'timeline.moveClip' }> {
  return {
    id: 'move-product',
    dependsOn: [],
    kind: 'timeline.moveClip',
    compositionId: 'root',
    sourceTrackId: 'track-0',
    targetTrackId: 'track-0',
    clipId: 'product',
    newStartUs: 15_000_000,
    ...overrides,
  };
}

function compileTimelineEditDraft(
  session: EditorSession,
  planId: string,
  operation: Extract<JoyCodePlanOperationV1, { kind: 'timeline.trimClip' | 'timeline.moveClip' }>,
) {
  return compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    operations: [operation],
  });
}

function manualTrimTransaction(): CommandTransaction {
  return {
    label: 'Trim product',
    commands: [
      trimCommand('root', 'track-0', 'product', 'start', 12_000_000),
      trimCommand('root', 'track-0', 'product', 'end', 18_000_000),
    ],
  };
}

function timelineWithProductGap() {
  const timeline = buildReferenceSpikeProject();
  const root = timeline.compositions.root!;
  return {
    ...timeline,
    compositions: {
      ...timeline.compositions,
      root: {
        ...root,
        tracks: root.tracks.map((track) =>
          track.id === 'track-0'
            ? {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === 'product' ? { ...clip, durationUs: 4_000_000 } : clip,
                ),
              }
            : track,
        ),
      },
    },
  };
}

function manualSameTrackMoveTransaction(session: EditorSession): CommandTransaction {
  const track = session.timelineProject.compositions.root?.tracks.find(
    (candidate) => candidate.id === 'track-0',
  );
  const clip = track?.clips.find((candidate) => candidate.id === 'product');
  if (track === undefined || clip === undefined) throw new Error('fixture move target is missing');
  const transaction = buildTimelineClipMoveTransaction({
    compositionId: 'root',
    sourceTrackId: track.id,
    targetTrackId: track.id,
    clip,
    targetClips: track.clips,
    newStartUs: 15_000_000,
  });
  if (transaction === undefined) throw new Error('fixture move should be non-overlapping');
  return transaction;
}

function expectTimelineAndPresentationParity(
  agentSession: EditorSession,
  manualSession: EditorSession,
): void {
  expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);
  // Each independently-dispatched transaction owns a fresh document timestamp.
  // That timestamp is not a creative timeline result.
  expect({
    ...agentSession.visualProject,
    updatedAt: manualSession.visualProject.updatedAt,
  }).toEqual(manualSession.visualProject);
}

describe('F5 timeline trim and same-track move vertical parity', () => {
  it('stages an inert, opaque-approved trim that shares canonical manual commands and survives Undo, Redo, and reload', () => {
    const durableStorage = storage();
    const manualSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const agentSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeTimeline = agentSession.timelineProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileTimelineEditDraft(agentSession, 'timeline-trim-parity', trimOperation());
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.timeline === undefined) return;
    const manual = manualTrimTransaction();
    expect(draft.timeline.commands).toEqual(manual.commands);

    dispatchManualTimeline(manualSession, manual);
    const authority = authorityFor(agentSession);
    const store = new PreparedChangeStore();
    const view = store.prepare(draft, authority);
    // Staging alone remains inert and the execution handle is opaque to the plan.
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    const approval = store.approve(view.changeSetId, authority);
    expect(agentSession.timelineProject).toEqual(beforeTimeline);

    expect(
      new JoyCodeCompoundRunner().apply(agentSession, store, approval, authority),
    ).toMatchObject({ applied: true, replayed: false });
    expectTimelineAndPresentationParity(agentSession, manualSession);
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    agentSession.redo();
    expectTimelineAndPresentationParity(agentSession, manualSession);

    const reopened = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.timelineProject).toEqual(agentSession.timelineProject);
  });

  it('stages an inert, opaque-approved same-track move that shares the manual command and survives Undo, Redo, and reload', () => {
    const durableStorage = storage();
    const timeline = timelineWithProductGap();
    const manualSession = new EditorSession(storage(), timeline, INITIAL_EDITOR_PROJECT);
    const agentSession = new EditorSession(durableStorage, timeline, INITIAL_EDITOR_PROJECT);
    const beforeTimeline = agentSession.timelineProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileTimelineEditDraft(agentSession, 'timeline-move-parity', moveOperation());
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.timeline === undefined) return;
    const manual = manualSameTrackMoveTransaction(manualSession);
    expect(draft.timeline.commands).toEqual(manual.commands);

    dispatchManualTimeline(manualSession, manual);
    const authority = authorityFor(agentSession);
    const store = new PreparedChangeStore();
    const view = store.prepare(draft, authority);
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    const approval = store.approve(view.changeSetId, authority);
    expect(agentSession.timelineProject).toEqual(beforeTimeline);

    expect(
      new JoyCodeCompoundRunner().apply(agentSession, store, approval, authority),
    ).toMatchObject({ applied: true, replayed: false });
    expectTimelineAndPresentationParity(agentSession, manualSession);
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    agentSession.redo();
    expectTimelineAndPresentationParity(agentSession, manualSession);

    const reopened = new EditorSession(durableStorage, timeline, INITIAL_EDITOR_PROJECT);
    expect(reopened.timelineProject).toEqual(agentSession.timelineProject);
  });

  it('rejects malformed, no-op, cross-project, cross-track, and stale timeline edits without a durable write', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const historyBefore = session.historyEntries.length;
    const noOp = compileTimelineEditDraft(
      session,
      'timeline-trim-no-op',
      trimOperation({ newStartUs: 10_000_000, newEndUs: 20_000_000 }),
    );
    expect(noOp).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', operationId: 'trim-product' },
    });

    const malformed = compileTimelineEditDraft(
      session,
      'timeline-trim-malformed',
      trimOperation({ newStartUs: Number.NaN }),
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', operationId: 'trim-product' },
    });

    const crossProject = compileTimelineEditDraft(
      session,
      'timeline-trim-cross-project',
      trimOperation({ compositionId: 'other-project-root' }),
    );
    expect(crossProject).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', operationId: 'trim-product' },
    });

    const crossTrackSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const crossTrack = compileTimelineEditDraft(
      crossTrackSession,
      'timeline-move-cross-track',
      moveOperation({ targetTrackId: 'track-1' }),
    );
    expect(crossTrack).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TIMELINE_COMMAND_REJECTED', operationId: 'move-product' },
    });
    expect(session.historyEntries).toHaveLength(historyBefore);

    const staleDraft = compileTimelineEditDraft(session, 'timeline-trim-stale', trimOperation());
    expect(staleDraft.ok).toBe(true);
    if (!staleDraft.ok) return;
    const authority = authorityFor(session);
    const prepared = approvedDraft(staleDraft, authority);
    const executionId = prepared.store.getApprovedView(prepared.approval, authority).executionId;
    session.renameProjectTitle('Concurrent manual change');
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toThrow('JOY_CODE_STALE_REVISION');
    expect(session.agentIdempotency.getExecutionReceipt(executionId)).toBeUndefined();
    expect(session.historyEntries).toHaveLength(historyBefore);
  });
});

const TITLE_TEMPLATE_ID = 'clean-title';
const TITLE_CONTENT = 'Make it visible';
const TITLE_START_US = 2_000_000;
const TITLE_DURATION_US = 3_000_000;
const TITLE_OPACITY_KEY_US = 2_750_000;
const TITLE_OPACITY_VALUE = 0.35;

function titleObjectId(planId: string): string {
  // The source operations intentionally place the title second, so the shared
  // output-reference resolver owns input index 1 for this generated object.
  return `text-${TITLE_TEMPLATE_ID}-${planId}-1`;
}

function titleAndOpacityOperations(
  overrides: Partial<Extract<JoyCodePlanOperationV1, { kind: 'motion.setKeyframe' }>> = {},
): readonly JoyCodePlanOperationV1[] {
  const createTitle: Extract<JoyCodePlanOperationV1, { kind: 'text.insertTemplate' }> = {
    id: 'create-title',
    dependsOn: [],
    kind: 'text.insertTemplate',
    templateId: TITLE_TEMPLATE_ID,
    content: TITLE_CONTENT,
    startUs: TITLE_START_US,
    durationUs: TITLE_DURATION_US,
    placementPreset: 'center',
    outputRef: { kind: 'visual-object', ref: 'headline' },
  };
  const keyOpacity: Extract<JoyCodePlanOperationV1, { kind: 'motion.setKeyframe' }> = {
    id: 'key-title-opacity',
    dependsOn: ['create-title'],
    kind: 'motion.setKeyframe',
    binding: {
      ownerKind: 'visual-object',
      ownerRef: { kind: 'visual-object', ref: 'headline' },
      propertyId: 'opacity',
      timeDomain: 'composition',
    },
    key: {
      kind: 'scalar',
      timeUs: TITLE_OPACITY_KEY_US,
      value: TITLE_OPACITY_VALUE,
      interpolation: 'linear',
    },
    ...overrides,
  };
  // Deliberately reverse the transport order. Dependency resolution must still
  // produce the title before it resolves the typed keyframe binding.
  return [keyOpacity, createTitle];
}

function compileTitleOpacityDraft(session: EditorSession, planId = 'title-opacity-parity') {
  return compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    operations: titleAndOpacityOperations(),
  });
}

/**
 * The human side uses the same text-template preparation and typed property
 * transaction primitives as the compiler, without invoking the agent runner.
 */
function dispatchManualTitleOpacity(session: EditorSession, planId: string): void {
  const template = textTemplateById(TITLE_TEMPLATE_ID);
  if (template === undefined) throw new Error('fixture title template is missing');
  const prepared = prepareTextTemplateInsertion(
    session.timelineProject,
    session.visualProject,
    template,
    TITLE_START_US,
    `${planId}-1`,
    TITLE_DURATION_US,
    'center',
  );
  if (prepared === undefined) throw new Error('fixture title placement is unavailable');
  const objectId = titleObjectId(planId);
  const title = prepared.document.visualObjects[objectId];
  if (title === undefined || title.kind !== 'text')
    throw new Error('fixture title object is missing');
  session.dispatchCompound(prepared.label, {
    timeline: prepared.timeline,
    document: {
      ...prepared.document,
      visualObjects: {
        ...prepared.document.visualObjects,
        [objectId]: {
          ...title,
          text: TITLE_CONTENT,
          textDocument: textDocumentFromString(TITLE_CONTENT, `${objectId}-block`),
        },
      },
    },
  });
  const binding = {
    ownerKind: 'visual-object' as const,
    ownerId: objectId,
    propertyId: 'opacity',
    timeDomain: 'composition' as const,
  };
  const keyframe: VisualObjectTransaction = {
    label: 'Keyframe title opacity',
    commands: [
      {
        type: 'propertyAnimation.replace',
        payload: {
          binding,
          value: {
            kind: 'scalar',
            curve: {
              keyframes: [
                {
                  timeUs: TITLE_OPACITY_KEY_US,
                  value: TITLE_OPACITY_VALUE,
                  interpolation: 'linear',
                },
              ],
            },
          },
        },
      },
    ],
  };
  session.dispatchVisualObjects(keyframe);
}

describe('F5 text title + opacity keyframe vertical parity', () => {
  it('stages a typed created-title keyframe, then commits the same canonical state as the manual path', () => {
    const durableStorage = storage();
    const manualSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const agentSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const beforeTimeline = agentSession.timelineProject;
    const beforeDocument = agentSession.visualProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileTitleOpacityDraft(agentSession);
    expect(draft.ok).toBe(true);
    if (!draft.ok || draft.timeline === undefined) return;

    const titleId = titleObjectId('title-opacity-parity');
    const binding = {
      ownerKind: 'visual-object' as const,
      ownerId: titleId,
      propertyId: 'opacity',
      timeDomain: 'composition' as const,
    };
    expect(draft.groups.map((group) => group.kind)).toEqual(['text', 'motion']);
    expect(draft.document.visualObjects[titleId]).toMatchObject({
      id: titleId,
      kind: 'text',
      text: TITLE_CONTENT,
      textDocument: {
        version: 1,
        blocks: [{ id: `${titleId}-block`, runs: [{ text: TITLE_CONTENT }] }],
      },
    });
    expect(draft.document.propertyAnimations?.[canonicalBindingKey(binding)]).toEqual({
      binding,
      value: {
        kind: 'scalar',
        curve: {
          keyframes: [
            {
              timeUs: TITLE_OPACITY_KEY_US,
              value: TITLE_OPACITY_VALUE,
              interpolation: 'linear',
            },
          ],
        },
      },
    });

    dispatchManualTitleOpacity(manualSession, draft.planId);
    const authority = authorityFor(agentSession);
    const store = new PreparedChangeStore();
    const view = store.prepare(draft, authority);
    const preview = store.getPreviewDraft(view.changeSetId);
    expect(preview?.document).toEqual(draft.document);
    expect(preview?.timeline).toEqual(draft.timeline);
    // Staging a proposal is inert. The exact payload only becomes executable
    // after this local, opaque approval handle is issued.
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    expect(agentSession.visualProject).toEqual(beforeDocument);
    const approval = store.approve(view.changeSetId, authority);

    const applied = new JoyCodeCompoundRunner().apply(agentSession, store, approval, authority);
    expect(applied).toMatchObject({ applied: true, replayed: false });
    expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);
    // `visualProject.updatedAt` is a per-transaction document timestamp
    // refreshed independently by each manual and agent dispatch, so compare
    // creative/document state while normalizing only that metadata field.
    expect({
      ...agentSession.visualProject,
      updatedAt: manualSession.visualProject.updatedAt,
    }).toEqual(manualSession.visualProject);
    expect(agentSession.visualProject.visualObjects[titleId]).toEqual(
      draft.document.visualObjects[titleId],
    );
    expect(agentSession.visualProject.propertyAnimations?.[canonicalBindingKey(binding)]).toEqual(
      draft.document.propertyAnimations?.[canonicalBindingKey(binding)],
    );
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    expect(agentSession.visualProject).toEqual(beforeDocument);
    agentSession.redo();
    expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);
    expect({
      ...agentSession.visualProject,
      updatedAt: manualSession.visualProject.updatedAt,
    }).toEqual(manualSession.visualProject);

    const reopened = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    expect(reopened.timelineProject).toEqual(agentSession.timelineProject);
    expect({
      ...reopened.visualProject,
      updatedAt: agentSession.visualProject.updatedAt,
    }).toEqual(agentSession.visualProject);
    expect(reopened.visualProject.propertyAnimations?.[canonicalBindingKey(binding)]).toEqual(
      draft.document.propertyAnimations?.[canonicalBindingKey(binding)],
    );
  });

  it('rejects malformed, unsupported, and stale title-keyframe requests without applying a title or key', () => {
    const session = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      INITIAL_EDITOR_PROJECT,
    );
    const malformed = validateJoyCodeModelPlan(
      {
        schemaVersion: 1,
        goal: 'Animate the title',
        summary: 'Create a title and key opacity',
        operations: [
          {
            id: 'key-title-opacity',
            dependsOn: ['create-title'],
            kind: 'motion.setKeyframe',
            binding: {
              ownerKind: 'visual-object',
              ownerRef: { kind: 'visual-object', ref: 'headline' },
              propertyId: 'opacity',
              timeDomain: 'composition',
            },
            key: {
              kind: 'scalar',
              timeUs: TITLE_OPACITY_KEY_US,
              value: Number.NaN,
              interpolation: 'linear',
            },
          },
          {
            id: 'create-title',
            dependsOn: [],
            kind: 'text.insertTemplate',
            templateId: TITLE_TEMPLATE_ID,
            content: TITLE_CONTENT,
            startUs: TITLE_START_US,
            durationUs: TITLE_DURATION_US,
            placementPreset: 'center',
            outputRef: { kind: 'visual-object', ref: 'headline' },
          },
        ],
        assumptions: [],
        blockedBy: [],
        requiresHumanDecision: [],
      },
      { textTemplateIds: ['clean-title'], captionTemplateIds: [], transitionIds: [] },
    );
    expect(malformed).toMatchObject({ valid: false });
    expect(malformed.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-keyframe-value' }),
    );

    const unsupported = compileJoyCodeCompoundDraft({
      planId: 'title-opacity-unsupported',
      baseRevision: session.projectRevisionId,
      timeline: session.timelineProject,
      visualProject: session.visualProject,
      operations: titleAndOpacityOperations({
        binding: {
          ownerKind: 'visual-object',
          ownerRef: { kind: 'visual-object', ref: 'headline' },
          propertyId: 'fontSizePx',
          timeDomain: 'composition',
        },
      }),
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_MOTION_KEYFRAME_REJECTED', operationId: 'key-title-opacity' },
    });
    expect(
      session.visualProject.visualObjects[titleObjectId('title-opacity-unsupported')],
    ).toBeUndefined();
    expect(session.visualProject.propertyAnimations).toBeUndefined();

    const draft = compileTitleOpacityDraft(session, 'title-opacity-stale');
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const authority = authorityFor(session);
    const prepared = approvedDraft(draft, authority);
    const executionId = prepared.store.getApprovedView(prepared.approval, authority).executionId;
    session.renameProjectTitle('Concurrent manual change');
    expect(() =>
      new JoyCodeCompoundRunner().apply(session, prepared.store, prepared.approval, authority),
    ).toThrow('JOY_CODE_STALE_REVISION');
    expect(
      session.visualProject.visualObjects[titleObjectId('title-opacity-stale')],
    ).toBeUndefined();
    expect(session.visualProject.propertyAnimations).toBeUndefined();
    expect(session.agentIdempotency.getExecutionReceipt(executionId)).toBeUndefined();
  });
});

const TRANSITION_DURATION_US = 400_000;

/**
 * The visual document owns transition state. Keep this fixture's video track
 * structurally identical to the editor's canonical timeline fixture so the
 * real transition compiler can validate its junction without a test-only
 * shortcut or synthetic renderer state.
 */
function visualProjectWithReferenceTransitionJunction(): JoyProjectV1 {
  const timeline = buildReferenceSpikeProject();
  const videoTrack = timeline.compositions.root?.tracks.find(
    (candidate) => candidate.id === 'track-0',
  );
  const root = INITIAL_EDITOR_PROJECT.compositions.root;
  if (videoTrack === undefined || videoTrack.kind !== 'video' || root === undefined)
    throw new Error('transition parity fixture is missing a root video track');
  return {
    ...INITIAL_EDITOR_PROJECT,
    compositions: {
      ...INITIAL_EDITOR_PROJECT.compositions,
      root: {
        ...root,
        tracks: [
          ...root.tracks,
          {
            id: videoTrack.id,
            kind: 'video',
            name: 'Primary video',
            order: videoTrack.order,
            enabled: videoTrack.enabled,
            locked: false,
            clips: videoTrack.clips,
          },
        ],
      },
    },
  };
}

function visualProjectWithExistingDissolve(): JoyProjectV1 {
  return {
    ...visualProjectWithReferenceTransitionJunction(),
    transitions: [
      {
        id: 'existing-dissolve',
        trackId: 'track-0',
        leftClipId: 'intro',
        rightClipId: 'product',
        type: 'dissolve',
        durationUs: TRANSITION_DURATION_US,
      },
    ],
  };
}

function transitionAddOperation(
  overrides: Partial<Extract<JoyCodePlanOperationV1, { kind: 'transition.addAtJunction' }>> = {},
): Extract<JoyCodePlanOperationV1, { kind: 'transition.addAtJunction' }> {
  return {
    id: 'add-dissolve',
    dependsOn: [],
    kind: 'transition.addAtJunction',
    outgoingClipId: 'intro',
    incomingClipId: 'product',
    transitionId: 'dissolve',
    durationUs: TRANSITION_DURATION_US,
    ...overrides,
  };
}

function transitionRemoveOperation(
  transitionId: string,
): Extract<JoyCodePlanOperationV1, { kind: 'transition.remove' }> {
  return {
    id: 'remove-dissolve',
    dependsOn: [],
    kind: 'transition.remove',
    transitionId,
  };
}

function compileTransitionAddDraft(
  session: EditorSession,
  planId = 'transition-add-parity',
  operation = transitionAddOperation(),
) {
  return compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    operations: [operation],
  });
}

function compileTransitionRemoveDraft(
  session: EditorSession,
  transitionId: string,
  planId = 'transition-remove-parity',
) {
  return compileJoyCodeCompoundDraft({
    planId,
    baseRevision: session.projectRevisionId,
    timeline: session.timelineProject,
    visualProject: session.visualProject,
    operations: [transitionRemoveOperation(transitionId)],
  });
}

/** Mirrors the established Transitions panel's visual-document snapshot path. */
function dispatchManualTransition(
  session: EditorSession,
  transition: NonNullable<JoyProjectV1['transitions']>[number],
): void {
  session.replaceVisualProject({
    ...session.visualProject,
    transitions: [...(session.visualProject.transitions ?? []), transition],
  });
}

function dispatchManualTransitionRemoval(session: EditorSession, transitionId: string): void {
  session.replaceVisualProject({
    ...session.visualProject,
    transitions: (session.visualProject.transitions ?? []).filter(
      (transition) => transition.id !== transitionId,
    ),
  });
}

describe('F5 transition add/remove vertical parity', () => {
  it('stages a curated transition, requires approval, then commits the same visual document as the manual path', () => {
    const durableStorage = storage();
    const manualSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      visualProjectWithReferenceTransitionJunction(),
    );
    const agentSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      visualProjectWithReferenceTransitionJunction(),
    );
    const beforeTimeline = agentSession.timelineProject;
    const beforeDocument = agentSession.visualProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileTransitionAddDraft(agentSession);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.timeline).toBeUndefined();
    expect(draft.groups).toEqual([
      {
        kind: 'transition',
        operationId: 'add-dissolve',
        summary: 'Add dissolve transition',
        affectedIds: ['transition-transition-add-parity-0', 'intro', 'product'],
      },
    ]);
    const transition = draft.document.transitions?.[0];
    if (transition === undefined) throw new Error('compiled transition is missing');
    expect(transition).toEqual({
      id: 'transition-transition-add-parity-0',
      trackId: 'track-0',
      leftClipId: 'intro',
      rightClipId: 'product',
      type: 'dissolve',
      durationUs: TRANSITION_DURATION_US,
    });

    // This is the same snapshot-based document commit the visible Transitions
    // panel uses. The deterministic id comes from the approved compiler so
    // state parity can compare the result rather than a UI clock value.
    dispatchManualTransition(manualSession, transition);
    const authority = authorityFor(agentSession);
    const prepared = approvedDraft(draft, authority);
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    expect(agentSession.visualProject).toEqual(beforeDocument);
    expect(prepared.store.getPreviewDraft(prepared.view.changeSetId)?.document).toEqual(
      draft.document,
    );

    const applied = new JoyCodeCompoundRunner().apply(
      agentSession,
      prepared.store,
      prepared.approval,
      authority,
    );
    expect(applied).toMatchObject({ applied: true, replayed: false });
    expect(agentSession.timelineProject).toEqual(manualSession.timelineProject);
    expect(agentSession.visualProject).toEqual(manualSession.visualProject);
    expect(agentSession.visualProject.transitions).toEqual([transition]);
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.timelineProject).toEqual(beforeTimeline);
    expect(agentSession.visualProject).toEqual(beforeDocument);
    agentSession.redo();
    expect(agentSession.visualProject).toEqual(manualSession.visualProject);

    const reopened = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      visualProjectWithReferenceTransitionJunction(),
    );
    expect(reopened.timelineProject).toEqual(agentSession.timelineProject);
    expect(reopened.visualProject).toEqual(agentSession.visualProject);
    expect(reopened.visualProject.transitions).toEqual([transition]);
  });

  it('validates and removes one existing transition through the same approved manual snapshot path', () => {
    const validated = validateJoyCodeModelPlan(
      {
        schemaVersion: 1,
        goal: 'Remove the first dissolve',
        summary: 'Clear the existing transition without changing its clips',
        operations: [transitionRemoveOperation('existing-dissolve')],
        assumptions: [],
        blockedBy: [],
        requiresHumanDecision: [],
      },
      { textTemplateIds: [], captionTemplateIds: [], transitionIds: [] },
    );
    expect(validated).toMatchObject({ valid: true, errors: [] });
    if (!validated.valid) return;
    expect(validated.value.operations).toEqual([transitionRemoveOperation('existing-dissolve')]);

    const durableStorage = storage();
    const manualSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      visualProjectWithExistingDissolve(),
    );
    const agentSession = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      visualProjectWithExistingDissolve(),
    );
    const beforeDocument = agentSession.visualProject;
    const historyBefore = agentSession.historyEntries.length;
    const draft = compileTransitionRemoveDraft(agentSession, 'existing-dissolve');
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.groups).toEqual([
      {
        kind: 'transition',
        operationId: 'remove-dissolve',
        summary: 'Remove transition existing-dissolve',
        affectedIds: ['existing-dissolve'],
      },
    ]);
    expect(draft.document.transitions).toEqual([]);

    dispatchManualTransitionRemoval(manualSession, 'existing-dissolve');
    const authority = authorityFor(agentSession);
    const prepared = approvedDraft(draft, authority);
    expect(agentSession.visualProject).toEqual(beforeDocument);
    expect(prepared.store.getPreviewDraft(prepared.view.changeSetId)?.document).toEqual(
      draft.document,
    );

    const applied = new JoyCodeCompoundRunner().apply(
      agentSession,
      prepared.store,
      prepared.approval,
      authority,
    );
    expect(applied).toMatchObject({ applied: true, replayed: false });
    expect(agentSession.visualProject).toEqual(manualSession.visualProject);
    expect(agentSession.visualProject.transitions).toEqual([]);
    expect(agentSession.historyEntries).toHaveLength(historyBefore + 1);

    agentSession.undo();
    expect(agentSession.visualProject).toEqual(beforeDocument);
    agentSession.redo();
    expect(agentSession.visualProject).toEqual(manualSession.visualProject);

    const reopened = new EditorSession(
      durableStorage,
      buildReferenceSpikeProject(),
      visualProjectWithExistingDissolve(),
    );
    expect(reopened.visualProject).toEqual(agentSession.visualProject);
    expect(reopened.visualProject.transitions).toEqual([]);
  });

  it('rejects malformed, duplicate/no-op, and stale transition additions without committing an edit', () => {
    const malformed = validateJoyCodeModelPlan(
      {
        schemaVersion: 1,
        goal: 'Blend clips',
        summary: 'Add a dissolve at the first junction',
        operations: [
          {
            ...transitionAddOperation(),
            durationUs: '400000',
          },
        ],
        assumptions: [],
        blockedBy: [],
        requiresHumanDecision: [],
      },
      { textTemplateIds: [], captionTemplateIds: [], transitionIds: ['dissolve'] },
    );
    expect(malformed).toMatchObject({ valid: false });
    expect(malformed.errors).toContainEqual(
      expect.objectContaining({ path: 'operations[0].durationUs' }),
    );

    const malformedSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      visualProjectWithReferenceTransitionJunction(),
    );
    const unsafeDuration = compileTransitionAddDraft(
      malformedSession,
      'transition-add-unsafe-duration',
      transitionAddOperation({ durationUs: 99_999 }),
    );
    expect(unsafeDuration).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TRANSITION_DURATION_INVALID' },
    });
    expect(malformedSession.visualProject.transitions).toBeUndefined();
    expect(malformedSession.historyEntries).toHaveLength(1);

    const existingDraft = compileTransitionAddDraft(malformedSession, 'transition-add-existing');
    expect(existingDraft.ok).toBe(true);
    if (!existingDraft.ok) return;
    const existingTransition = existingDraft.document.transitions?.[0];
    if (existingTransition === undefined) throw new Error('existing transition fixture is missing');
    dispatchManualTransition(malformedSession, existingTransition);
    const duplicate = compileTransitionAddDraft(malformedSession, 'transition-add-duplicate');
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: 'JOY_CODE_TRANSITION_DUPLICATE' },
    });
    expect(malformedSession.visualProject.transitions).toEqual([existingTransition]);
    expect(malformedSession.historyEntries).toHaveLength(2);

    const staleSession = new EditorSession(
      storage(),
      buildReferenceSpikeProject(),
      visualProjectWithReferenceTransitionJunction(),
    );
    const staleDraft = compileTransitionAddDraft(staleSession, 'transition-add-stale');
    expect(staleDraft.ok).toBe(true);
    if (!staleDraft.ok) return;
    const authority = authorityFor(staleSession);
    const prepared = approvedDraft(staleDraft, authority);
    const executionId = prepared.store.getApprovedView(prepared.approval, authority).executionId;
    staleSession.renameProjectTitle('Concurrent manual change');
    expect(() =>
      new JoyCodeCompoundRunner().apply(staleSession, prepared.store, prepared.approval, authority),
    ).toThrow('JOY_CODE_STALE_REVISION');
    expect(staleSession.visualProject.transitions).toBeUndefined();
    expect(staleSession.agentIdempotency.getExecutionReceipt(executionId)).toBeUndefined();
  });
});
