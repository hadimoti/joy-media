/**
 * The first JOY scene templates (WP-04.5). They are deliberately small,
 * network-free packages so they are usable as independent authoring examples
 * and as deterministic golden fixtures.
 */

import type { SceneManifestV1 } from './manifest.js';
import type { SceneVariableSchema, SceneVariableValue } from './variables.js';
import { resolveSceneVariables } from './variables.js';

export type FirstPartySceneId =
  | 'joy.firstparty.title'
  | 'joy.firstparty.product-card'
  | 'joy.firstparty.lower-third'
  | 'joy.firstparty.data-list';

export interface FirstPartyScenePackage {
  readonly id: FirstPartySceneId;
  readonly name: string;
  readonly manifest: SceneManifestV1;
  readonly source: string;
  readonly variableSchema: SceneVariableSchema;
}

export interface ResolvedSceneInstance {
  readonly scene: FirstPartyScenePackage;
  readonly variables: Readonly<Record<string, SceneVariableValue>>;
}

const sharedManifest = (id: FirstPartySceneId): SceneManifestV1 => ({
  formatVersion: 1,
  id,
  version: '1.0.0',
  runtime: 'joy-html-scene-1',
  entry: 'dist/index.js',
  viewport: { width: 1080, height: 1920 },
  transparent: true,
  durationUs: 5_000_000,
  permissions: { network: [], storage: 'none' },
  determinism: { seededRandom: true, wallClock: false },
  variablesSchema: 'schema.json',
});

const title: FirstPartyScenePackage = {
  id: 'joy.firstparty.title',
  name: 'JOY Title',
  manifest: sharedManifest('joy.firstparty.title'),
  variableSchema: {
    title: { type: 'string', label: 'Title', default: 'JOY Media' },
    subtitle: { type: 'string', label: 'Subtitle', default: 'Make it memorable' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    return React.createElement('div', { style: { width: '100%', height: '100%', color: v.accent, opacity: Math.min(1, ctx.progress * 4) } },
      React.createElement('h1', null, v.title), React.createElement('p', null, v.subtitle));
  };`,
};

const productCard: FirstPartyScenePackage = {
  id: 'joy.firstparty.product-card',
  name: 'JOY Product Card',
  manifest: sharedManifest('joy.firstparty.product-card'),
  variableSchema: {
    product: { type: 'string', label: 'Product', default: 'Signature Blend' },
    price: { type: 'string', label: 'Price', default: '$24' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    return React.createElement('article', { style: { border: '4px solid ' + v.accent, opacity: Math.min(1, ctx.progress * 3) } },
      React.createElement('h2', null, v.product), React.createElement('strong', null, v.price));
  };`,
};

const lowerThird: FirstPartyScenePackage = {
  id: 'joy.firstparty.lower-third',
  name: 'JOY Lower Third',
  manifest: sharedManifest('joy.firstparty.lower-third'),
  variableSchema: {
    name: { type: 'string', label: 'Name', default: 'Alex Morgan' },
    role: { type: 'string', label: 'Role', default: 'Creative Director' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    return React.createElement('section', { style: { borderLeft: '12px solid ' + v.accent, transform: 'translateX(' + Math.round((1 - Math.min(1, ctx.progress * 5)) * -100) + '%)' } },
      React.createElement('strong', null, v.name), React.createElement('span', null, v.role));
  };`,
};

const dataList: FirstPartyScenePackage = {
  id: 'joy.firstparty.data-list',
  name: 'JOY Data List',
  manifest: sharedManifest('joy.firstparty.data-list'),
  variableSchema: {
    heading: { type: 'string', label: 'Heading', default: 'Today at JOY' },
    itemOne: { type: 'string', label: 'Item one', default: 'Design' },
    itemTwo: { type: 'string', label: 'Item two', default: 'Build' },
    itemThree: { type: 'string', label: 'Item three', default: 'Share' },
    accent: { type: 'color', label: 'Accent', default: '#e9b949' },
  },
  source: `globalThis.__joyScene = function (ctx) {
    var v = ctx.variables;
    return React.createElement('section', { style: { color: v.accent, opacity: Math.min(1, ctx.progress * 3) } },
      React.createElement('h2', null, v.heading),
      React.createElement('ol', null,
        React.createElement('li', null, v.itemOne), React.createElement('li', null, v.itemTwo), React.createElement('li', null, v.itemThree)));
  };`,
};

export const FIRST_PARTY_SCENES: readonly FirstPartyScenePackage[] = [
  title,
  productCard,
  lowerThird,
  dataList,
];

export function findFirstPartyScene(id: string): FirstPartyScenePackage | undefined {
  return FIRST_PARTY_SCENES.find((scene) => scene.id === id);
}

/**
 * Resolves a scene in a nested composition. Parent/template values flow inward,
 * while the concrete scene instance wins for fields it explicitly overrides.
 */
export function resolveFirstPartySceneInstance(
  sceneId: string,
  instanceVariables: Readonly<Record<string, unknown>> = {},
  inheritedVariables: Readonly<Record<string, unknown>> = {},
): ResolvedSceneInstance | undefined {
  const scene = findFirstPartyScene(sceneId);
  if (scene === undefined) return undefined;
  const resolved = resolveSceneVariables(scene.variableSchema, {
    ...inheritedVariables,
    ...instanceVariables,
  });
  return { scene, variables: resolved.values };
}
