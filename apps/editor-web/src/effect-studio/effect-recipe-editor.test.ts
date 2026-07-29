import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltins } from '@joy-media/visual-effects';
import { createEffectRecipeDocument } from '../effect-recipe-catalog.js';
import { createEffectRecipeEditorState, reduceEffectRecipeEditor } from './effect-recipe-editor.js';

beforeAll(() => {
  try {
    registerBuiltins();
  } catch {
    // App-level tests may have registered the singleton catalog already.
  }
});

describe('effect recipe editor', () => {
  it('supports stack edits with undo and redo', () => {
    let state = createEffectRecipeEditorState(createEffectRecipeDocument('Recipe'));
    state = reduceEffectRecipeEditor(state, { type: 'add', effectId: 'bloom' });
    const bloomId = state.document.effects[0]!.id;
    state = reduceEffectRecipeEditor(state, {
      type: 'setParam',
      effectInstanceId: bloomId,
      paramKey: 'amount',
      value: 0.9,
    });
    state = reduceEffectRecipeEditor(state, { type: 'add', effectId: 'noise' });
    state = reduceEffectRecipeEditor(state, {
      type: 'move',
      effectInstanceId: state.document.effects[1]!.id,
      direction: -1,
    });

    expect(state.document.effects.map((effect) => effect.effectId)).toEqual(['noise', 'bloom']);
    expect(state.document.effects[1]?.params.amount).toBe(0.9);

    state = reduceEffectRecipeEditor(state, { type: 'undo' });
    expect(state.document.effects.map((effect) => effect.effectId)).toEqual(['bloom', 'noise']);
    state = reduceEffectRecipeEditor(state, { type: 'redo' });
    expect(state.document.effects.map((effect) => effect.effectId)).toEqual(['noise', 'bloom']);
  });

  it('duplicates instances without sharing identity', () => {
    let state = createEffectRecipeEditorState(createEffectRecipeDocument('Recipe'));
    state = reduceEffectRecipeEditor(state, { type: 'add', effectId: 'vignette' });
    const sourceId = state.document.effects[0]!.id;
    state = reduceEffectRecipeEditor(state, {
      type: 'duplicate',
      effectInstanceId: sourceId,
    });

    expect(state.document.effects).toHaveLength(2);
    expect(state.document.effects[1]?.id).not.toBe(sourceId);
    expect(state.selectedEffectId).toBe(state.document.effects[1]?.id);
  });

  it('toggles numeric parameter keyframes at the playhead', () => {
    let state = createEffectRecipeEditorState(createEffectRecipeDocument('Recipe'));
    state = reduceEffectRecipeEditor(state, { type: 'add', effectId: 'bloom' });
    const effectId = state.document.effects[0]!.id;
    state = reduceEffectRecipeEditor(state, {
      type: 'toggleKeyframe',
      effectInstanceId: effectId,
      paramKey: 'amount',
      timeMs: 1_250,
    });

    expect(state.document.effects[0]?.animations?.amount?.keyframes[0]?.timeUs).toBe(1_250_000);
    state = reduceEffectRecipeEditor(state, {
      type: 'toggleKeyframe',
      effectInstanceId: effectId,
      paramKey: 'amount',
      timeMs: 1_250,
    });
    expect(state.document.effects[0]?.animations?.amount).toBeUndefined();
  });
});
