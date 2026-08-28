import { describe, expect, it } from 'vitest';
import type { Actor } from './control-plane.js';
import { ProjectIntelligenceService } from './project-intelligence-service.js';
import { ProjectSnapshotService } from './project-snapshot-service.js';
import {
  CanonicalJoyCodeInputResolver,
  type JoyCodeInputResolverRequest,
} from './joy-code-input-resolver.js';
import type { JoyProjectV1 } from '@joy-media/project-schema';

const actor: Actor = { id: 'owner' };
const project: JoyProjectV1 = {
  schemaVersion: 1,
  id: 'project-1',
  title: 'Project',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  rootCompositionId: 'comp-1',
  settings: { defaultLocale: 'en' },
  compositions: {
    'comp-1': {
      id: 'comp-1',
      name: 'Main',
      width: 1920,
      height: 1080,
      pixelAspectRatio: { num: 1, den: 1 },
      frameRate: { num: 30, den: 1 },
      durationUs: 1_000_000,
      background: '#00000000',
      tracks: [],
    },
  },
  assets: {},
  variables: {},
  markers: [],
  visualObjects: {},
  captionDocuments: {},
  pluginData: {},
};
const request: JoyCodeInputResolverRequest = {
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'یک عنوان اضافه کن',
  selection: { clipIds: [] },
};

function reader(kind: 'ready' | 'not-found' = 'ready') {
  return {
    readProjectDocument: async () =>
      kind === 'ready'
        ? {
            kind: 'ready' as const,
            record: {
              projectId: 'project-1',
              ownerId: actor.id,
              revisionId: 'rev-1',
              document: project,
            },
          }
        : { kind: 'not-found' as const, projectId: 'project-1', revisionId: 'rev-1' },
  };
}

describe('Joy Code canonical input resolver', () => {
  it('resolves exact revision into semantic snapshot, intelligence, and code-owned catalogs', async () => {
    const resolver = new CanonicalJoyCodeInputResolver({
      controlPlane: reader(),
      snapshotService: new ProjectSnapshotService({ clock: () => '2026-08-20T00:00:00.000Z' }),
      intelligenceService: new ProjectIntelligenceService(),
      catalogs: {
        textTemplateIds: ['clean-title'],
        captionTemplateIds: ['joy-clean'],
        transitionIds: ['dissolve'],
      },
    });
    const result = await resolver.resolve(request, { actor, controlPlaneProjectId: 'project-1' });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.input.prompt).toBe('یک عنوان اضافه کن');
      expect(result.input.semanticSnapshot).toMatchObject({ revisionId: 'rev-1' });
      expect(result.input.catalogs.transitionIds).toEqual(['dissolve']);
    }
  });
  it('maps missing exact revision to stale-revision without provider activity', async () => {
    const resolver = new CanonicalJoyCodeInputResolver({
      controlPlane: reader('not-found'),
      snapshotService: new ProjectSnapshotService(),
      intelligenceService: new ProjectIntelligenceService(),
      catalogs: { textTemplateIds: [], captionTemplateIds: [], transitionIds: [] },
    });
    await expect(
      resolver.resolve(request, { actor, controlPlaneProjectId: 'project-1' }),
    ).resolves.toMatchObject({ status: 'stale-revision' });
  });
});
