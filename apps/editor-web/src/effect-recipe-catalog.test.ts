import { describe, expect, it } from 'vitest';
import {
  createEffectRecipe,
  duplicateEffectRecipe,
  getPublishedEffectRecipe,
  listEffectRecipes,
  loadEffectRecipe,
  publishEffectRecipe,
  removeEffectRecipe,
  UNTITLED_EFFECT_RECIPE_NAME,
} from './effect-recipe-catalog.js';

class MemoryStorage {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe('effect recipe catalog', () => {
  it('reuses one untouched untitled draft per preview context', () => {
    const storage = new MemoryStorage();
    const first = createEffectRecipe(storage);
    const second = createEffectRecipe(storage);

    expect(first.id).toBe(second.id);
    expect(first.name).toBe(UNTITLED_EFFECT_RECIPE_NAME);
    expect(listEffectRecipes(storage)).toHaveLength(1);

    const selected = createEffectRecipe(storage, UNTITLED_EFFECT_RECIPE_NAME, [], 'object-1');
    const selectedAgain = createEffectRecipe(storage, UNTITLED_EFFECT_RECIPE_NAME, [], 'object-1');
    expect(selectedAgain.id).toBe(selected.id);
    expect(listEffectRecipes(storage)).toHaveLength(2);
  });

  it('creates, lists, publishes, duplicates, and removes recipes', () => {
    const storage = new MemoryStorage();
    const recipe = createEffectRecipe(storage, 'Neon Room', [
      {
        id: 'source-effect',
        effectId: 'bloom',
        enabled: true,
        params: { amount: 0.6 },
      },
    ]);

    expect(recipe.effects[0]?.id).not.toBe('source-effect');
    expect(loadEffectRecipe(storage, recipe.id)?.name).toBe('Neon Room');
    expect(listEffectRecipes(storage)[0]).toMatchObject({
      title: 'Neon Room',
      effectCount: 1,
    });

    publishEffectRecipe(storage, recipe);
    expect(getPublishedEffectRecipe(storage, recipe.id)?.effects).toHaveLength(1);
    expect(listEffectRecipes(storage)[0]?.publishedAt).toBeDefined();

    const duplicate = duplicateEffectRecipe(storage, recipe.id);
    expect(duplicate?.name).toBe('Neon Room Copy');
    expect(duplicate?.effects[0]?.id).not.toBe(recipe.effects[0]?.id);
    expect(listEffectRecipes(storage)).toHaveLength(2);

    removeEffectRecipe(storage, recipe.id);
    expect(loadEffectRecipe(storage, recipe.id)).toBeUndefined();
    expect(listEffectRecipes(storage)).toHaveLength(1);
  });

  it('recovers safely from malformed storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('joy-media.effect-recipe-catalog.v1', '{broken');
    expect(listEffectRecipes(storage)).toEqual([]);
  });
});
