import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../utils/project-loader.js';
import { createTextClip } from '../render/text-clip.js';
import { verifyPlanChecklist } from './joy-agent.js';
import { truthfulAgentSummary } from './joy-agent.js';

describe('truthfulAgentSummary', () => {
  it('verifies trim, centered text and look outcomes against the final project', () => {
    const project = createDefaultProject('checklist', { id: 'checklist-project' });
    const track = project.compositions.root!.tracks[0]!;
    const clips = track.clips as unknown as Array<any>;
    clips.push({
      id: 'trimmed',
      kind: 'video',
      assetId: 'asset-default',
      startUs: 0,
      durationUs: 10_000_000,
      sourceInUs: 7_000_000,
      look: { preset: 'crt' },
    });
    const text = createTextClip({
      id: 'center-title',
      text: 'A title',
      startUs: 0,
      durationUs: 2_000_000,
    });
    (project.captionDocuments as Record<string, any>)[text.document.id] = text.document;
    clips.push(text.clip);
    const checklist = [
      { kind: 'trim' as const, clipId: 'trimmed', sourceInUs: 7_000_000, sourceOutUs: 17_000_000 },
      { kind: 'text' as const, text: 'A title', position: 'center' as const },
      { kind: 'look' as const, clipId: 'trimmed', look: 'crt' as const },
    ];
    expect(verifyPlanChecklist(project, checklist)).toMatchObject({
      verified: expect.arrayContaining([
        'Trim trimmed: source 7000000–17000000 µs',
        'Look trimmed: crt',
      ]),
      unmet: [],
    });
  });

  it('reports unmet checklist items instead of claiming they were verified', () => {
    const project = createDefaultProject('checklist', { id: 'empty-checklist-project' });
    expect(verifyPlanChecklist(project, [{ kind: 'look', clipId: 'missing', look: 'bw' }])).toEqual(
      {
        verified: [],
        unmet: ['look bw on clip missing'],
      },
    );
  });

  it('maps applied operations by id when an earlier proposal failed', () => {
    const summary = truthfulAgentSummary({
      applyRequested: true,
      applied: true,
      appliedCount: 1,
      appliedOperationIds: ['third-op'],
      errors: [],
      notes: [],
      staged: {
        timelineOps: [
          { kind: 'remove', id: 'first-op', clipId: 'missing', dependsOn: [] },
          { kind: 'remove', id: 'middle-op', clipId: 'also-missing', dependsOn: [] },
          { kind: 'remove', id: 'third-op', clipId: 'present', dependsOn: [] },
        ],
        documentOps: [],
      },
    });

    expect(summary).toBe('Applied 1 change(s): remove (third-op).');
  });

  it('does not print an empty operation list when the applied ids are absent', () => {
    const summary = truthfulAgentSummary({
      applyRequested: true,
      applied: true,
      appliedCount: 1,
      appliedOperationIds: [],
      errors: [],
      notes: [],
      staged: { timelineOps: [], documentOps: [] },
    });
    expect(summary).toBe('Applied 1 change(s).');
  });
});
