/**
 * Binds the fix, re-check loop (T-B06) to the QC host adapter and the editor
 * session. This is the one construction path for the loop in the editor:
 *
 *  - the checks are Layer 1 ports. `timelineQcCheckPort` wraps the QC host
 *    adapter's timeline check (safe area and legibility, and the ranged
 *    re-check). A file check (black, frozen, loudness, clipping from the
 *    Worker) can be added as another port by the caller that holds an export;
 *  - the plan is `planQcRepairs` over the project as it is at that moment;
 *  - the approval is the owner's answer to the plan card;
 *  - the apply step is one `dispatchCompound`, so each round is one Undo.
 */

import type { AudioState } from '@joy-media/commands';
import type { Clip, Track } from '@joy-media/project-schema';
import type { TimelineQcTextBox } from '../media-observation/qc-sampler.js';
import type { QcHostAdapter } from './qc-host-adapter.js';
import { applyQcRepairPlan, type QcRepairCommitTarget } from './qc-repair-apply.js';
import {
  runQcRepairLoop,
  type QcCheckOutcome,
  type QcRecheckScope,
  type QcRepairLoopResult,
} from './qc-repair-loop.js';
import {
  planQcRepairs,
  type QcRepairAudioTargets,
  type QcRepairFinding,
  type QcRepairPlan,
} from './qc-repair-plan.js';

/** One Layer 1 check. `'unavailable'` means this port cannot run in this build. */
export interface QcCheckPort {
  check(
    scope: QcRecheckScope,
    signal: AbortSignal,
  ): Promise<QcCheckOutcome | { readonly ok: 'unavailable'; readonly message: string }>;
}

export interface QcRepairHostDeps {
  readonly session: QcRepairCommitTarget;
  readonly checks: readonly QcCheckPort[];
  readonly getAudio: () => AudioState;
  /** Told the mixer graph after each applied round, so the panel state follows the document. */
  readonly onAudioApplied?: (audio: AudioState) => void;
  /** Refreshes editor projections after a committed compound transaction. */
  readonly onApplied?: () => void;
  readonly textBoxes: () => readonly TimelineQcTextBox[];
  readonly approve: (plan: QcRepairPlan, round: number, signal: AbortSignal) => Promise<boolean>;
  /** The Joy Code setting `fixRounds`. */
  readonly maxRounds: number;
  readonly isPictureClip?: (clip: Clip, track: Track) => boolean;
  readonly audioTargets?: QcRepairAudioTargets;
}

export interface QcRepairHost {
  /** Runs Layer 1 over the whole cut with every port that can run. */
  checkAll(signal: AbortSignal): Promise<QcCheckOutcome>;
  /** Builds the plan the owner would be asked to approve, against the project now. */
  propose(findings: readonly QcRepairFinding[]): QcRepairPlan;
  /** The full loop. `initialFindings` skips the first check when the host already has a report. */
  run(
    signal: AbortSignal,
    initialFindings?: readonly QcRepairFinding[],
  ): Promise<QcRepairLoopResult>;
}

export function createQcRepairHost(deps: QcRepairHostDeps): QcRepairHost {
  let planBaseRevision: string | undefined;
  let planCounter = 0;
  let checkCounter = 0;

  const check = async (scope: QcRecheckScope, signal: AbortSignal): Promise<QcCheckOutcome> => {
    const findings: QcRepairFinding[] = [];
    let ran = 0;
    const messages: string[] = [];
    checkCounter += 1;
    for (const [index, port] of deps.checks.entries()) {
      const outcome = await port.check(scope, signal);
      if (outcome.ok === true) {
        ran += 1;
        // Report ids restart in every report; this keeps each finding's id unique in the loop.
        for (const finding of outcome.findings)
          findings.push({ ...finding, id: `check-${checkCounter}-${index + 1}:${finding.id}` });
      } else messages.push(outcome.message);
    }
    if (ran === 0)
      return { ok: false, message: messages[0] ?? 'No quality check can run in this build.' };
    return { ok: true, findings };
  };

  const propose = (findings: readonly QcRepairFinding[]): QcRepairPlan => {
    planCounter += 1;
    planBaseRevision = deps.session.projectRevisionId;
    return planQcRepairs({
      findings,
      timeline: deps.session.timelineProject,
      document: deps.session.visualProject,
      audio: deps.getAudio(),
      textBoxes: deps.textBoxes(),
      planId: `qc-repair-plan-${planCounter}`,
      ...(deps.isPictureClip === undefined ? {} : { isPictureClip: deps.isPictureClip }),
      ...(deps.audioTargets === undefined ? {} : { audioTargets: deps.audioTargets }),
    });
  };

  return {
    checkAll: (signal) => check('all', signal),
    propose,
    run: (signal, initialFindings) =>
      runQcRepairLoop(
        {
          check,
          propose,
          approve: deps.approve,
          apply: (plan) => {
            const applied = applyQcRepairPlan(
              deps.session,
              plan,
              deps.getAudio(),
              planBaseRevision ?? deps.session.projectRevisionId,
            );
            if (!applied.ok) return { ok: false, message: applied.message };
            if (plan.audioCommands.length > 0) deps.onAudioApplied?.(applied.audio);
            deps.onApplied?.();
            return { ok: true };
          },
          maxRounds: deps.maxRounds,
          ...(initialFindings === undefined ? {} : { initialFindings }),
        },
        signal,
      ),
  };
}

/** The QC host adapter's timeline check as a Layer 1 port (full check or ranged re-check). */
export function timelineQcCheckPort(adapter: QcHostAdapter): QcCheckPort {
  return {
    async check(scope, signal) {
      const result = await adapter.runTimelineCheck(signal, scope === 'all' ? undefined : scope);
      if (!result.ok)
        return result.code === 'composition-unavailable'
          ? { ok: 'unavailable', message: result.message }
          : { ok: false, message: result.message };
      const report = adapter.storedReport(result.reportId);
      if (report === undefined) return { ok: false, message: 'The QC report is no longer stored.' };
      return { ok: true, findings: findingsFromQcReport(report) };
    },
  };
}

/** Reads the findings of a stored report (ADR-0045 section 11 shape). Malformed entries are skipped. */
export function findingsFromQcReport(report: Readonly<Record<string, unknown>>): QcRepairFinding[] {
  const findings = report['findings'];
  if (!Array.isArray(findings)) return [];
  const parsed: QcRepairFinding[] = [];
  for (const entry of findings) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const { id, type, startUs, endUs, measured } = record;
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    if (typeof startUs !== 'number' || typeof endUs !== 'number') continue;
    parsed.push({
      id,
      type,
      startUs,
      endUs,
      ...(typeof measured === 'object' && measured !== null && !Array.isArray(measured)
        ? { measured: measured as Readonly<Record<string, unknown>> }
        : {}),
    });
  }
  return parsed;
}
