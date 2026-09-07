/**
 * The concrete `CreativeSkillEditorPrimitiveDeps` wired from the editor
 * (`App.tsx`) object graph. Every model-reaching call goes through the same
 * single built-in Worker, canonical staging handler, prepared-change store,
 * preview store, and observation bridge the direct editor path uses.
 *
 * Per-run state (the observation bridge instance and its completed manifest id)
 * is held in a small map keyed by `scope.runId` so `runScopedToolLoop` and
 * `readObservationCoverage` share exactly one bounded observation pass.
 */

import { validateSpikeProject } from '@joy-media/project-schema';
import type { AgentPreviewStore } from '../agent-preview-store.js';
import { isAgentPreviewBundleReady } from '../agent-preview-store.js';
import type { EditorSession } from '../editor-session.js';
import type { JoyAgentTarget } from '../agent-presence.js';
import type { JoyAgentContextSnapshotInput } from './context-snapshot.js';
import type { JoyAgentEngineClient } from './engine-client.js';
import type { JoyAgentObservationHostBridge } from './observation-tool-adapter.js';
import type { JoyAgentObservationAdapterFactory } from './observation-host-factory.js';
import type { JoyAgentObservationToolAuthority } from './tool-bridge.js';
import type { PreparedChangeAuthority, PreparedChangeStore } from './prepared-change-store.js';
import type { CreativeSkillRunScope } from './skill-runner.js';
import { createDirectorVerificationReport } from './director-verifier.js';
import type { CreativeSkillEditorPrimitiveDeps } from './creative-skill-editor-primitives.js';
import {
  runScopedCreativeSkillEditToolLoop,
  type RecipeScopedEditRunDeps,
} from './recipe-scoped-host.js';

export interface CreativeSkillEditorAppGraph {
  readonly client: JoyAgentEngineClient;
  /** The session captured when a recipe run starts. */
  readonly getSession: () => EditorSession;
  /** Live session ref, re-read on every host authority check. */
  readonly latestSessionRef: { readonly current: EditorSession };
  readonly preparedChanges: PreparedChangeStore;
  readonly agentPreviewStore: AgentPreviewStore | undefined;
  readonly proposalTargetsRef: { readonly current: Map<string, readonly JoyAgentTarget[]> };
  readonly buildContextInput: (scope: CreativeSkillRunScope) => JoyAgentContextSnapshotInput;
  readonly currentPreparedAuthority: (hostRunId: string) => PreparedChangeAuthority;
  readonly isAuthorityCurrent: (scope: CreativeSkillRunScope) => boolean;
  /**
   * App-owned observation adapter factory. When present, recipes that need
   * bounded source evidence get an isolated bridge fenced to their Worker run;
   * when absent, those recipes honestly report no bounded source evidence.
   */
  readonly observationAdapterFactory?: JoyAgentObservationAdapterFactory;
  /** Live BYOK model id (observation authority is void without one). */
  readonly getModelId?: () => string | undefined;
  /** Live prompt-policy digest for the observation authority fence. */
  readonly getPromptPolicyDigest?: () => string;
  /** Bounded wait for the renderer to acknowledge a staged preview. */
  readonly previewAckTimeoutMs?: number;
}

interface RunObservationState {
  bridge: JoyAgentObservationHostBridge | undefined;
  manifestId: string | undefined;
}

function summarizeSession(session: EditorSession): string {
  const timeline = session.timelineProject;
  const composition = timeline.compositions[timeline.rootCompositionId];
  const trackCount = composition?.tracks.length ?? 0;
  const clipCount =
    composition?.tracks.reduce((total, track) => total + track.clips.length, 0) ?? 0;
  const assetCount = Object.keys(session.visualProject.assets).length;
  const objectCount = Object.keys(session.visualProject.visualObjects).length;
  return (
    `Project revision ${session.projectRevisionId}: ${trackCount} track${trackCount === 1 ? '' : 's'}, ` +
    `${clipCount} clip${clipCount === 1 ? '' : 's'}, ${assetCount} asset${assetCount === 1 ? '' : 's'}, ` +
    `${objectCount} visual object${objectCount === 1 ? '' : 's'}.`
  );
}

