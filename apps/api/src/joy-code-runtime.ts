import type { AsyncAdapterOptions, AsyncOutcome, JoyCodePlanProposalV1, JoyCodePlannerInputV1 } from '@joy-media/agent-tools';
import { finalizeJoyCodePlan } from '@joy-media/agent-tools';
import type { JoyCodeRuntimeConfig } from './joy-code-runtime-config.js';

export interface JoyCodeRuntimeInput extends JoyCodePlannerInputV1 { readonly planId: string; readonly createdAt: string; readonly catalogVersion: string; }
export interface JoyCodeRuntimeContext extends AsyncAdapterOptions {}
export interface JoyCodeRuntime { execute(input: JoyCodeRuntimeInput, context: JoyCodeRuntimeContext): Promise<AsyncOutcome<JoyCodePlanProposalV1>>; }
export class UnavailableJoyCodeRuntime implements JoyCodeRuntime { async execute(_input: JoyCodeRuntimeInput, _context: JoyCodeRuntimeContext): Promise<AsyncOutcome<JoyCodePlanProposalV1>> { return { category: 'unavailable', errorCode: 'JOY_CODE_RUNTIME_UNAVAILABLE', message: 'Joy Code runtime is not configured', retryable: false, durationMs: 0 }; } }
export const DEFAULT_JOY_CODE_RUNTIME: JoyCodeRuntime = new UnavailableJoyCodeRuntime();
export interface JoyCodeRuntimeDeps { readonly adapter: { readonly adapterName: string; createPlan(input: JoyCodePlannerInputV1, context: AsyncAdapterOptions): Promise<AsyncOutcome<import('@joy-media/agent-tools').JoyCodeModelPlanV1>> }; readonly validationOptions: import('@joy-media/agent-tools').JoyCodeValidationOptions; readonly modelId: string; readonly consentVersion: string; }
export class ConfiguredJoyCodeRuntime implements JoyCodeRuntime {
  constructor(private readonly deps: JoyCodeRuntimeDeps) {}
  async execute(input: JoyCodeRuntimeInput, context: JoyCodeRuntimeContext): Promise<AsyncOutcome<JoyCodePlanProposalV1>> {
    const outcome = await this.deps.adapter.createPlan(input, context);
    if (outcome.category !== 'ready') {
      const { result: _result, ...withoutResult } = outcome;
      return withoutResult;
    }
    if (outcome.result === undefined) return { category: 'invalid-output', errorCode: 'JOY_CODE_RESULT_MISSING', message: 'Joy Code adapter returned no plan', retryable: false, durationMs: outcome.durationMs };
    const finalized = finalizeJoyCodePlan(input, outcome.result, { planId: input.planId, createdAt: input.createdAt, catalogVersion: input.catalogVersion, consentVersion: this.deps.consentVersion, adapterName: this.deps.adapter.adapterName, modelId: this.deps.modelId }, this.deps.validationOptions);
    if (!finalized.valid) return { category: 'invalid-output', errorCode: 'JOY_CODE_FINALIZATION_INVALID', message: 'Joy Code plan failed server validation', retryable: false, durationMs: outcome.durationMs };
    return { category: 'ready', result: finalized.value, retryable: false, durationMs: outcome.durationMs };
  }
}
