import { describe, expect, it, vi } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { AuditTrail } from './audit.js';
import { RevisionConflictError } from './envelope.js';
import { combineProposals, commitCombinedChangeSet, runSpecialists } from './specialists.js';
import type { ChangeSetProposal, SpecialistContext, SpecialistDefinition } from './specialists.js';
import {
  AUDIO_CLEANUP_AGENT,
  BUILT_IN_SPECIALISTS,
  CAPTION_AGENT,
  COLOR_REVIEW_AGENT,
  PACING_AGENT,
} from './specialists-builtin.js';

/** A copy of the reference timeline with a hole punched between two clips. */
function timelineWithGap(gapUs: number): SpikeProject {
  const project = buildReferenceSpikeProject();
  const root = project.compositions['root']!;
  return {
    ...project,
    compositions: {
      ...project.compositions,
      root: {
        ...root,
        tracks: root.tracks.map((track) =>
          track.id !== 'track-0'
            ? track
            : {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === 'intro' ? clip : { ...clip, startUs: clip.startUs + gapUs },
                ),
              },
        ),
      },
    },
  };
}

const CREATIVE: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'p1',
  title: 'Reel',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
  rootCompositionId: 'root',
  settings: { defaultLocale: 'en' },
  compositions: {
    root: {
      id: 'root',
      name: 'Reel',
      width: 1080,
      height: 1920,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 30_000_000,
      background: '#000000',
      tracks: [
        {
          id: 'captions',
          kind: 'caption',
          name: 'Captions',
          order: 0,
          enabled: true,
          locked: false,
          clips: [
            {
              id: 'cap-1',
              kind: 'caption',
              startUs: 0,
              durationUs: 6_000_000,
              captionDocumentId: 'doc-1',
            },
            {
              id: 'cap-2',
              kind: 'caption',
              startUs: 4_000_000,
              durationUs: 3_000_000,
              captionDocumentId: 'doc-1',
            },
          ],
        },
      ],
    },
  },
  assets: {},
  variables: {},
  markers: [],
  visualObjects: {},
  captionDocuments: {
    'doc-1': {
      id: 'doc-1',
      language: 'en-US',
      direction: 'ltr',
      words: {},
      segments: [],
      speakers: [],
    },
  },
  pluginData: {},
};

function context(overrides: Partial<SpecialistContext> = {}): SpecialistContext {
  return {
    timeline: buildReferenceSpikeProject(),
    creative: CREATIVE,
    scope: { compositionId: 'root', clipIds: [] },
    ...overrides,
  };
}

const READ_ONLY = { allowedCapabilities: ['timeline.read'] as const };