async function waitForPreviewAck(
  store: AgentPreviewStore,
  planId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  const ready = (): boolean => {
    const bundle = store.getBundle();
    return bundle?.runId === planId && isAgentPreviewBundleReady(bundle);
  };
  if (ready()) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(ready()), Math.max(0, timeoutMs));
    const onAbort = (): void => finish(false);
    const unsubscribe = store.subscribe(() => {
      if (ready()) finish(true);
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Build the concrete deps. Call once per editor `App.tsx` mount; every recipe
 * run reuses it and is isolated by its `scope.runId`.
 */
export function createCreativeSkillEditorPrimitiveDeps(
  graph: CreativeSkillEditorAppGraph,
): CreativeSkillEditorPrimitiveDeps {
  const runs = new Map<string, RunObservationState>();
  const previewAckTimeoutMs = graph.previewAckTimeoutMs ?? 8_000;

  const stateFor = (runId: string): RunObservationState => {
    let state = runs.get(runId);
    if (state === undefined) {
      state = { bridge: undefined, manifestId: undefined };
      runs.set(runId, state);
    }
    return state;
  };

  const recipeDeps: RecipeScopedEditRunDeps = {
    client: graph.client,
    getSession: graph.getSession,
    latestSessionRef: graph.latestSessionRef,
    preparedChanges: graph.preparedChanges,
    agentPreviewStore: graph.agentPreviewStore,
    proposalTargetsRef: graph.proposalTargetsRef,
    buildContextInput: graph.buildContextInput,
    currentPreparedAuthority: graph.currentPreparedAuthority,
    isAuthorityCurrent: graph.isAuthorityCurrent,
    ...(graph.observationAdapterFactory === undefined
      ? {}
      : { observationAdapterFactory: graph.observationAdapterFactory }),
    ...(graph.getModelId === undefined ? {} : { getModelId: graph.getModelId }),
    ...(graph.getPromptPolicyDigest === undefined
      ? {}
      : { getPromptPolicyDigest: graph.getPromptPolicyDigest }),
    onObservationBridgeCreated: (scope, bridge) => {
      stateFor(scope.runId).bridge = bridge;
    },
    onObservationCompleted: (scope, result) => {
      stateFor(scope.runId).manifestId = result.manifestId;
    },
  };

  return {
    async readProjectContext() {
      return { summary: summarizeSession(graph.getSession()) };
    },

    runScopedToolLoop(input) {
      return runScopedCreativeSkillEditToolLoop(recipeDeps, input);
    },

    async readObservationCoverage({ scope, signal }) {
      const state = runs.get(scope.runId);
      if (state?.bridge === undefined || state.manifestId === undefined) {
        return {
          coverageSummary: 'No bounded source evidence was requested for this recipe.',
          coverageComplete: false,
          evidenceIds: [],
        };
      }
      const authority: JoyAgentObservationToolAuthority = {
        projectId: scope.projectId,
        revision: scope.revision,
        run: { runId: scope.runId, epoch: scope.epoch },
      };
      const coverage = await state.bridge.tools.coverage(
        { manifestId: state.manifestId },
        authority,
        signal,
      );
      const complete = coverage.status === 'complete' && coverage.exhaustiveInput;
      return {
        coverageSummary:
          `Reviewed ${coverage.reviewedFrameCount} of ${coverage.intendedFrameCount} intended ` +
          `frame${coverage.intendedFrameCount === 1 ? '' : 's'} ` +
          `(${coverage.exhaustiveInput ? 'exhaustive' : 'sampled'} input, status ${coverage.status}).`,
        coverageComplete: complete,
        evidenceIds: [state.manifestId],
        uncertainty:
          'Model comprehension of the reviewed evidence is not guaranteed; only the sampled frames were inspected.',
      };
    },

    async confirmPreviewRendered({ changeSetId, signal }) {
      const prepared = graph.preparedChanges.getView(changeSetId);
      const store = graph.agentPreviewStore;
      if (prepared === undefined || store === undefined) {
        return { previewId: changeSetId, rendererAcknowledged: false };
      }
      const acknowledged = await waitForPreviewAck(
        store,
        prepared.planId,
        signal,
        previewAckTimeoutMs,
      );
      return { previewId: prepared.planId, rendererAcknowledged: acknowledged };
    },

    async verifyComposedAndEncoded({ scope }) {
      // R1 keeps the recipe path honest: the project schema validator is a real
      // structural check, but the O6 composition + encoded-output decoders are
      // not yet wired as per-recipe verification consumers (coverage-ledger
      // open item #3).
      const diagnostics = validateSpikeProject(graph.getSession().timelineProject);
      const structural =
        diagnostics.length === 0
          ? ({
              id: 'structural-schema',
              method: 'structural' as const,
              status: 'passed' as const,
              evidenceIds: [`project-schema:${scope.revision}`],
              summary: 'Project schema validation reported no diagnostics.',
            } as const)
          : ({
              id: 'structural-schema',
              method: 'structural' as const,
              status: 'failed' as const,
              evidenceIds: [`project-schema:${scope.revision}`],
              summary: `Project schema validation reported ${diagnostics.length} diagnostic${
                diagnostics.length === 1 ? '' : 's'
              }.`,
            } as const);
      const report = createDirectorVerificationReport({
        projectId: scope.projectId,
        revision: scope.revision,
        checks: [
          structural,
          {
            id: 'rendered-unavailable',
            method: 'rendered',
            status: 'unavailable',
            evidenceIds: [],
            summary: 'Composed-frame verification is not wired into the recipe path in R1.',
            uncertainty: 'No rendered evidence was captured for this deliverable.',
          },
          {
            id: 'audio-unavailable',
            method: 'audio-measured',
            status: 'unavailable',
            evidenceIds: [],
            summary: 'Audio measurement is not wired into the recipe path in R1.',
            uncertainty: 'No measured audio evidence was captured for this deliverable.',
          },
          {
            id: 'encoded-unavailable',
            method: 'encoded-output',
            status: 'unavailable',
            evidenceIds: [],
            summary: 'Final encoded-output decoding is not wired into the recipe path in R1.',
            uncertainty: 'No encoded-output evidence was captured for this deliverable.',
          },
        ],
      });
      return {
        report,
        summary:
          diagnostics.length === 0
            ? 'Project schema is valid. Rendered, audio, and encoded-output checks are unavailable in R1.'
            : `Project schema reported ${diagnostics.length} diagnostic${
                diagnostics.length === 1 ? '' : 's'
              }. Rendered, audio, and encoded-output checks are unavailable in R1.`,
      };
    },
  };
}
