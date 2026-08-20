import type { AsyncAdapterOptions, AsyncOutcome } from './async-model-adapter.js';
import type { JoyCodeModelPlanV1 } from './joy-code-plan.js';

export interface JoyCodePlannerInputV1 {
  readonly projectId: string;
  readonly snapshotRevisionId: string;
  readonly prompt: string;
  readonly selection: {
    readonly clipIds: readonly string[];
    readonly objectIds?: readonly string[];
  };
  readonly contextSummary: string;
}

export interface AsyncJoyCodePlannerAdapter {
  readonly adapterName: string;
  readonly isTestOnly: boolean;
  createPlan(
    input: JoyCodePlannerInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<JoyCodeModelPlanV1>>;
}

type FakeMode =
  'valid' | 'unavailable' | 'policy-denied' | 'invalid-output' | 'provider-failed' | 'timeout';

class FakeAsyncJoyCodePlanner implements AsyncJoyCodePlannerAdapter {
  get adapterName(): string {
    return `fake-joy-code-${this.mode}-v1`;
  }
  readonly isTestOnly = true;
  constructor(private readonly mode: FakeMode) {}

  async createPlan(
    input: JoyCodePlannerInputV1,
    options: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<JoyCodeModelPlanV1>> {
    const started = Date.now();
    const finish = (
      outcome: Omit<AsyncOutcome<JoyCodeModelPlanV1>, 'durationMs'>,
    ): AsyncOutcome<JoyCodeModelPlanV1> => ({ ...outcome, durationMs: Date.now() - started });
    options.auditSink?.emit({
      correlationId: options.correlationId,
      adapterName: this.adapterName,
      eventType: 'start',
      status: 'ready',
    });
    if (options.signal?.aborted)
      return finish({ category: 'cancelled', errorCode: 'JOY_CODE_ABORTED', retryable: false });
    if (this.mode === 'unavailable')
      return finish({
        category: 'unavailable',
        errorCode: 'JOY_CODE_UNAVAILABLE',
        retryable: true,
      });
    if (this.mode === 'policy-denied')
      return finish({
        category: 'policy-denied',
        errorCode: 'JOY_CODE_POLICY_DENIED',
        retryable: false,
      });
    if (this.mode === 'provider-failed')
      return finish({
        category: 'provider-failed',
        errorCode: 'JOY_CODE_PROVIDER_FAILED',
        retryable: true,
      });
    if (this.mode === 'invalid-output')
      return finish({
        category: 'invalid-output',
        errorCode: 'JOY_CODE_INVALID_OUTPUT',
        retryable: false,
      });
    if (this.mode === 'timeout' || (options.timeoutMs !== undefined && options.timeoutMs < 5))
      return finish({ category: 'timeout', errorCode: 'JOY_CODE_TIMEOUT', retryable: true });
    const result: JoyCodeModelPlanV1 = {
      schemaVersion: 1,
      goal: input.prompt,
      summary: 'Insert one catalog title for review.',
      operations: [
        {
          id: 'title',
          dependsOn: [],
          kind: 'text.insertTemplate',
          templateId: 'clean-title',
          content: 'JOY',
          startUs: 0,
          durationUs: 1_000_000,
          placementPreset: 'center',
        },
      ],
      assumptions: [],
      blockedBy: [],
      requiresHumanDecision: ['Review title copy before Apply.'],
    };
    const outcome = finish({ category: 'ready', result, retryable: false });
    options.auditSink?.emit({
      correlationId: options.correlationId,
      adapterName: this.adapterName,
      eventType: 'end',
      status: outcome.category,
      durationMs: outcome.durationMs,
    });
    return outcome;
  }
}

export function createValidFakeAsyncJoyCodePlanner(): AsyncJoyCodePlannerAdapter {
  return new FakeAsyncJoyCodePlanner('valid');
}
export function createUnavailableFakeAsyncJoyCodePlanner(): AsyncJoyCodePlannerAdapter {
  return new FakeAsyncJoyCodePlanner('unavailable');
}
export function createTimeoutFakeAsyncJoyCodePlanner(): AsyncJoyCodePlannerAdapter {
  return new FakeAsyncJoyCodePlanner('timeout');
}
