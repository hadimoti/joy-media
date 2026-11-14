import { describe, expect, it, vi } from 'vitest';
import type { AgentEditPlan } from '@joy-media/agent-tools';
import { mergeAfterRecheck, runQcRepairLoop, type QcRepairLoopDeps } from './qc-repair-loop.js';
import type { QcRepairFinding, QcRepairPlan } from './qc-repair-plan.js';

const S = 1_000_000;

function plan(
  findings: readonly QcRepairFinding[],
  options: { cut?: { startUs: number; endUs: number } } = {},
): QcRepairPlan {
  const repairable = findings.filter((finding) => finding.type !== 'exposure');
  const cut = options.cut;
  return {
    edits:
      repairable.length === 0
        ? []
        : [
            {
              kind: 'move',
              findingIds: repairable.map((finding) => finding.id),
              objectId: 'title',
              dxPx: 10,
              dyPx: 0,
              startUs: 0,
              endUs: 1,
              commands: [],
            },
          ],
    notRepairable: [],
    timelineCommands: [],
    audioCommands: [],
    visualCommands: [],
    changedRanges: [{ startUs: 2 * S, endUs: 3 * S }],
    repairedTypes: [...new Set(repairable.map((finding) => finding.type))],
    mapTimeUs: (timeUs) =>
      cut === undefined || timeUs < cut.endUs ? timeUs : timeUs - (cut.endUs - cut.startUs),
    agentPlan: {} as AgentEditPlan,
  };
}

function deps(overrides: Partial<QcRepairLoopDeps>): QcRepairLoopDeps {
  return {
    check: async () => ({ ok: true, findings: [] }),
    propose: (findings) => plan(findings),
    approve: async () => true,
    apply: () => ({ ok: true }),
    maxRounds: 3,
    ...overrides,
  };
}

const SAFE: QcRepairFinding = { id: 'f1', type: 'safe-area', startUs: 2 * S, endUs: 3 * S };

describe('QC repair loop', () => {
  it('stops clean after one round when the re-check finds nothing of the repaired type', async () => {
    const check = vi.fn(async () => ({ ok: true as const, findings: [] }));
    const result = await runQcRepairLoop(
      deps({ check, initialFindings: [SAFE] }),
      new AbortController().signal,
    );
    expect(result.stop).toBe('clean');
    expect(result.rounds).toHaveLength(1);
    // Only the changed ranges are checked again.
    expect(check).toHaveBeenCalledWith([{ startUs: 2 * S, endUs: 3 * S }], expect.anything());
  });

  it('stops after the configured rounds when the fault keeps coming back', async () => {
    let n = 0;
    const approve = vi.fn(async () => true);
    const result = await runQcRepairLoop(
      deps({
        approve,
        initialFindings: [SAFE],
        check: async () => ({ ok: true, findings: [{ ...SAFE, id: `again-${++n}` }] }),
        maxRounds: 2,
      }),
      new AbortController().signal,
    );
    expect(result.stop).toBe('rounds-used');
    expect(approve).toHaveBeenCalledTimes(2);
    expect(result.remainingFindings.map((finding) => finding.id)).toEqual(['again-2']);
  });

  it('never runs more than three rounds, whatever the setting says', async () => {
    const approve = vi.fn(async () => true);
    await runQcRepairLoop(
      deps({
        approve,
        initialFindings: [SAFE],
        check: async () => ({ ok: true, findings: [{ ...SAFE, id: 'again' }] }),
        maxRounds: 9,
      }),
      new AbortController().signal,
    );
    expect(approve).toHaveBeenCalledTimes(3);
  });

  it('runs the first full check itself when no findings are given', async () => {
    const check = vi.fn(async () => ({ ok: true as const, findings: [] }));
    const result = await runQcRepairLoop(deps({ check }), new AbortController().signal);
    expect(check).toHaveBeenCalledWith('all', expect.anything());
    expect(result.stop).toBe('nothing-repairable');
  });

  it('stops without applying when the owner declines', async () => {
    const apply = vi.fn(() => ({ ok: true as const }));
    const result = await runQcRepairLoop(
      deps({ apply, approve: async () => false, initialFindings: [SAFE] }),
      new AbortController().signal,
    );
    expect(result.stop).toBe('declined');
    expect(apply).not.toHaveBeenCalled();
    expect(result.remainingFindings).toEqual([SAFE]);
  });

  it('reports an apply failure and a re-check failure plainly', async () => {
    const failedApply = await runQcRepairLoop(
      deps({ apply: () => ({ ok: false, message: 'stale' }), initialFindings: [SAFE] }),
      new AbortController().signal,
    );
    expect(failedApply).toMatchObject({ stop: 'apply-failed', message: 'stale' });
    const failedCheck = await runQcRepairLoop(
      deps({ check: async () => ({ ok: false, message: 'no frames' }), initialFindings: [SAFE] }),
      new AbortController().signal,
    );
    expect(failedCheck).toMatchObject({ stop: 'check-failed', message: 'no frames' });
  });

  it('stops when only advice-only findings are left', async () => {
    const result = await runQcRepairLoop(
      deps({ initialFindings: [{ id: 'e', type: 'exposure', startUs: 0, endUs: S }] }),
      new AbortController().signal,
    );
    expect(result.stop).toBe('nothing-repairable');
    expect(result.rounds).toEqual([]);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const result = await runQcRepairLoop(
      deps({
        initialFindings: [SAFE],
        approve: async () => {
          controller.abort();
          return true;
        },
      }),
      controller.signal,
    );
    expect(result.stop).toBe('cancelled');
  });
});

describe('merge after a re-check', () => {
  it('drops repaired findings, shifts untouched ones and lets the re-check speak for its ranges', () => {
    const before: QcRepairFinding[] = [
      SAFE,
      { id: 'late', type: 'exposure', startUs: 9 * S, endUs: 10 * S },
      // 3.5 s before the one-second cut is 2.5 s after it: inside the re-checked range.
      { id: 'inside', type: 'exposure', startUs: 3_500_000, endUs: 3_600_000 },
    ];
    const merged = mergeAfterRecheck(before, plan([SAFE], { cut: { startUs: 0, endUs: 1 * S } }), [
      { id: 'new', type: 'text-legibility', startUs: 2 * S, endUs: 3 * S },
    ]);
    expect(merged).toEqual([
      { id: 'late', type: 'exposure', startUs: 8 * S, endUs: 9 * S },
      { id: 'new', type: 'text-legibility', startUs: 2 * S, endUs: 3 * S },
    ]);
  });
});
