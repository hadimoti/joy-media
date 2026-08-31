import {
  createDeepSeekHarnessJoyCodeAdapter,
  type DeepSeekHarnessEndpoint,
} from '@joy-media/adapter-deepseek-harness';
import { finalizeJoyCodePlan } from '@joy-media/agent-tools';
import type { JoyCodePlanProposalV1, JoyCodePlannerInputV1 } from '@joy-media/agent-tools';
import type { BrowserJoyCodePlanRequest } from './control-plane-client.js';
import type { LocalDeepSeekHarnessSettings } from './agent-settings.js';
import type { DeepSeekHarnessTransport } from '@joy-media/adapter-deepseek-harness';

export const LOCAL_DEEPSEEK_HARNESS_CONSENT_VERSION = 'local-deepseek-harness-v1' as const;
const CATALOGS = {
  textTemplateIds: ['clean-title', 'hero-title'],
  captionTemplateIds: ['joy-clean', 'joy-karaoke-pop', 'joy-rtl-classic'],
  transitionIds: ['dissolve', 'wipe', 'slide'],
} as const;

/**
 * Creates the local branch of the existing Joy Code transport contract.
 * It deliberately does not synchronize the document or send credentials to
 * the control plane. The API key is captured only by the local adapter.
 */
export function createLocalDeepSeekHarnessPlanner(
  settings: LocalDeepSeekHarnessSettings,
  transport?: DeepSeekHarnessTransport,
): (request: BrowserJoyCodePlanRequest, signal?: AbortSignal) => Promise<JoyCodePlanProposalV1> {
  const adapter = createDeepSeekHarnessJoyCodeAdapter({
    ...(settings satisfies DeepSeekHarnessEndpoint),
    ...(transport === undefined ? {} : { transport }),
  });
  return async (request, signal) => {
    const input: JoyCodePlannerInputV1 = {
      projectId: request.projectId,
      snapshotRevisionId: request.snapshotRevisionId,
      prompt: request.prompt,
      ...(request.creativeBrief === undefined ? {} : { creativeBrief: request.creativeBrief }),
      selection: request.selection,
      contextSummary: 'Local DeepSeek harness planning; no cloud document sync.',
      semanticSnapshot: { selectedClipIds: request.selection.clipIds },
      intelligenceSummary: { source: 'local-editor' },
      catalogs: CATALOGS,
    };
    const outcome = await adapter.createPlan(input, {
      correlationId: localCorrelationId(),
      ...(signal === undefined ? {} : { signal }),
    });
    if (outcome.category !== 'ready' || outcome.result === undefined)
      throw new Error(outcome.errorCode ?? 'DEEPSEEK_HARNESS_PLAN_FAILED');
    const finalized = finalizeJoyCodePlan(
      input,
      outcome.result,
      {
        planId: localCorrelationId(),
        createdAt: new Date().toISOString(),
        catalogVersion: 'joy-code-catalog-v1',
        consentVersion: LOCAL_DEEPSEEK_HARNESS_CONSENT_VERSION,
        adapterName: adapter.adapterName,
        modelId: settings.modelId,
        actor: 'joy-code-client',
      },
      {
        ...CATALOGS,
        allowedModelIds: [settings.modelId],
        consentVersion: LOCAL_DEEPSEEK_HARNESS_CONSENT_VERSION,
      },
    );
    if (!finalized.valid) throw new Error('DEEPSEEK_HARNESS_PLAN_FINALIZATION_INVALID');
    return finalized.value;
  };
}

function localCorrelationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
