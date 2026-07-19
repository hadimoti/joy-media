/**
 * React starter scene template (§39-66). A minimal, deterministic title scene
 * that reads typed variables and animates purely off JOY time (`ctx.progress`).
 * The source is written for the JOY Scene Runtime's allowlisted globals — only
 * `React` and the frozen `ctx` — so it renders identically in the reference
 * harness and (later) headless capture.
 */

import type { SceneManifestV1 } from './manifest.js';
import type { SceneVariableSchema } from './variables.js';

export const REACT_STARTER_VARIABLE_SCHEMA: SceneVariableSchema = {
  title: { type: 'string', label: 'Title', default: 'JOY Media' },
  accent: { type: 'color', label: 'Accent color', default: '#e9b949' },
  fontSize: { type: 'number', label: 'Font size', default: 96, min: 8, max: 400 },
  uppercase: { type: 'boolean', label: 'Uppercase', default: true },
  align: {
    type: 'enum',
    label: 'Alignment',
    default: 'center',
    options: ['start', 'center', 'end'],
  },
};

/** The starter scene source; assigns a render function to `globalThis.__joyScene`. */
export const REACT_STARTER_SCENE_SOURCE = `globalThis.__joyScene = function (ctx) {
  var v = ctx.variables;
  var appear = Math.min(1, ctx.progress * 3);
  var text = v.uppercase ? String(v.title).toUpperCase() : String(v.title);
  return React.createElement(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: v.align,
        opacity: appear,
        fontFamily: 'sans-serif',
      },
    },
    React.createElement(
      'span',
      { style: { color: v.accent, fontSize: v.fontSize, fontWeight: 700 } },
      text,
    ),
  );
};
`;

export function starterManifest(overrides: Partial<SceneManifestV1> = {}): SceneManifestV1 {
  return {
    formatVersion: 1,
    id: 'joy.firstparty.starter-title',
    version: '1.0.0',
    runtime: 'joy-html-scene-1',
    entry: 'dist/index.js',
    viewport: { width: 1920, height: 1080 },
    transparent: true,
    durationUs: 3_000_000,
    permissions: { network: [], storage: 'none' },
    determinism: { seededRandom: true, wallClock: false },
    variablesSchema: 'schema.json',
    ...overrides,
  };
}

/** A complete, compilable starter package for tests, the CLI, and scaffolding. */
export function createStarterScenePackage(): {
  readonly manifest: SceneManifestV1;
  readonly source: string;
  readonly variableSchema: SceneVariableSchema;
} {
  return {
    manifest: starterManifest(),
    source: REACT_STARTER_SCENE_SOURCE,
    variableSchema: REACT_STARTER_VARIABLE_SCHEMA,
  };
}
