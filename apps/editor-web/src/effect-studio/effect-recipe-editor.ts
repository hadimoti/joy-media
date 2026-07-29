import {
  effectRegistry,
  type EffectInstanceV1,
  type EffectParamValue,
} from '@joy-media/visual-effects';
import type { EffectRecipeDocument } from '../effect-recipe-catalog.js';

export interface EffectRecipeEditorState {
  readonly document: EffectRecipeDocument;
  readonly selectedEffectId: string | undefined;
  readonly past: readonly EffectRecipeDocument[];
  readonly future: readonly EffectRecipeDocument[];
}

export type EffectRecipeEditorAction =
  | { readonly type: 'select'; readonly effectId?: string }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'rename'; readonly name: string }
  | { readonly type: 'setDuration'; readonly durationMs: number }
  | { readonly type: 'add'; readonly effectId: string }
  | {
      readonly type: 'appendEffects';
      readonly effects: readonly {
        readonly effectId: string;
        readonly enabled: boolean;
        readonly params: Readonly<Record<string, EffectParamValue>>;
        readonly animations?: EffectInstanceV1['animations'];
      }[];
    }
  | { readonly type: 'remove'; readonly effectInstanceId: string }
  | { readonly type: 'duplicate'; readonly effectInstanceId: string }
  | { readonly type: 'move'; readonly effectInstanceId: string; readonly direction: -1 | 1 }
  | { readonly type: 'toggle'; readonly effectInstanceId: string }
  | {
      readonly type: 'setParam';
      readonly effectInstanceId: string;
      readonly paramKey: string;
      readonly value: EffectParamValue;
    }
  | {
      readonly type: 'toggleKeyframe';
      readonly effectInstanceId: string;
      readonly paramKey: string;
      readonly timeMs: number;
    }
  | { readonly type: 'replaceDocument'; readonly document: EffectRecipeDocument };

export function createEffectRecipeEditorState(
  document: EffectRecipeDocument,
): EffectRecipeEditorState {
  return {
    document,
    selectedEffectId: document.effects[0]?.id,
    past: [],
    future: [],
  };
}

export function createDefaultEffectInstance(effectId: string): EffectInstanceV1 {
  const descriptor = effectRegistry.getEffect(effectId);
  if (descriptor === undefined) throw new RangeError(`Unknown effect "${effectId}"`);
  return {
    id: crypto.randomUUID(),
    effectId,
    enabled: true,
    params: Object.fromEntries(descriptor.params.map((param) => [param.key, param.defaultValue])),
  };
}

