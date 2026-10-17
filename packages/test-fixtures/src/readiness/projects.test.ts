import {
  migrateToLatest,
  migrateV0ToV1,
  validateJoyProjectV1,
  validateJoyProjectV3,
} from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import {
  buildBasicAvDeliveryProject,
  buildGapsParallelTracksProject,
  buildHistoricalSchemaProjects,
  buildKitchenSinkSupportedProject,
  buildMissingRelinkedAssetsProject,
  buildPersianRtlProject,
  buildTenThousandClipProject,
  READINESS_TOLERANCES,
} from '../index.js';

describe('readiness project builders', () => {
  it('builds a valid basic audio/video delivery project', () => {
    const project = buildBasicAvDeliveryProject();
    expect(validateJoyProjectV1(project)).toEqual([]);
    const composition = project.compositions[project.rootCompositionId]!;
    expect(composition.tracks.map((track) => track.kind)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
    expect(Object.values(project.assets).map((asset) => asset.kind)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
    expect(composition.tracks.flatMap((track) => track.clips)).toHaveLength(2);
  });

  it('contains visible gaps and overlapping clips on parallel tracks', () => {
    const project = buildGapsParallelTracksProject();
    expect(validateJoyProjectV1(project)).toEqual([]);
    const tracks = project.compositions[project.rootCompositionId]!.tracks;
    const firstTrack = tracks[0]!.clips;
    const secondTrack = tracks[1]!.clips;
    expect(firstTrack).toHaveLength(2);
    expect(firstTrack[0]!.startUs + firstTrack[0]!.durationUs).toBeLessThan(firstTrack[1]!.startUs);
    expect(secondTrack[0]!.startUs).toBeLessThan(
      firstTrack[0]!.startUs + firstTrack[0]!.durationUs,
    );
  });

  it('covers supported editor domains without bypassing project validation', () => {
    const project = buildKitchenSinkSupportedProject();
    expect(validateJoyProjectV1(project)).toEqual([]);
    expect(Object.keys(project.visualObjects).length).toBeGreaterThan(0);
    expect(Object.keys(project.captionDocuments).length).toBeGreaterThan(0);
    expect(project.audio?.clips).toBeDefined();
    expect(project.colorGrade).toBeDefined();
    expect(project.transitions?.length).toBeGreaterThan(0);
    expect(Object.keys(project.propertyAnimations ?? {})).toHaveLength(9);
  });

  it('preserves Persian text and RTL direction in a valid caption document', () => {
    const project = buildPersianRtlProject();
    expect(validateJoyProjectV1(project)).toEqual([]);
    const document = Object.values(project.captionDocuments).find(
      (candidate) => candidate.language === 'fa',
    );
    expect(document?.direction).toBe('rtl');
    expect(
      Object.values(document?.words ?? {}).some((word) => /[\u0600-\u06ff]/u.test(word.text)),
    ).toBe(true);
  });

  it('provides every supported historical project schema with an idempotent latest migration', () => {
    const projects = buildHistoricalSchemaProjects();
    expect(projects.v0.schemaVersion).toBe(0);
    expect(projects.v1.schemaVersion).toBe(1);
    expect(projects.v2.schemaVersion).toBe(2);
    expect(projects.v3.schemaVersion).toBe(3);
    const latest = [
      migrateToLatest(migrateV0ToV1(projects.v0).project),
      migrateToLatest(projects.v1),
      migrateToLatest(projects.v2),
      migrateToLatest(projects.v3),
    ];
    expect(latest.map((project) => project.schemaVersion)).toEqual([3, 3, 3, 3]);
    for (const project of latest) {
      expect(validateJoyProjectV3(project)).toEqual([]);
      expect(migrateToLatest(project)).toBe(project);
    }
  });

  it('models a missing source and an explicit relink without changing clip identity or timing', () => {
    const fixture = buildMissingRelinkedAssetsProject();
    expect(fixture.missingPath).not.toBe(fixture.relinkedPath);
    expect(validateJoyProjectV1(fixture.missingProject)).toEqual([]);
    expect(validateJoyProjectV1(fixture.relinkedProject)).toEqual([]);
    expect(fixture.missingProject).toEqual(fixture.relinkedProject);
    expect(fixture.missingSources[fixture.assetId]).toBe(fixture.missingPath);
    expect(fixture.relinkedSources[fixture.assetId]).toBe(fixture.relinkedPath);
    expect(fixture.missingSources).not.toEqual(fixture.relinkedSources);
    const clips = (project: typeof fixture.missingProject) =>
      project.compositions[project.rootCompositionId]!.tracks.flatMap((track) => track.clips);
    expect(clips(fixture.missingProject)).toEqual(clips(fixture.relinkedProject));
    expect(clips(fixture.missingProject)[0]).toMatchObject({ assetId: fixture.assetId });
    expect(fixture.missingProject.assets[fixture.assetId]?.sha256).toBe(
      fixture.relinkedProject.assets[fixture.assetId]?.sha256,
    );
  });

  it('builds the full 10,000-clip scale profile without creating media assets', () => {
    const project = buildTenThousandClipProject();
    expect(project.compositions[project.rootCompositionId]!.tracks).toHaveLength(100);
    expect(
      project.compositions[project.rootCompositionId]!.tracks.reduce(
        (total, track) => total + track.clips.length,
        0,
      ),
    ).toBe(10_000);
    expect(READINESS_TOLERANCES).toMatchObject({
      durationFrames: 1,
      syncFrames: 1,
      normalizedPcmRmsAbsolute: 0.02,
    });
    expect(
      Object.keys(project.compositions[project.rootCompositionId]!.tracks[0]!.clips[0]!).sort(),
    ).toEqual(['assetId', 'durationUs', 'id', 'kind', 'sourceInUs', 'startUs'].sort());
  });
});
