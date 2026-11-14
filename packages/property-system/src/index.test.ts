import { describe, expect, it } from 'vitest';
import {
  applyVisualObjectCommand,
  applyVisualObjectProjectCommand,
  applyVisualObjectProjectTransaction,
  applyVisualObjectTransaction,
  setVisualProperty,
  validateVisualObjectProject,
  VISUAL_INSPECTOR,
  sharedValue,
} from './index.js';
import { createIdentityColorGrade, migrateV0ToV1 } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
describe('visual property schemas', () => {
  it('covers transform, opacity, and crop without per-object forms', () => {
    expect(VISUAL_INSPECTOR.map((field) => field.key)).toEqual([
      'x',
      'y',
      'scaleX',
      'scaleY',
      'rotationDeg',
      'opacity',
      'crop',
    ]);
    expect(sharedValue([1, 1])).toBe(1);
    expect(sharedValue([1, 2])).toBeUndefined();
  });
  it('updates only selected visual objects with bounded values', () => {
    const object = {
      id: 'a',
      kind: 'shape',
      shape: 'rectangle',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 0,
        opacity: 1,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    } as const;
    expect(setVisualProperty([object], ['a'], 'opacity', 0.5)[0]!.transform.opacity).toBe(0.5);
    expect(() => setVisualProperty([object], ['a'], 'opacity', 2)).toThrow(/opacity/);
  });
  it('creates semantic inverses for durable object property changes', () => {
    const object = {
      id: 'a',
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
    } as const;
    const applied = applyVisualObjectCommand([object], {
      type: 'object.setTransformProperty',
      payload: { objectId: 'a', key: 'rotationDeg', value: 45 },
    });
    expect(applied.objects[0]!.transform.rotationDeg).toBe(45);
    expect(applyVisualObjectCommand(applied.objects, applied.inverse).objects).toEqual([object]);
  });
  it('applies serializable object transactions and validates project identity', () => {
    const project = {
      schemaVersion: 1,
      id: 'objects',
      objects: [
        {
          id: 'a',
          kind: 'shape',
          shape: 'rectangle',
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
    } as const;
    expect(
      applyVisualObjectTransaction(project, {
        label: 'Fade',
        commands: [
          {
            type: 'object.setTransformProperty',
            payload: { objectId: 'a', key: 'opacity', value: 0.5 },
          },
        ],
      }).objects[0]!.transform.opacity,
    ).toBe(0.5);
    expect(validateVisualObjectProject(project)).toEqual([]);
  });
  it('writes visual-object edits into the durable v1 project document', () => {
    const migrated = migrateV0ToV1(emptySpikeProject());
    const object = {
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
    } as const;
    const project = { ...migrated.project, visualObjects: { title: object } };
    const updated = applyVisualObjectProjectTransaction(project, {
      label: 'Move title',
      commands: [
        {
          type: 'object.setTransformProperty',
          payload: { objectId: 'title', key: 'x', value: 12 },
        },
      ],
    });
    expect(updated.visualObjects.title!.transform.x).toBe(12);
    expect(project.visualObjects.title!.transform.x).toBe(0);
  });
  it('applies and reverses a full output color grade command', () => {
    const migrated = migrateV0ToV1(emptySpikeProject());
    const project = migrated.project;
    const identity = createIdentityColorGrade();
    const grade = {
      ...identity,
      adjust: {
        ...identity.adjust!,
        temperature: 0.4,
        tint: -0.2,
        exposure: 1,
        contrast: 0.3,
        pivot: 0.65,
        highlights: 0.35,
        shadows: -0.25,
        whites: 0.45,
        blacks: -0.4,
        saturation: 1.4,
        vibrance: 0.5,
        hue: 45,
      },
      lut: { builtIn: 'warm-cinema' as const, intensity: 0.6 },
    };
    const applied = applyVisualObjectProjectCommand(project, {
      type: 'color.setGrade',
      payload: { target: { scope: 'output' }, grade },
    });
    expect(applied.project.colorGrade).toEqual(grade);
    expect(
      applyVisualObjectProjectCommand(applied.project, applied.inverse).project.colorGrade,
    ).toBeUndefined();
  });

  /** Two grades that both carry values, so the undo has something real to restore. */
  function gradesWithValues() {
    const identity = createIdentityColorGrade();
    const before = {
      ...identity,
      adjust: { ...identity.adjust!, temperature: 0.2, saturation: 1.2 },
      lut: { builtIn: 'cool-fade' as const, intensity: 0.5 },
    };
    const after = {
      ...identity,
      adjust: { ...identity.adjust!, temperature: -0.3, exposure: 0.8, hue: 30 },
      lut: { builtIn: 'monochrome' as const, intensity: 0.9 },
    };
    return { before, after };
  }

  it('undoes and redoes an output grade change over a grade that already had values', () => {
    const { before, after } = gradesWithValues();
    const start = { ...migrateV0ToV1(emptySpikeProject()).project, colorGrade: before };
    const changed = applyVisualObjectProjectCommand(start, {
      type: 'color.setGrade',
      payload: { target: { scope: 'output' }, grade: after },
    });
    expect(changed.project.colorGrade).toEqual(after);

    // Undo restores the grade the colourist had, not the identity grade.
    const undone = applyVisualObjectProjectCommand(changed.project, changed.inverse);
    expect(undone.project.colorGrade).toEqual(before);

    // Redo is the inverse of that undo: it puts the changed grade back.
    const redone = applyVisualObjectProjectCommand(undone.project, undone.inverse);
    expect(redone.project.colorGrade).toEqual(after);
  });

  it('undoes and redoes a clip grade change over a clip grade that already had values', () => {
    const { before, after } = gradesWithValues();
    const spike = emptySpikeProject();
    const root = spike.compositions[spike.rootCompositionId]!;
    const [firstTrack, ...otherTracks] = root.tracks;
    const withClip = {
      ...spike,
      compositions: {
        [root.id]: {
          ...root,
          tracks: [
            {
              ...firstTrack!,
              clips: [...firstTrack!.clips, makeVideoClip('clip-1', 0, 1_000_000)],
            },
            ...otherTracks,
          ],
        },
      },
    };
    const start = { ...migrateV0ToV1(withClip).project, clipColorGrades: { 'clip-1': before } };
    const target = { scope: 'clip' as const, clipId: 'clip-1' };
    const changed = applyVisualObjectProjectCommand(start, {
      type: 'color.setGrade',
      payload: { target, grade: after },
    });
    expect(changed.project.clipColorGrades?.['clip-1']).toEqual(after);

    const undone = applyVisualObjectProjectCommand(changed.project, changed.inverse);
    expect(undone.project.clipColorGrades?.['clip-1']).toEqual(before);

    const redone = applyVisualObjectProjectCommand(undone.project, undone.inverse);
    expect(redone.project.clipColorGrades?.['clip-1']).toEqual(after);
  });
});