describe('specialist agents', () => {
  describe('they cannot mutate the project', () => {
    it('gives a specialist no way to reach the project', () => {
      // The guarantee is structural: there is nothing on the context to call.
      const seen = context();

      expect(Object.keys(seen).sort()).toEqual(['creative', 'scope', 'timeline']);
      expect('dispatch' in seen).toBe(false);
      expect('commit' in seen).toBe(false);
      expect('registry' in seen).toBe(false);
    });

    it('leaves the project untouched after a full run', async () => {
      const before = JSON.parse(JSON.stringify(context().creative));

      await runSpecialists(BUILT_IN_SPECIALISTS, context(), {
        allowedCapabilities: ['timeline.read'],
      });

      expect(context().creative).toEqual(before);
    });
  });

  describe('parallel analysis', () => {
    it('runs specialists concurrently rather than in sequence', async () => {
      const order: string[] = [];
      const slow = (roleId: string, delayMs: number): SpecialistDefinition => ({
        roleId,
        capability: 'test.analyse',
        label: roleId,
        requiredCapabilities: ['timeline.read'],
        analyse: async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          order.push(roleId);
          return proposal(roleId, []);
        },
      });

      await runSpecialists([slow('slow', 20), slow('fast', 1)], context(), READ_ONLY);

      // Sequential execution would finish in declaration order.
      expect(order).toEqual(['fast', 'slow']);
    });

    it('keeps the other results when one specialist throws', async () => {
      const broken: SpecialistDefinition = {
        roleId: 'broken',
        capability: 'test.analyse',
        label: 'broken',
        requiredCapabilities: ['timeline.read'],
        analyse: () => {
          throw new Error('provider unavailable');
        },
      };

      const result = await runSpecialists([broken, CAPTION_AGENT], context(), READ_ONLY);

      expect(result.failed).toEqual([{ roleId: 'broken', error: 'provider unavailable' }]);
      expect(result.proposals.map((p) => p.roleId)).toEqual(['caption-agent']);
    });
  });

  describe('permissions and budgets', () => {
    it('refuses a specialist that wants authority the run does not have', async () => {
      const greedy: SpecialistDefinition = {
        roleId: 'greedy',
        capability: 'test.spend',
        label: 'greedy',
        requiredCapabilities: ['provider.spend'],
        analyse: () => proposal('greedy', []),
      };

      const result = await runSpecialists([greedy], context(), READ_ONLY);

      expect(result.proposals).toEqual([]);
      expect(result.denied[0]?.reason).toMatch(/provider\.spend/);
    });

    it('never invokes a denied specialist, so it does not see the project at all', async () => {
      const analyse = vi.fn(() => proposal('greedy', []));
      const greedy: SpecialistDefinition = {
        roleId: 'greedy',
        capability: 'test.spend',
        label: 'greedy',
        requiredCapabilities: ['provider.spend'],
        analyse,
      };

      await runSpecialists([greedy], context(), READ_ONLY);

      expect(analyse).not.toHaveBeenCalled();
    });

    it('caps how many specialists one run may use', async () => {
      const result = await runSpecialists(BUILT_IN_SPECIALISTS, context(), {
        ...READ_ONLY,
        budget: { maxSpecialists: 1, maxEditsPerSpecialist: 50 },
      });

      expect(result.proposals).toHaveLength(1);
      expect(result.denied).toHaveLength(BUILT_IN_SPECIALISTS.length - 1);
    });

    it('rejects a proposal that exceeds the edit budget', async () => {
      const chatty: SpecialistDefinition = {
        roleId: 'chatty',
        capability: 'test.analyse',
        label: 'chatty',
        requiredCapabilities: ['timeline.read'],
        analyse: () =>
          proposal(
            'chatty',
            Array.from({ length: 5 }, (_, index) => ({
              targetId: `clip-${index}`,
              summary: 'change',
              domain: 'parameters' as const,
            })),
          ),
      };

      const result = await runSpecialists([chatty], context(), {
        ...READ_ONLY,
        budget: { maxSpecialists: 8, maxEditsPerSpecialist: 2 },
      });

      expect(result.proposals).toEqual([]);
      expect(result.failed[0]?.error).toMatch(/over the budget/);
    });

    it('records each proposal in the audit trail', async () => {
      const audit = new AuditTrail();

      await runSpecialists([CAPTION_AGENT], context(), {
        ...READ_ONLY,
        audit,
        planId: 'run-1',
      });

      expect(audit.getEntriesForPlan('run-1')).toHaveLength(1);
    });
  });

  describe('combining proposals', () => {
    it('merges edits from different specialists', () => {
      const combined = combineProposals([
        proposal('a', [{ targetId: 'clip-1', summary: 'x', domain: 'parameters' }]),
        proposal('b', [{ targetId: 'clip-2', summary: 'y', domain: 'parameters' }]),
      ]);

      expect(combined.ok).toBe(true);
      expect(combined.edits).toHaveLength(2);
    });

    it('refuses when two specialists touch the same target', () => {
      // Last-write-wins would produce a result nobody proposed.
      const combined = combineProposals([
        proposal('a', [{ targetId: 'clip-1', summary: 'raise gain', domain: 'parameters' }]),
        proposal('b', [{ targetId: 'clip-1', summary: 'mute it', domain: 'parameters' }]),
      ]);

      expect(combined.ok).toBe(false);
      expect([...(combined.conflicts[0]?.roleIds ?? [])].sort()).toEqual(['a', 'b']);
      expect(combined.conflicts[0]?.summaries).toHaveLength(2);
    });

    it('allows one specialist to touch the same target twice', () => {
      const combined = combineProposals([
        proposal('a', [
          { targetId: 'clip-1', summary: 'trim', domain: 'parameters' },
          { targetId: 'clip-1', summary: 'normalize', domain: 'parameters' },
        ]),
      ]);

      expect(combined.ok).toBe(true);
    });

    it('is not ok when nothing was proposed', () => {
      expect(combineProposals([]).ok).toBe(false);
    });
  });

  describe('single transaction authority', () => {
    const grant = { approvedRoleIds: ['a'], approvedAt: '2026-07-27T00:00:00.000Z' };
    const combined = () =>
      combineProposals([
        proposal('a', [{ targetId: 'clip-1', summary: 'normalize', domain: 'parameters' }]),
      ]);

    function commitOptions(overrides: Record<string, unknown> = {}) {
      return {
        actor: { type: 'human' as const, id: 'hadi' },
        projectId: 'p1',
        baseRevision: 'rev-1',
        currentRevision: () => 'rev-1',
        approval: grant,
        build: (set: ReturnType<typeof combined>) => set.edits,
        commit: vi.fn(() => ({ success: true })),
        ...overrides,
      };
    }

    it('commits once, not once per specialist', () => {
      const options = commitOptions();
      const result = commitCombinedChangeSet(combined(), options as never);

      expect(result.committed).toBe(true);
      expect(options.commit).toHaveBeenCalledTimes(1);
    });

    it('stamps an envelope per edit, attributed to the specialist', () => {
      const result = commitCombinedChangeSet(combined(), commitOptions() as never);

      expect(result.envelopes).toHaveLength(1);
      expect(result.envelopes[0]?.actor).toEqual({ type: 'agent', id: 'a' });
      expect(result.envelopes[0]?.type).toBe('specialist.test.analyse');
    });

    it('refuses a change set with conflicts', () => {
      const conflicted = combineProposals([
        proposal('a', [{ targetId: 'c', summary: 'x', domain: 'parameters' }]),
        proposal('b', [{ targetId: 'c', summary: 'y', domain: 'parameters' }]),
      ]);
      const options = commitOptions({
        approval: { approvedRoleIds: ['a', 'b'], approvedAt: 'now' },
      });

      const result = commitCombinedChangeSet(conflicted, options as never);

      expect(result.committed).toBe(false);
      expect(result.errors[0]).toMatch(/conflict/);
      expect(options.commit).not.toHaveBeenCalled();
    });

    it('refuses when a contributing specialist was not approved', () => {
      // Approving "the review" must not silently include a result never seen.
      const both = combineProposals([
        proposal('a', [{ targetId: 'c1', summary: 'x', domain: 'parameters' }]),
        proposal('b', [{ targetId: 'c2', summary: 'y', domain: 'parameters' }]),
      ]);
      const options = commitOptions();

      const result = commitCombinedChangeSet(both, options as never);

      expect(result.committed).toBe(false);
      expect(result.errors[0]).toMatch(/not approved: b/);
      expect(options.commit).not.toHaveBeenCalled();
    });

    it('does not require approving a specialist that proposed nothing', () => {
      // Found in the browser: a clean review blocked applying the other two.
      // A proposal with no edits contributes nothing, so demanding approval for
      // it would block a legitimate apply.
      const withSilent = combineProposals([
        proposal('a', [{ targetId: 'c1', summary: 'x', domain: 'parameters' }]),
        proposal('quiet', []),
      ]);
      const options = commitOptions();

      const result = commitCombinedChangeSet(withSilent, options as never);

      expect(result.committed).toBe(true);
      expect(options.commit).toHaveBeenCalledTimes(1);
    });

    it('fails safely when the project moved since the analysis', () => {
      const options = commitOptions({ currentRevision: () => 'rev-2' });

      expect(() => commitCombinedChangeSet(combined(), options as never)).toThrow(
        RevisionConflictError,
      );
      expect(options.commit).not.toHaveBeenCalled();
    });

    it('reports a failed commit rather than claiming success', () => {
      const options = commitOptions({
        commit: vi.fn(() => ({ success: false, error: 'bus rejected' })),
      });

      const result = commitCombinedChangeSet(combined(), options as never);

      expect(result.committed).toBe(false);
      expect(result.errors).toEqual(['bus rejected']);
    });

    it('audits both the refusal and the commit', () => {
      const audit = new AuditTrail();
      commitCombinedChangeSet(
        combineProposals([]),
        commitOptions({ audit, planId: 'run-2' }) as never,
      );
      commitCombinedChangeSet(combined(), commitOptions({ audit, planId: 'run-2' }) as never);

      const actions = audit.getEntriesForPlan('run-2').map((e) => e.action);
      expect(actions).toEqual(['execution-failed', 'execution-completed']);
    });
  });

  describe('the built-in specialists', () => {
    it('finds caption overlap and overrun', async () => {
      const result = await runSpecialists([CAPTION_AGENT], context(), READ_ONLY);
      const proposal = result.proposals[0]!;

      expect(proposal.findings.join(' ')).toMatch(/overlaps/);
      expect(proposal.edits.map((e) => e.targetId)).toContain('cap-1');
      expect(proposal.warnings.join(' ')).toMatch(/no words/);
    });

    it('proposes normalizing clips with no audio settings', async () => {
      const result = await runSpecialists([AUDIO_CLEANUP_AGENT], context(), READ_ONLY);

      expect(result.proposals[0]?.edits[0]?.parameters).toEqual({ gain: 1, pan: 0 });
    });

    it('reduces a gain that would clip on export', async () => {
      const loud = context({
        creative: {
          ...CREATIVE,
          audio: {
            clips: { intro: { gain: 2.4, pan: 0, mute: false, solo: false } },
            buses: [],
            effects: [],
          },
        },
      });

      const result = await runSpecialists([AUDIO_CLEANUP_AGENT], loud, READ_ONLY);
      const edit = result.proposals[0]?.edits.find((e) => e.targetId === 'intro');

      expect(edit?.parameters).toEqual({ gain: 1 });
    });

    it('proposes a base grade when none is set, and reports what it cannot fix', async () => {
      const result = await runSpecialists([COLOR_REVIEW_AGENT], context(), READ_ONLY);
      const proposal = result.proposals[0]!;

      expect(proposal.edits[0]?.targetId).toBe('colorGrade');
      // A single master grade cannot match several sources; say so rather than
      // proposing an edit that would not work.
      expect(proposal.warnings.join(' ')).toMatch(/distinct sources/);
    });

    it('honours scope, so an out-of-scope clip is not analysed', async () => {
      const scoped = context({ scope: { compositionId: 'root', clipIds: ['cap-2'] } });

      const result = await runSpecialists([CAPTION_AGENT], scoped, READ_ONLY);

      expect(result.proposals[0]?.edits.every((e) => e.targetId !== 'cap-1')).toBe(true);
    });

    it('produces no conflicts between them, since they own different targets', async () => {
      const result = await runSpecialists(BUILT_IN_SPECIALISTS, context(), READ_ONLY);

      expect(combineProposals(result.proposals).conflicts).toEqual([]);
    });

    it('proposes closing dead air between two shots', async () => {
      const gapped = context({ timeline: timelineWithGap(2_000_000) });

      const result = await runSpecialists([PACING_AGENT], gapped, READ_ONLY);
      const proposal = result.proposals[0]!;

      expect(proposal.findings.join(' ')).toMatch(/dead air before "product"/);
      const edit = proposal.edits.find((candidate) => candidate.targetId === 'product');
      expect(edit?.domain).toBe('timeline');
      expect(edit?.parameters).toEqual({ startUs: 10_000_000 });
    });

    it('closes a run of gaps cumulatively rather than one proposal per hole', async () => {
      // "outro" is shifted by the same gap, so closing "product" already frees
      // the space; the second proposal has to account for the first.
      const gapped = context({ timeline: timelineWithGap(2_000_000) });

      const result = await runSpecialists([PACING_AGENT], gapped, READ_ONLY);
      const outro = result.proposals[0]?.edits.find((edit) => edit.targetId === 'outro');

      expect(outro?.parameters).toEqual({ startUs: 20_000_000 });
    });

    it('leaves a gap shorter than half a second alone', async () => {
      const gapped = context({ timeline: timelineWithGap(200_000) });

      const result = await runSpecialists([PACING_AGENT], gapped, READ_ONLY);

      expect(result.proposals[0]?.edits).toEqual([]);
      expect(result.proposals[0]?.findings.join(' ')).toMatch(/no gap over/);
    });

    it('reports an out-of-scope gap instead of silently proposing for it', async () => {
      const gapped = context({
        timeline: timelineWithGap(2_000_000),
        scope: { compositionId: 'root', clipIds: ['outro'] },
      });

      const result = await runSpecialists([PACING_AGENT], gapped, READ_ONLY);

      // "product" holds its place, so "outro" is already flush against it and
      // there is nothing to propose — only the gap it may not touch to report.
      expect(result.proposals[0]?.edits).toEqual([]);
      expect(result.proposals[0]?.warnings.join(' ')).toMatch(/"product".*outside the scope/);
    });
  });

  describe('conflicts are per domain, not per target', () => {
    it('does not flag two specialists touching one clip in different domains', () => {
      const combined = combineProposals([
        {
          ...proposal('audio-cleanup-agent', [
            { targetId: 'intro', summary: 'gain', domain: 'parameters', parameters: { gain: 1 } },
          ]),
        },
        {
          ...proposal('pacing-agent', [
            { targetId: 'intro', summary: 'move', domain: 'timeline', parameters: { startUs: 0 } },
          ]),
        },
      ]);

      expect(combined.conflicts).toEqual([]);
      expect(combined.ok).toBe(true);
    });

    it('still flags two specialists touching one target in the same domain', () => {
      const combined = combineProposals([
        proposal('a', [{ targetId: 'intro', summary: 'x', domain: 'timeline' }]),
        proposal('b', [{ targetId: 'intro', summary: 'y', domain: 'timeline' }]),
      ]);

      expect(combined.conflicts).toHaveLength(1);
      expect(combined.conflicts[0]).toMatchObject({ targetId: 'intro', domain: 'timeline' });
    });
  });
});

function proposal(roleId: string, edits: ChangeSetProposal['edits']): ChangeSetProposal {
  return {
    roleId,
    capability: 'test.analyse',
    title: roleId,
    findings: [],
    edits,
    estimatedCost: { localOnly: true },
    warnings: [],
  };
}
