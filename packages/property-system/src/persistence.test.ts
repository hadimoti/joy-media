import { describe, expect, it } from 'vitest';
import { InMemoryProjectStore, LocalProjectPersistence } from '@joy-media/project-persistence';
import { applyVisualObjectTransaction, validateVisualObjectProject } from './index.js';
import type { VisualObjectProject, VisualObjectTransaction } from './index.js';

const project: VisualObjectProject = {
  schemaVersion: 1,
  id: 'objects',
  objects: [
    {
      id: 'title',
      kind: 'text',
      text: 'JOY',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    },
  ],
};
describe('visual object persistence', () => {
  it('reopens a durable Inspector transaction from snapshot plus log', () => {
    const persistence = new LocalProjectPersistence(
      new InMemoryProjectStore<VisualObjectProject, VisualObjectTransaction>(),
      {
        projectId: (value) => value.id,
        schemaVersion: (value) => value.schemaVersion,
        validate: validateVisualObjectProject,
        apply: applyVisualObjectTransaction,
      },
    );
    persistence.initialize(project);
    const changed = persistence.saveTransaction(
      project,
      {
        label: 'Rotate title',
        commands: [
          {
            type: 'object.setTransformProperty',
            payload: { objectId: 'title', key: 'rotationDeg', value: 30 },
          },
        ],
      },
      true,
    );
    expect(persistence.recover(project.id)).toMatchObject({ project: changed, revision: 1 });
  });
});
