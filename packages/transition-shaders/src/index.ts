/**
 * Curated gl-transitions registry for JOY Media clip junctions.
 * Shaders are vendored from https://github.com/gl-transitions/gl-transitions (MIT).
 */

import { TRANSITION_CATALOG } from './catalog.js';
import { TRANSITION_GLSL_BY_FILE } from './glsl-sources.js';

export type TransitionParamValue = number | readonly number[];

export interface TransitionShaderEntry {
  readonly id: string;
  readonly glName: string;
  readonly label: string;
  readonly license: string;
  readonly author: string;
  readonly glsl: string;
  readonly defaultParams: Readonly<Record<string, TransitionParamValue>>;
  readonly paramsTypes: Readonly<Record<string, string>>;
}

export interface TransitionUniformDescriptor {
  readonly propertyId: string;
  readonly type: string;
  readonly animatable: boolean;
  readonly interpolation: 'smooth' | 'hold';
}

interface CatalogRow {
  readonly id: string;
  readonly glName: string;
  readonly label: string;
  readonly license: string;
  readonly author: string;
  readonly glslFile: string;
  readonly defaultParams: Readonly<Record<string, TransitionParamValue>>;
  readonly paramsTypes: Readonly<Record<string, string>>;
}

const catalog = TRANSITION_CATALOG as unknown as readonly CatalogRow[];

const entries: readonly TransitionShaderEntry[] = catalog.map((row) => {
  const glsl = TRANSITION_GLSL_BY_FILE[row.glslFile];
  if (glsl === undefined) throw new Error(`Missing GLSL for ${row.glslFile}`);
  return {
    id: row.id,
    glName: row.glName,
    label: row.label,
    license: row.license,
    author: row.author,
    glsl,
    defaultParams: row.defaultParams,
    paramsTypes: row.paramsTypes,
  };
});

const byId = new Map(entries.map((entry) => [entry.id, entry]));

/** Legacy project types map onto curated registry ids. */
export const LEGACY_TRANSITION_ALIASES: Readonly<Record<string, string>> = {
  dissolve: 'dissolve',
  wipe: 'wipe',
  slide: 'slide',
};

export function listTransitionShaders(): readonly TransitionShaderEntry[] {
  return entries;
}

export function resolveTransitionShaderId(type: string): string {
  return LEGACY_TRANSITION_ALIASES[type] ?? type;
}

export function getTransitionShader(type: string): TransitionShaderEntry | undefined {
  return byId.get(resolveTransitionShaderId(type));
}

/**
 * Descriptor view consumed by the universal animation layer. Uniforms that
 * are not scalar are still advertised for UI/catalog introspection, but the
 * first render adapter only evaluates numeric float uniforms.
 */
export function listTransitionUniformDescriptors(
  type: string,
): readonly TransitionUniformDescriptor[] {
  const entry = getTransitionShader(type);
  if (entry === undefined) return [];
  return Object.entries(entry.paramsTypes).map(([propertyId, uniformType]) => ({
    propertyId,
    type: uniformType,
    animatable: uniformType === 'float' || uniformType === 'vec2' || uniformType === 'vec3',
    interpolation: 'smooth',
  }));
}

export function isKnownTransitionType(type: string): boolean {
  return getTransitionShader(type) !== undefined;
}

export function mergeTransitionParams(
  type: string,
  overrides: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, TransitionParamValue>> {
  const entry = getTransitionShader(type);
  if (entry === undefined) return overrides ?? {};
  const merged: Record<string, TransitionParamValue> = { ...entry.defaultParams };
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      const current = merged[key];
      if (Array.isArray(current)) continue;
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Wrap a gl-transitions `transition(vec2)` body for Pixi v8 Filter usage.
 * Expects uniforms: uTexture (from), uTextureTo (to), uProgress, uRatio, plus params.
 */
export function buildPixiTransitionFragment(glslBody: string): string {
  return `in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uTextureTo;
uniform float uProgress;
uniform float uRatio;

vec4 getFromColor(vec2 uv) {
  return texture(uTexture, uv);
}
vec4 getToColor(vec2 uv) {
  return texture(uTextureTo, uv);
}

#define progress uProgress
#define ratio uRatio

${glslBody}

void main() {
  finalColor = transition(vTextureCoord);
}
`;
}
