import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { EffectInstanceV1 } from '@joy-media/visual-effects';

export const EFFECT_RECIPE_CATALOG_KEY = 'joy-media.effect-recipe-catalog.v1';
export const EFFECT_RECIPE_PUBLISHED_KEY = 'joy-media.effect-recipe-published.v1';

export interface EffectRecipeDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly durationMs: number;
  readonly effects: readonly EffectInstanceV1[];
  readonly previewSource: {
    readonly kind: 'studio-gradient' | 'selected-object';
    readonly objectId?: string;
  };
}

export interface EffectRecipeCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly effectCount: number;
  readonly publishedAt?: string;
}

interface RecipeDatabase {
  readonly version: 1;
  readonly recipes: Readonly<Record<string, EffectRecipeDocument>>;
}

interface PublishedRecipeDatabase {
  readonly version: 1;
  readonly recipes: Readonly<Record<string, EffectRecipeDocument>>;
}

export function cloneEffectInstances(
  effects: readonly EffectInstanceV1[],
): readonly EffectInstanceV1[] {
  return effects.map((effect) => ({
    ...effect,
    id: crypto.randomUUID(),
    params: { ...effect.params },
    ...(effect.animations !== undefined ? { animations: { ...effect.animations } } : {}),
  }));
}

export function createEffectRecipeDocument(
  name = 'Untitled Effect Recipe',
  effects: readonly EffectInstanceV1[] = [],
  objectId?: string,
  now = new Date().toISOString(),
): EffectRecipeDocument {
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    durationMs: 5_000,
    effects: cloneEffectInstances(effects),
    previewSource:
      objectId === undefined ? { kind: 'studio-gradient' } : { kind: 'selected-object', objectId },
  };
}

export function createEffectRecipe(
  storage: BrowserKeyValueStore,
  name = 'Untitled Effect Recipe',
  effects: readonly EffectInstanceV1[] = [],
  objectId?: string,
): EffectRecipeDocument {
  const document = createEffectRecipeDocument(name, effects, objectId);
  saveEffectRecipe(storage, document);
  return document;
}

export function listEffectRecipes(
  storage: BrowserKeyValueStore,
): readonly EffectRecipeCatalogEntry[] {
  const published = readPublished(storage).recipes;
  return Object.values(readRecipes(storage).recipes)
    .map((recipe) => {
      const publishedRecipe = published[recipe.id];
      return {
        id: recipe.id,
        title: recipe.name,
        createdAt: recipe.createdAt,
        updatedAt: recipe.updatedAt,
        effectCount: recipe.effects.length,
        ...(publishedRecipe !== undefined ? { publishedAt: publishedRecipe.updatedAt } : {}),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadEffectRecipe(
  storage: BrowserKeyValueStore,
  recipeId: string,
): EffectRecipeDocument | undefined {
  return readRecipes(storage).recipes[recipeId];
}

export function saveEffectRecipe(
  storage: BrowserKeyValueStore,
  document: EffectRecipeDocument,
): void {
  if (!isEffectRecipeDocument(document)) {
    throw new TypeError('Invalid effect recipe document');
  }
  const database = readRecipes(storage);
  writeRecipes(storage, {
    version: 1,
    recipes: { ...database.recipes, [document.id]: document },
  });
}

export function duplicateEffectRecipe(
  storage: BrowserKeyValueStore,
  recipeId: string,
  name?: string,
): EffectRecipeDocument | undefined {
  const source = loadEffectRecipe(storage, recipeId);
  if (source === undefined) return undefined;
  const now = new Date().toISOString();
  const duplicate: EffectRecipeDocument = {
    ...source,
    id: crypto.randomUUID(),
    name: name ?? `${source.name} Copy`,
    createdAt: now,
    updatedAt: now,
    effects: cloneEffectInstances(source.effects),
  };
  saveEffectRecipe(storage, duplicate);
  return duplicate;
}

export function removeEffectRecipe(storage: BrowserKeyValueStore, recipeId: string): void {
  const database = readRecipes(storage);
  if (database.recipes[recipeId] === undefined) return;
  const recipes = { ...database.recipes };
  delete recipes[recipeId];
  writeRecipes(storage, { version: 1, recipes });
}

export function publishEffectRecipe(
  storage: BrowserKeyValueStore,
  document: EffectRecipeDocument,
): void {
  saveEffectRecipe(storage, document);
  const database = readPublished(storage);
  writePublished(storage, {
    version: 1,
    recipes: { ...database.recipes, [document.id]: document },
  });
}

export function getPublishedEffectRecipe(
  storage: BrowserKeyValueStore,
  recipeId: string,
): EffectRecipeDocument | undefined {
  return readPublished(storage).recipes[recipeId];
}

function readRecipes(storage: BrowserKeyValueStore): RecipeDatabase {
  return readDatabase(storage.getItem(EFFECT_RECIPE_CATALOG_KEY));
}

function writeRecipes(storage: BrowserKeyValueStore, database: RecipeDatabase): void {
  storage.setItem(EFFECT_RECIPE_CATALOG_KEY, JSON.stringify(database));
}

function readPublished(storage: BrowserKeyValueStore): PublishedRecipeDatabase {
  return readDatabase(storage.getItem(EFFECT_RECIPE_PUBLISHED_KEY));
}

function writePublished(storage: BrowserKeyValueStore, database: PublishedRecipeDatabase): void {
  storage.setItem(EFFECT_RECIPE_PUBLISHED_KEY, JSON.stringify(database));
}

function readDatabase(serialized: string | null): RecipeDatabase {
  if (serialized === null) return { version: 1, recipes: {} };
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.recipes)) {
      return { version: 1, recipes: {} };
    }
    const recipes = Object.fromEntries(
      Object.entries(parsed.recipes).filter(
        ([id, recipe]) => isEffectRecipeDocument(recipe) && recipe.id === id,
      ),
    ) as Record<string, EffectRecipeDocument>;
    return { version: 1, recipes };
  } catch {
    return { version: 1, recipes: {} };
  }
}

export function isEffectRecipeDocument(value: unknown): value is EffectRecipeDocument {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.durationMs !== 'number' ||
    !Array.isArray(value.effects) ||
    !isRecord(value.previewSource)
  ) {
    return false;
  }
  if (
    value.previewSource.kind !== 'studio-gradient' &&
    value.previewSource.kind !== 'selected-object'
  ) {
    return false;
  }
  return value.effects.every(isEffectInstance);
}

function isEffectInstance(value: unknown): value is EffectInstanceV1 {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.effectId === 'string' &&
    typeof value.enabled === 'boolean' &&
    isRecord(value.params)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
