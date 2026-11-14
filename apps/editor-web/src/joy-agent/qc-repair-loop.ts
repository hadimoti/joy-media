/**
 * The fix, re-check loop of the quality check (card T-B06, ADR-0045 section 7).
 *
 * One round is: build one repair plan from the open findings, ask the owner to
 * approve it, apply it as one transaction, then check ONLY the ranges the plan
 * changed. The loop stops when the configured number of rounds is used, when
 * no finding of a repaired type is left, when nothing repairable is left, or
 * when the owner declines. Every round needs its own approval: a QC fix is
 * always previewed (section 7), whatever execution mode the agent runs in.
 *
 * The driver owns no editor state. The check, the plan, the approval and the
 * apply step are ports, so the same driver runs in the panel and in tests.
 */

import type { QcRepairFinding, QcRepairPlan, QcRepairRange } from './qc-repair-plan.js';

export type QcRecheckScope = 'all' | readonly QcRepairRange[];

export type QcCheckOutcome =
  | { readonly ok: true; readonly findings: readonly QcRepairFinding[] }
  | { readonly ok: false; readonly message: string };

export type QcApplyOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface QcRepairLoopDeps {
  /** Layer 1 over the whole cut (`'all'`) or over the given ranges only. */
  check(scope: QcRecheckScope, signal: AbortSignal): Promise<QcCheckOutcome>;
  /** Builds one plan from the open findings, against the project as it is now. */
  propose(findings: readonly QcRepairFinding[]): QcRepairPlan;
  /** The owner's answer to the plan card. Resolves true only on an explicit approve. */
  approve(plan: QcRepairPlan, round: number, signal: AbortSignal): Promise<boolean>;
  /** Commits the approved plan as one transaction. */
  apply(plan: QcRepairPlan): QcApplyOutcome;
  /** From the Joy Code settings (`fixRounds`, 1 to 3). */
  readonly maxRounds: number;
  /** Findings from a check the host already ran; skips the first full check. */
  readonly initialFindings?: readonly QcRepairFinding[];
}

export type QcRepairLoopStop =
  | 'clean'
  | 'rounds-used'
  | 'nothing-repairable'
  | 'declined'
  | 'apply-failed'
  | 'check-failed'
  | 'cancelled';

export interface QcRepairRound {
  readonly round: number;
  readonly plan: QcRepairPlan;
  readonly approved: boolean;
  readonly applied: boolean;
  /** Findings after this round's re-check (all open findings, times after the plan). */
  readonly findingsAfter: readonly QcRepairFinding[];
}

export interface QcRepairLoopResult {
  readonly stop: QcRepairLoopStop;
  readonly rounds: readonly QcRepairRound[];
  readonly initialFindings: readonly QcRepairFinding[];
  readonly remainingFindings: readonly QcRepairFinding[];
  /** Plain reason when the loop stopped on a failure. */
  readonly message?: string;
}

export const MAX_QC_FIX_ROUNDS = 3;

export async function runQcRepairLoop(
  deps: QcRepairLoopDeps,
  signal: AbortSignal,
): Promise<QcRepairLoopResult> {
  const maxRounds = Math.min(
    MAX_QC_FIX_ROUNDS,
    Math.max(1, Number.isFinite(deps.maxRounds) ? Math.floor(deps.maxRounds) : 1),
  );
  const rounds: QcRepairRound[] = [];
  let initial: readonly QcRepairFinding[];
  if (deps.initialFindings !== undefined) initial = deps.initialFindings;
  else {
    const first = await deps.check('all', signal);
    if (signal.aborted) return done('cancelled', rounds, [], []);
    if (!first.ok) return done('check-failed', rounds, [], [], first.message);
    initial = first.findings;
  }
  let open = initial;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal.aborted) return done('cancelled', rounds, initial, open);
    const plan = deps.propose(open);
    if (plan.edits.length === 0) return done('nothing-repairable', rounds, initial, open);
    const approved = await deps.approve(plan, round, signal);
    if (signal.aborted) return done('cancelled', rounds, initial, open);
    if (!approved) {
      rounds.push({ round, plan, approved: false, applied: false, findingsAfter: open });
      return done('declined', rounds, initial, open);
    }
    const applied = deps.apply(plan);
    if (!applied.ok) {
      rounds.push({ round, plan, approved: true, applied: false, findingsAfter: open });
      return done('apply-failed', rounds, initial, open, applied.message);
    }
    const rechecked = await deps.check(plan.changedRanges, signal);
    if (signal.aborted) return done('cancelled', rounds, initial, open);
    if (!rechecked.ok) {
      rounds.push({ round, plan, approved: true, applied: true, findingsAfter: open });
      return done('check-failed', rounds, initial, open, rechecked.message);
    }
    open = mergeAfterRecheck(open, plan, rechecked.findings);
    rounds.push({ round, plan, approved: true, applied: true, findingsAfter: open });
    const repaired = new Set(plan.repairedTypes);
    if (!open.some((finding) => repaired.has(finding.type)))
      return done('clean', rounds, initial, open);
  }
  return done('rounds-used', rounds, initial, open);
}

/**
 * The open findings after a round. A finding the plan repaired is dropped; it
 * comes back only if the re-check finds it again. A finding the plan did not
 * touch keeps its place, moved to the time it has after the plan's cuts,
 * unless it overlaps a re-checked range, where the re-check's answer replaces it.
 */
export function mergeAfterRecheck(
  before: readonly QcRepairFinding[],
  plan: QcRepairPlan,
  rechecked: readonly QcRepairFinding[],
): QcRepairFinding[] {
  const repairedIds = new Set(plan.edits.flatMap((edit) => edit.findingIds));
  const kept: QcRepairFinding[] = [];
  for (const finding of before) {
    if (repairedIds.has(finding.id)) continue;
    const moved = {
      ...finding,
      startUs: plan.mapTimeUs(finding.startUs),
      endUs: plan.mapTimeUs(finding.endUs),
    };
    if (plan.changedRanges.some((range) => overlaps(range, moved))) continue;
    kept.push(moved);
  }
  return [...kept, ...rechecked];
}

function overlaps(range: QcRepairRange, finding: QcRepairRange): boolean {
  if (finding.startUs === finding.endUs)
    return finding.startUs >= range.startUs && finding.startUs < range.endUs;
  return finding.startUs < range.endUs && finding.endUs > range.startUs;
}

function done(
  stop: QcRepairLoopStop,
  rounds: readonly QcRepairRound[],
  initialFindings: readonly QcRepairFinding[],
  remainingFindings: readonly QcRepairFinding[],
  message?: string,
): QcRepairLoopResult {
  return {
    stop,
    rounds,
    initialFindings,
    remainingFindings,
    ...(message === undefined ? {} : { message }),
  };
}
