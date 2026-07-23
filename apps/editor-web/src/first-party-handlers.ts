// apps/editor-web/src/first-party-handlers.ts

import type { NodeHandler, NodeExecutionContext, NodeResult, HumanInputRequest } from '@joy-media/workflow-engine';

/**
 * Stub handlers for first-party workflow node types.
 * These are minimal implementations that allow the workflow to run and
 * demonstrate the approval/parking mechanism without real providers.
 * Real implementations will replace these in future work packages.
 */

// Human input request handler - parks the workflow waiting for user input
export interface HumanInputResponse {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

// Store for pending human input requests (in-memory, per workflow run)
const pendingHumanInputs = new Map<string, { resolve: (response: HumanInputResponse) => void }>();

function createHumanInputHandler(): NodeHandler {
  return (context: NodeExecutionContext): NodeResult => {
    const { kind, prompt, payloadFrom } = context.node.params as {
      kind: string;
      prompt: string;
      payloadFrom: unknown;
    };

    // Create a request ID for this human input
    const requestId = `human-input-${context.runId}-${context.nodeId}-${Date.now()}`;

    // Return a waiting result that signals the runtime to park
    return {
      waiting: true,
      request: {
        kind,
        prompt,
        payload: payloadFrom,
      },
    };
  };
}

/**
 * Resume a workflow that was parked waiting for human input.
 * Called from the UI when the user submits their response.
 */
export function resumeHumanInput(requestId: string, response: HumanInputResponse): boolean {
  const pending = pendingHumanInputs.get(requestId);
  if (!pending) return false;

  pending.resolve(response);
  pendingHumanInputs.delete(requestId);
  return true;
}

// Create a simple stub handler
function createStubHandler(output: unknown): NodeHandler {
  return (): NodeResult => ({ ok: true, output });
}

// Stub handlers for various node types
export const firstPartyHandlers: Readonly<Record<string, NodeHandler>> = {
  // Input/ingest nodes
  'input.item': createStubHandler({ item: 'input-item', __stub: true }),

  // Analysis nodes
  'analysis.transcribe': createStubHandler({ transcript: 'Stub transcript', __stub: true }),

  'analysis.hooks': createStubHandler({
    candidates: [
      { id: 'hook-1', subjectHints: 'Hook 1', startUs: 0, durationUs: 15_000_000 },
      { id: 'hook-2', subjectHints: 'Hook 2', startUs: 30_000_000, durationUs: 15_000_000 },
      { id: 'hook-3', subjectHints: 'Hook 3', startUs: 60_000_000, durationUs: 15_000_000 },
    ],
    __stub: true,
  }),

  'analysis.speakers': createStubHandler({ speakers: ['Speaker 1', 'Speaker 2'], __stub: true }),

  'analysis.silence': createStubHandler({ ranges: [{ startUs: 10_000_000, endUs: 12_000_000 }], __stub: true }),

  'analysis.chapters': createStubHandler({ chapters: [{ title: 'Chapter 1', startUs: 0 }, { title: 'Chapter 2', startUs: 300_000_000 }], __stub: true }),

  // Decision/approval nodes
  'decision.approval': createHumanInputHandler(),

  // Transform nodes
  'transform.reframe': createStubHandler({ asset: 'reframed-asset', aspect: '9:16', __stub: true }),

  'transform.caption': createStubHandler({ asset: 'captioned-asset', templateId: 'default', __stub: true }),

  'transform.normalizeAudio': createStubHandler({ asset: 'normalized-audio', targetLufs: -14, duckMusic: true, __stub: true }),

  'transform.denoise': createStubHandler({ asset: 'denoised-asset', __stub: true }),

  'transform.trim': createStubHandler({ asset: 'trimmed-asset', rangesFrom: 'analysis.silence', __stub: true }),

  'transform.compose': createStubHandler({ composed: {}, __stub: true }),

  'transform.sceneTemplate': createStubHandler({ scene: 'template-scene', variablesFrom: {}, __stub: true }),

  // Generation nodes
  'generation.translate': createStubHandler({ text: 'Translated text', language: 'en', __stub: true }),

  'generation.speech': createStubHandler({ audio: 'speech-asset', voiceId: 'default', __stub: true }),

  // Render nodes
  'render.preview': createStubHandler({ previewUrl: 'blob:preview', profile: 'preview', __stub: true }),

  'render.final': createStubHandler({ asset: 'rendered-asset', profile: 'final', __stub: true }),

  // Output nodes
  'output.folder': createStubHandler({ folderId: 'default', fileName: 'output', saved: true, __stub: true }),

  'output.metadata': createStubHandler({ manifest: { fileName: 'output', folderId: 'default', data: {}, __stub: true } }),

  // Control nodes
  'control.map': createStubHandler({ items: [], mapped: true, __stub: true }),

  // Editor nodes
  'editor.createBranch': createStubHandler({ branchId: 'branch-1', name: 'new-branch', source: 'main', __stub: true }),
};

/**
 * Creates a handler registry that includes all first-party handlers
 * plus any additional custom handlers.
 */
export function createFirstPartyHandlerRegistry(
  additionalHandlers: Readonly<Record<string, NodeHandler>> = {}
): Readonly<Record<string, NodeHandler>> {
  return {
    ...firstPartyHandlers,
    ...additionalHandlers,
  };
}

/**
 * Type guard to check if a result contains a human input request.
 */
export function isHumanInputRequest(result: NodeResult): result is { waiting: true; request: HumanInputRequest } {
  return 'waiting' in result && result.waiting === true;
}