import { describe, expect, it } from 'vitest';
import type { JoyProjectV1, VisualObjectV1 } from '@joy-media/project-schema';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { buildDualLensProjection } from './dual-lens-model.js';
import { objectDisplayLabel, objectDisplayLabels } from './object-display-label.js';
import { bindClipToObject } from './sticker-bindings.js';

const transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

describe('visible object names (Motion target, Agent picker, parent picker)', () => {
  it('names a text object by its text and any other object by its kind', () => {
    const text: VisualObjectV1 = { id: 'vo-901', kind: 'text', text: '  Hello  ', transform };
    const picture: VisualObjectV1 = { id: 'vo-902', kind: 'image', transform };
    const nullObject: VisualObjectV1 = { id: 'vo-903', kind: 'null', transform };

    expect(objectDisplayLabel(text)).toBe('Hello');
    expect(objectDisplayLabel(picture)).toBe('Picture');
    expect(objectDisplayLabel(nullObject)).toBe('Null');
  });

  it('numbers objects that would read the same, and never shows an id', () => {
    const objects: VisualObjectV1[] = [
      { id: 'vo-911', kind: 'image', transform },
      { id: 'vo-912', kind: 'image', transform },
      { id: 'vo-913', kind: 'text', text: 'Title', transform },
    ];
    const labels = objectDisplayLabels(objects);

    expect(labels.get('vo-911')).toBe('Picture 1');
    expect(labels.get('vo-912')).toBe('Picture 2');
    expect(labels.get('vo-913')).toBe('Title');
    for (const label of labels.values()) expect(label).not.toMatch(/vo-9/);
  });

  it('never gives two objects the same label, even when a text object already reads "Picture 1"', () => {
    const objects: VisualObjectV1[] = [
      { id: 'vo-921', kind: 'image', transform },
      { id: 'vo-922', kind: 'text', text: 'Picture 1', transform },
      { id: 'vo-923', kind: 'image', transform },
    ];
    const labels = objectDisplayLabels(objects);

    // The text object keeps its own name; the pictures skip the number it uses.
    expect(labels.get('vo-922')).toBe('Picture 1');
    expect(labels.get('vo-921')).toBe('Picture 2');
    expect(labels.get('vo-923')).toBe('Picture 3');
    expect(new Set(labels.values()).size).toBe(objects.length);
  });

  it('keeps labels distinct when two text objects share a numbered name', () => {
    const objects: VisualObjectV1[] = [
      { id: 'vo-931', kind: 'text', text: 'Picture 1', transform },
      { id: 'vo-932', kind: 'text', text: 'Picture 1', transform },
      { id: 'vo-933', kind: 'image', transform },
    ];
    const labels = objectDisplayLabels(objects);

    expect(new Set(labels.values()).size).toBe(objects.length);
    expect(labels.get('vo-933')).toBe('Picture');
  });
});

describe('visible clip names in Dual Lens', () => {
  it('shows no raw clip id on any node or lane item', () => {
    const project = buildReferenceSpikeProject();
    const root = project.compositions[project.rootCompositionId]!;
    const clipIds = new Set(root.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    expect(clipIds.size).toBeGreaterThan(0);

    const projection = buildDualLensProjection(project, INITIAL_EDITOR_PROJECT, 5_000_000, []);
    const visibleLabels = [
      ...projection.nodes.map((node) => node.label),
      ...projection.lanes.flatMap((lane) => lane.items.map((item) => item.label)),
    ];
    // Compared case-insensitively: a title-cased id ("Intro") is still the id.
    for (const label of visibleLabels) {
      expect(clipIds.has(label.toLowerCase())).toBe(false);
    }
  });

  it('names a visual node by its object kind, never by the object id', () => {
    const project = buildReferenceSpikeProject();
    const root = project.compositions[project.rootCompositionId]!;
    const clip = root.tracks.flatMap((track) => track.clips)[0]!;
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const withObject: JoyProjectV1 = {
      ...bindClipToObject(INITIAL_EDITOR_PROJECT, clip.id, 'vo-visual-7'),
      visualObjects: {
        ...INITIAL_EDITOR_PROJECT.visualObjects,
        'vo-visual-7': { id: 'vo-visual-7', kind: 'image', transform },
      },
    };

    const projection = buildDualLensProjection(project, withObject, 0, []);
    const visual = projection.nodes.find((node) => node.id === 'visual:vo-visual-7');

    expect(visual?.label).toBe('Picture');
  });

  it('names an audio lane item "Audio N" when its clip has no media name', () => {
    const project = buildReferenceSpikeProject();
    const withAudio: JoyProjectV1 = {
      ...INITIAL_EDITOR_PROJECT,
      audio: {
        clips: { 'voice-unplaced': { gain: 1, pan: 0, mute: false, solo: false } },
        buses: [],
        effects: [],
      },
    };

    const projection = buildDualLensProjection(project, withAudio, 0, []);
    const audioLane = projection.lanes.find((lane) => lane.id === 'data:audio');

    expect(audioLane?.items.map((item) => item.label)).toEqual(['Audio 1']);
  });
});
