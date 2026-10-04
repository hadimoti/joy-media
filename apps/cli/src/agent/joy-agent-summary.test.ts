import { describe, expect, it } from 'vitest';
import type { CaptionClipV1, TrackV1 } from '@joy-media/project-schema';
import { createDefaultProject } from '../utils/project-loader.js';
import { createTextClip } from '../render/text-clip.js';
import { missingOperationCoverage, verifyPlanChecklist, verifyRequestIntent } from './joy-agent.js';
import { truthfulAgentSummary } from './joy-agent.js';

function addCaptionTrack(project: ReturnType<typeof createDefaultProject>, clips: CaptionClipV1[]) {
  const root = project.compositions.root!;
  const track: TrackV1 = {
    id: `captions-${root.tracks.length}`,
    kind: 'caption',
    family: 'visual',
    name: 'Captions',
    order: root.tracks.length,
    enabled: true,
    locked: false,
    clips,
  };
  (root.tracks as unknown as TrackV1[]).push(track);
}

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

  it('requires model checklist coverage for operation types unless user intent covers them', () => {
    const staged = {
      timelineOps: [
        {
          kind: 'trim' as const,
          id: 'trim-1',
          clipId: 'clip-1',
          sourceInUs: 0,
          sourceOutUs: 1_000_000,
          dependsOn: [],
        },
      ],
      documentOps: [],
    };
    expect(missingOperationCoverage(staged, [], 'make an edit')).toEqual([
      'Checklist not verified: checklist is empty',
      'Checklist not verified: no check covers operation type trim',
    ]);
    expect(missingOperationCoverage(staged, [], 'trim from 7 s to 17 s')).toEqual([
      'Checklist not verified: checklist is empty',
    ]);
    expect(
      missingOperationCoverage(
        {
          timelineOps: [
            {
              kind: 'move',
              id: 'move-1',
              clipId: 'clip-1',
              trackId: 'video',
              startUs: 0,
              dependsOn: [],
            },
          ],
          documentOps: [],
        },
        [{ kind: 'text', text: 'Title', position: 'center' }],
        'start the clip at 0',
      ),
    ).toEqual([]);
  });

  it('checks explicit request intent independently of the model checklist', () => {
    const project = createDefaultProject('intent', { id: 'intent-project' });
    (project.compositions.root as unknown as { durationUs: number }).durationUs = 10_000_000;
    const track = project.compositions.root!.tracks[0]!;
    (track.clips as unknown as Array<any>).push({
      id: 'clip',
      kind: 'video',
      assetId: 'asset-default',
      startUs: 0,
      durationUs: 10_000_000,
      sourceInUs: 7_000_000,
      look: { preset: 'bw' },
    });
    (project.visualObjects as Record<string, any>).title = {
      id: 'title',
      kind: 'text',
      text: 'Title',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    };
    const captionTitle = createTextClip({
      id: 'caption-title',
      text: 'Title',
      startUs: 0,
      durationUs: 2_000_000,
    });
    (project.captionDocuments as Record<string, any>)[captionTitle.document.id] =
      captionTitle.document;
    addCaptionTrack(project, [captionTitle.clip]);
    const request =
      'Center the title, start a clip at 0, trim it from 7 s to 17 s, make it black and white, and make the output 10 seconds long';
    expect(verifyRequestIntent(project, request)).toMatchObject({
      verified: expect.arrayContaining([
        'Request: centered text',
        'Request: clip starts at 0',
        'Request: source trim 7000000–17000000 µs',
        'Request: bw look',
        'Request: duration 10000000 µs',
      ]),
      unmet: [],
    });
    const empty = createDefaultProject('empty', { id: 'empty' });
    (empty.compositions.root as unknown as { durationUs: number }).durationUs = 0;
    const failed = verifyRequestIntent(empty, request);
    expect(failed.unmet).toHaveLength(5);
  });

  it('verifies centered caption clips from renderer layout instead of visualObjects', () => {
    const project = createDefaultProject('caption intent', { id: 'caption-intent-project' });
    const title = createTextClip({ id: 'title', text: 'Hello', startUs: 0, durationUs: 2_000_000 });
    (project.captionDocuments as Record<string, any>)[title.document.id] = title.document;
    addCaptionTrack(project, [title.clip]);

    expect(verifyRequestIntent(project, 'add a centred title "Hello"')).toMatchObject({
      verified: ['Request: centered text'],
      unmet: [],
    });
    expect(verifyRequestIntent(project, 'put the title in the middle')).toEqual({
      verified: [],
      unmet: ['request asked for centered text'],
    });

    const offCenterProject = createDefaultProject('off-center caption', {
      id: 'off-center-project',
    });
    const offCenter = createTextClip({
      id: 'off-center',
      text: 'Hello',
      startUs: 0,
      durationUs: 2_000_000,
      x: 0.2,
    });
    (offCenterProject.captionDocuments as Record<string, any>)[offCenter.document.id] =
      offCenter.document;
    addCaptionTrack(offCenterProject, [offCenter.clip]);
    const failed = verifyRequestIntent(offCenterProject, 'add a centred title "Hello"');
    expect(failed.verified).toEqual([]);
    expect(failed.unmet).toEqual(['request asked for centered text']);
  });

  it('does not interpret arbitrary timing language as a trim request', () => {
    const project = createDefaultProject('timing intent', { id: 'timing-intent-project' });
    expect(verifyRequestIntent(project, 'title Hello from 2 to 5 seconds')).toEqual({
      verified: [],
      unmet: [],
    });
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
