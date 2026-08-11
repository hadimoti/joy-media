import { describe, expect, it } from 'vitest';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { listTemplates } from './template-catalog.js';
import { authorTemplateCopy, deleteTemplateWithConfirmation } from './template-catalog-ui.js';

function memoryStore(): BrowserKeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('template catalog UI operations', () => {
  it('authors a named independent catalog entry from a library template', () => {
    const storage = memoryStore();
    const entry = authorTemplateCopy(
      storage,
      {
        id: 'source',
        label: 'Source',
        description: 'Description',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      '  My title  ',
    );
    expect(entry.label).toBe('My title');
    expect(listTemplates(storage)).toEqual([entry]);
  });

  it('requires confirmation before deleting a catalog entry', () => {
    const storage = memoryStore();
    const entry = authorTemplateCopy(
      storage,
      {
        id: 'source',
        label: 'Source',
        description: '',
        category: 'Titles',
        actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      },
      'My title',
    );
    expect(deleteTemplateWithConfirmation(storage, entry, () => false)).toBe(false);
    expect(listTemplates(storage)).toHaveLength(1);
    expect(deleteTemplateWithConfirmation(storage, entry, () => true)).toBe(true);
    expect(listTemplates(storage)).toHaveLength(0);
  });

  it('rejects a blank authored name', () => {
    const storage = memoryStore();
    expect(() =>
      authorTemplateCopy(
        storage,
        {
          id: 'source',
          label: 'Source',
          description: '',
          category: 'Titles',
          actions: [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
        },
        '   ',
      ),
    ).toThrow('Template name cannot be blank');
  });
});
