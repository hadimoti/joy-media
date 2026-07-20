import type { EditorContext } from '../context.js';

export interface BenchmarkIntent {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly intent: string;
  readonly expectedPlanSteps: number;
  readonly expectedTools: readonly string[];
  readonly requiresApproval: readonly string[];
  readonly localOnly: boolean;
  readonly expectedDuration?: { minMs: number; maxMs: number };
  readonly validationChecks: readonly ValidationCheck[];
}

export interface ValidationCheck {
  readonly name: string;
  readonly type:
    | 'entities-created'
    | 'entities-modified'
    | 'no-overlaps'
    | 'captions-valid'
    | 'audio-valid'
    | 'cost-within-limit'
    | 'local-only-respected'
    | 'approval-requested'
    | 'revert-possible';
  readonly params?: Record<string, unknown>;
}

export interface BenchmarkProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly projectState: unknown;
  readonly context: EditorContext;
}
