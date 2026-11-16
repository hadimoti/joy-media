import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { lookEntityOptions } from './look-entities.js';

const transform = {
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  opacity: 1,
} as never;

function project(): Pick<JoyProjectV1, 'visualObjects' | 'compositions'> {
  return {
    visualObjects: {
      'vo-1': { id: 'vo-1', kind: 'text', text: 'A Better Story', transform },
      'vo-2': { id: 'vo-2', kind: 'null', transform },
      'vo-3': { id: 'vo-3', kind: 'image', transform },
    },
    compositions: {
      root: {
        id: 'root',
        tracks: [
          { id: 't', kind: 'caption', clips: [{ id: 'cap-1' }, { id: 'cap-2' }] },
          { id: 'v', kind: 'video', clips: [] },
        ],
      },
    },
  } as never;
}

describe('lookEntityOptions', () => {
  it('offers text and picture objects and caption clips, never a Null object', () => {
    const options = lookEntityOptions(project());
    expect(options.map((option) => option.id)).toEqual(['vo-1', 'vo-3', 'cap-1', 'cap-2']);
    expect(options.some((option) => option.label === 'Null')).toBe(false);
  });

  it('names caption clips by their order, never by id', () => {
    const captions = lookEntityOptions(project()).filter(
      (option) => option.kind === 'caption-clip',
    );
    expect(captions.map((option) => option.label)).toEqual(['Caption 1', 'Caption 2']);
  });
});
