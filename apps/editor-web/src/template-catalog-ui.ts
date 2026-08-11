import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { ContentTemplateV1 } from './content-template-types.js';
import {
  createTemplateEntry,
  removeTemplate,
  saveTemplate,
  type TemplateCatalogEntry,
} from './template-catalog.js';

export function authorTemplateCopy(
  storage: BrowserKeyValueStore,
  template: ContentTemplateV1,
  requestedLabel: string,
): TemplateCatalogEntry {
  const label = requestedLabel.trim();
  if (label === '') throw new TypeError('Template name cannot be blank');
  const entry = createTemplateEntry(
    label,
    template.actions.map((action) => ({ kind: action.kind, sceneId: action.sceneId })),
    template.description,
    template.category,
  );
  saveTemplate(storage, entry);
  return entry;
}

export function deleteTemplateWithConfirmation(
  storage: BrowserKeyValueStore,
  entry: TemplateCatalogEntry,
  confirmDelete: (message: string) => boolean,
): boolean {
  if (!confirmDelete(`Delete “${entry.label}” from My Templates?`)) return false;
  removeTemplate(storage, entry.id);
  return true;
}