export function reduceEffectRecipeEditor(
  state: EffectRecipeEditorState,
  action: EffectRecipeEditorAction,
): EffectRecipeEditorState {
  if (action.type === 'select') {
    return { ...state, selectedEffectId: action.effectId };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (previous === undefined) return state;
    return {
      document: previous,
      selectedEffectId: selectExisting(previous, state.selectedEffectId),
      past: state.past.slice(0, -1),
      future: [state.document, ...state.future],
    };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (next === undefined) return state;
    return {
      document: next,
      selectedEffectId: selectExisting(next, state.selectedEffectId),
      past: [...state.past, state.document],
      future: state.future.slice(1),
    };
  }
  if (action.type === 'replaceDocument') {
    return createEffectRecipeEditorState(action.document);
  }

  let selectedEffectId = state.selectedEffectId;
  let nextDocument: EffectRecipeDocument;
  const updatedAt = new Date().toISOString();

  switch (action.type) {
    case 'rename':
      nextDocument = { ...state.document, name: action.name, updatedAt };
      break;
    case 'setDuration':
      nextDocument = {
        ...state.document,
        durationMs: Math.max(1_000, Math.min(60_000, Math.round(action.durationMs))),
        updatedAt,
      };
      break;
    case 'add': {
      const effect = createDefaultEffectInstance(action.effectId);
      nextDocument = {
        ...state.document,
        effects: [...state.document.effects, effect],
        updatedAt,
      };
      selectedEffectId = effect.id;
      break;
    }
    case 'appendEffects': {
      const additions = action.effects.map((effect) => ({
        id: crypto.randomUUID(),
        effectId: effect.effectId,
        enabled: effect.enabled,
        params: { ...effect.params },
        ...(effect.animations === undefined ? {} : { animations: effect.animations }),
      }));
      if (additions.length === 0) return state;
      nextDocument = {
        ...state.document,
        effects: [...state.document.effects, ...additions],
        updatedAt,
      };
      selectedEffectId = additions[0]?.id;
      break;
    }
    case 'remove': {
      const index = state.document.effects.findIndex(
        (effect) => effect.id === action.effectInstanceId,
      );
      if (index === -1) return state;
      const effects = state.document.effects.filter(
        (effect) => effect.id !== action.effectInstanceId,
      );
      nextDocument = { ...state.document, effects, updatedAt };
      if (selectedEffectId === action.effectInstanceId) {
        selectedEffectId = effects[Math.min(index, effects.length - 1)]?.id;
      }
      break;
    }
    case 'duplicate': {
      const index = state.document.effects.findIndex(
        (effect) => effect.id === action.effectInstanceId,
      );
      if (index === -1) return state;
      const source = state.document.effects[index]!;
      const duplicate: EffectInstanceV1 = {
        ...source,
        id: crypto.randomUUID(),
        params: { ...source.params },
      };
      const effects = [...state.document.effects];
      effects.splice(index + 1, 0, duplicate);
      nextDocument = { ...state.document, effects, updatedAt };
      selectedEffectId = duplicate.id;
      break;
    }
    case 'move': {
      const index = state.document.effects.findIndex(
        (effect) => effect.id === action.effectInstanceId,
      );
      const nextIndex = index + action.direction;
      if (index === -1 || nextIndex < 0 || nextIndex >= state.document.effects.length) {
        return state;
      }
      const effects = [...state.document.effects];
      const [effect] = effects.splice(index, 1);
      effects.splice(nextIndex, 0, effect!);
      nextDocument = { ...state.document, effects, updatedAt };
      break;
    }
    case 'toggle':
      nextDocument = mapEffect(state.document, action.effectInstanceId, (effect) => ({
        ...effect,
        enabled: !effect.enabled,
      }));
      break;
    case 'setParam':
      nextDocument = mapEffect(state.document, action.effectInstanceId, (effect) => ({
        ...effect,
        params: { ...effect.params, [action.paramKey]: action.value },
      }));
      break;
    case 'toggleKeyframe': {
      const effect = state.document.effects.find(
        (candidate) => candidate.id === action.effectInstanceId,
      );
      const value = effect?.params[action.paramKey];
      if (effect === undefined || typeof value !== 'number') return state;
      const timeUs = Math.round(Math.max(0, action.timeMs) * 1_000);
      nextDocument = mapEffect(state.document, action.effectInstanceId, (current) => {
        const existing = current.animations?.[action.paramKey]?.keyframes ?? [];
        const hasKeyframe = existing.some((keyframe) => keyframe.timeUs === timeUs);
        const keyframes = hasKeyframe
          ? existing.filter((keyframe) => keyframe.timeUs !== timeUs)
          : [...existing, { timeUs, value, interpolation: 'eased' as const }].sort(
              (a, b) => a.timeUs - b.timeUs,
            );
        const animations = { ...current.animations };
        if (keyframes.length === 0) delete animations[action.paramKey];
        else animations[action.paramKey] = { keyframes };
        const nextEffect = { ...current };
        if (Object.keys(animations).length === 0) delete nextEffect.animations;
        else nextEffect.animations = animations;
        return nextEffect;
      });
      break;
    }
  }

  return {
    document: nextDocument,
    selectedEffectId,
    past: [...state.past, state.document].slice(-100),
    future: [],
  };
}

function mapEffect(
  document: EffectRecipeDocument,
  effectId: string,
  map: (effect: EffectInstanceV1) => EffectInstanceV1,
): EffectRecipeDocument {
  if (!document.effects.some((effect) => effect.id === effectId)) return document;
  return {
    ...document,
    updatedAt: new Date().toISOString(),
    effects: document.effects.map((effect) => (effect.id === effectId ? map(effect) : effect)),
  };
}

function selectExisting(
  document: EffectRecipeDocument,
  selectedEffectId: string | undefined,
): string | undefined {
  return document.effects.some((effect) => effect.id === selectedEffectId)
    ? selectedEffectId
    : document.effects[0]?.id;
}
