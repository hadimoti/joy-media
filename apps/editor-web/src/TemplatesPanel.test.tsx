import { describe, expect, it } from 'vitest';
import {
  createTemplateEntry,
  duplicateTemplate,
  filterTemplateEntries,
  listTemplates,
  removeTemplate,
  saveTemplate,
} from './template-catalog.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('TemplatesPanel surface', () => {
  const entries = [
    { label: 'JOY Title', description: 'Main title', category: 'Titles' },
    { label: 'Lower Third', description: 'Name bar', category: 'Lower Thirds' },
  ] as const;

  it('filters by search text and category without changing source order', () => {
    expect(filterTemplateEntries(entries, 'title')).toEqual([entries[0]]);
    expect(filterTemplateEntries(entries, '', 'Lower Thirds')).toEqual([entries[1]]);
    expect(filterTemplateEntries(entries, 'missing')).toEqual([]);
  });

  it('persists, duplicates, and deletes Mine entries without changing action payloads', () => {
    const storage = memoryStorage();
    const original = createTemplateEntry(
      'Saved title',
      [{ kind: 'html-scene', sceneId: 'joy.firstparty.title' }],
      'Saved from selection',
      'My Templates',
      '2026-01-01T00:00:00.000Z',
    );
    saveTemplate(storage, original);

    const duplicate = duplicateTemplate(storage, original.id, { label: 'Saved title copy' });
    expect(duplicate?.id).not.toBe(original.id);
    expect(duplicate?.actions).toEqual(original.actions);
    expect(listTemplates(storage)).toHaveLength(2);

    removeTemplate(storage, original.id);
    expect(listTemplates(storage).map((entry) => entry.id)).toEqual([duplicate!.id]);
  });
});
