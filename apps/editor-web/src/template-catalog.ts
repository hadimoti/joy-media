/**
 * Template catalog — localStorage-backed user template storage.
 *
 * Mirrors the localStorage catalog pattern from `effect-recipe-catalog.ts` and
 * `motion-scene-catalog.ts`. Stores user-saved content templates under
 * `joy-media.template-catalog.v1`.
 *
 * The catalog does NOT store the full template definition — only the user's
 * customizations (label, description, category). The actions are stored as
 * references to first-party scene IDs or, in the future, custom compositions.
 */

import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

export const TEMPLATE_CATALOG_KEY = 'joy-media.template-catalog.v1';

export interface TemplateCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly previewAssetId?: string;
  /** Ordered list of action kinds + references to apply */
  readonly actions: readonly ContentTemplateActionRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ContentTemplateActionRef =
  | { readonly kind: 'html-scene'; readonly sceneId: string }
  | { readonly kind: 'sticker-pack'; readonly assetIds: readonly string[] };

interface CatalogDatabase {
  readonly version: 1;
  readonly templates: Readonly<Record<string, TemplateCatalogEntry>>;
}

export function listTemplates(storage: BrowserKeyValueStore): readonly TemplateCatalogEntry[] {
  const db = readCatalog(storage);
  return Object.values(db.templates).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTemplate(
  storage: BrowserKeyValueStore,
  id: string,
): TemplateCatalogEntry | undefined {
  return readCatalog(storage).templates[id];
}

export function saveTemplate(storage: BrowserKeyValueStore, entry: TemplateCatalogEntry): void {
  if (!isTemplateCatalogEntry(entry)) {
    throw new TypeError('Invalid template catalog entry');
  }
  const db = readCatalog(storage);
  writeCatalog(storage, {
    version: 1,
    templates: { ...db.templates, [entry.id]: entry },
  });
}

export function removeTemplate(storage: BrowserKeyValueStore, id: string): void {
  const db = readCatalog(storage);
  if (db.templates[id] === undefined) return;
  const templates = { ...db.templates };
  delete templates[id];
  writeCatalog(storage, { version: 1, templates });
}

export function duplicateTemplate(
  storage: BrowserKeyValueStore,
  id: string,
  overrides?: Partial<Pick<TemplateCatalogEntry, 'label' | 'description'>>,
): TemplateCatalogEntry | undefined {
  const source = getTemplate(storage, id);
  if (source === undefined) return undefined;
  const now = new Date().toISOString();
  const duplicate: TemplateCatalogEntry = {
    ...source,
    id: crypto.randomUUID(),
    label: overrides?.label ?? `${source.label} Copy`,
    description: overrides?.description ?? source.description,
    createdAt: now,
    updatedAt: now,
  };
  saveTemplate(storage, duplicate);
  return duplicate;
}

export function createTemplateEntry(
  label: string,
  actions: readonly ContentTemplateActionRef[],
  description = '',
  category = 'My Templates',
  now = new Date().toISOString(),
): TemplateCatalogEntry {
  return {
    id: crypto.randomUUID(),
    label,
    description,
    category,
    actions,
    createdAt: now,
    updatedAt: now,
  };
}

function readCatalog(storage: BrowserKeyValueStore): CatalogDatabase {
  const raw = storage.getItem(TEMPLATE_CATALOG_KEY);
  if (raw === null) return { version: 1, templates: {} };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.templates)) {
      return { version: 1, templates: {} };
    }
    const templates = Object.fromEntries(
      Object.entries(parsed.templates as Record<string, unknown>).filter(
        ([id, entry]) => isTemplateCatalogEntry(entry) && entry.id === id,
      ),
    ) as Readonly<Record<string, TemplateCatalogEntry>>;
    return { version: 1, templates };
  } catch {
    return { version: 1, templates: {} };
  }
}

function writeCatalog(storage: BrowserKeyValueStore, db: CatalogDatabase): void {
  storage.setItem(TEMPLATE_CATALOG_KEY, JSON.stringify(db));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTemplateCatalogEntry(value: unknown): value is TemplateCatalogEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.description === 'string' &&
    typeof value.category === 'string' &&
    Array.isArray(value.actions) &&
    value.actions.every(isActionRef) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function isActionRef(value: unknown): value is ContentTemplateActionRef {
  if (!isRecord(value)) return false;
  if (value.kind === 'html-scene') {
    return typeof value.sceneId === 'string';
  }
  if (value.kind === 'sticker-pack') {
    return Array.isArray(value.assetIds) && value.assetIds.every((id) => typeof id === 'string');
  }
  return false;
}
