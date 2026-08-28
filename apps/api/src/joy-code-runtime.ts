import type {
  AsyncAdapterOptions,
  AsyncOutcome,
  JoyCodePlanProposalV1,
  JoyCodePlannerInputV1,
} from '@joy-media/agent-tools';
import { finalizeJoyCodePlan } from '@joy-media/agent-tools';
import type { JoyCodeModelPlanV1, JoyCodeValidationOptions } from '@joy-media/agent-tools';

export interface JoyCodeRuntimeInput extends JoyCodePlannerInputV1 {
  readonly planId: string;
  readonly createdAt: string;
  readonly catalogVersion: string;
}
export type JoyCodeRuntimeContext = AsyncAdapterOptions;
export interface JoyCodeRuntime {
  execute(
    input: JoyCodeRuntimeInput,
    context: JoyCodeRuntimeContext,
  ): Promise<AsyncOutcome<JoyCodePlanProposalV1>>;
}
export class UnavailableJoyCodeRuntime implements JoyCodeRuntime {
  async execute(
    _input: JoyCodeRuntimeInput,
    _context: JoyCodeRuntimeContext,
  ): Promise<AsyncOutcome<JoyCodePlanProposalV1>> {
    return {
      category: 'unavailable',
      errorCode: 'JOY_CODE_RUNTIME_UNAVAILABLE',
      message: 'Joy Code runtime is not configured',
      retryable: false,
      durationMs: 0,
    };
  }
}
export const DEFAULT_JOY_CODE_RUNTIME: JoyCodeRuntime = new UnavailableJoyCodeRuntime();
export interface JoyCodeRuntimeDeps {
  readonly adapter: {
    readonly adapterName: string;
    createPlan(
      input: JoyCodePlannerInputV1,
      context: AsyncAdapterOptions,
    ): Promise<AsyncOutcome<JoyCodeModelPlanV1>>;
  };
  readonly validationOptions: JoyCodeValidationOptions;
  readonly modelId: string;
  readonly consentVersion: string;
}
export class ConfiguredJoyCodeRuntime implements JoyCodeRuntime {
  constructor(private readonly deps: JoyCodeRuntimeDeps) {}
  async execute(
    input: JoyCodeRuntimeInput,
    context: JoyCodeRuntimeContext,
  ): Promise<AsyncOutcome<JoyCodePlanProposalV1>> {
    const outcome = await this.deps.adapter.createPlan(input, context);
    if (outcome.category !== 'ready') {
      return {
        category: outcome.category,
        retryable: outcome.retryable,
        durationMs: outcome.durationMs,
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      };
    }
    if (outcome.result === undefined)
      return {
        category: 'invalid-output',
        errorCode: 'JOY_CODE_RESULT_MISSING',
        message: 'Joy Code adapter returned no plan',
        retryable: false,
        durationMs: outcome.durationMs,
      };
    const finalized = finalizeJoyCodePlan(
      input,
      outcome.result,
      {
        planId: input.planId,
        createdAt: input.createdAt,
        catalogVersion: input.catalogVersion,
        consentVersion: this.deps.consentVersion,
        adapterName: this.deps.adapter.adapterName,
        modelId: this.deps.modelId,
      },
      this.deps.validationOptions,
    );
    if (!finalized.valid)
      return {
        category: 'invalid-output',
        errorCode: 'JOY_CODE_FINALIZATION_INVALID',
        message: 'Joy Code plan failed server validation',
        retryable: false,
        durationMs: outcome.durationMs,
      };
    return {
      category: 'ready',
      result: finalized.value,
      retryable: false,
      durationMs: outcome.durationMs,
    };
  }
}
