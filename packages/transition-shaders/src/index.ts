/**
 * Curated gl-transitions registry for JOY Media clip junctions.
 * Shaders are vendored from https://github.com/gl-transitions/gl-transitions (MIT).
 */

import { TRANSITION_CATALOG } from './catalog.js';
import {
  isTransitionCategoryId,
  isTransitionOption,
  type TransitionCategoryId,
  type TransitionOption,
} from './categories.js';
import { TRANSITION_GLSL_BY_FILE } from './glsl-sources.js';

export {
  TRANSITION_CATEGORIES,
  TRANSITION_OPTIONS,
  type TransitionCategoryId,
  type TransitionOption,
} from './categories.js';

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

/** A catalogue entry as the panel lists it: the shader plus its card text and credit. */
export interface TransitionCatalogEntry extends TransitionShaderEntry {
  /** One-line description for the card and its tooltip. */
  readonly description: string;
  readonly category: TransitionCategoryId;
  readonly options: readonly TransitionOption[];
  /** Author and licence as written in the shader file's own header, plus where it came from. */
  readonly credit: string;
  readonly glslFile: string;
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
  readonly description: string;
  readonly category: string;
  readonly options: readonly string[];
  readonly license: string;
  readonly author: string;
  readonly credit: string;
  readonly glslFile: string;
  readonly defaultParams: Readonly<Record<string, TransitionParamValue>>;
  readonly paramsTypes: Readonly<Record<string, string>>;
}

const catalog = TRANSITION_CATALOG as unknown as readonly CatalogRow[];

const entries: readonly TransitionCatalogEntry[] = catalog.map((row) => {
  const glsl = TRANSITION_GLSL_BY_FILE[row.glslFile];
  if (glsl === undefined) throw new Error(`Missing GLSL for ${row.glslFile}`);
  const category = row.category;
  if (!isTransitionCategoryId(category)) throw new Error(`Unknown category for ${row.id}`);
  const options = row.options.filter(isTransitionOption);
  return {
    id: row.id,
    glName: row.glName,
    label: row.label,
    description: row.description,
    category,
    options,
    license: row.license,
    author: row.author,
    credit: row.credit,
    glslFile: row.glslFile,
    glsl,
    defaultParams: row.defaultParams,
    paramsTypes: row.paramsTypes,
  };
});

const byId = new Map(entries.map((entry) => [entry.id, entry]));

/**
 * Removed catalogue ids and the kept entry each one now opens as (LIBRARY-AUDIT.md, T-V08).
 * `dissolve`, `wipe` and `slide` were doubles of `gl:fade`, `gl:wipeLeft` and `gl:Directional`.
 * Every place that reads a transition id goes through `resolveTransitionShaderId`, so old
 * projects, favourites and agent plans that still name a removed id keep working.
 */
export const LEGACY_TRANSITION_ALIASES: Readonly<Record<string, string>> = {
  dissolve: 'gl:fade',
  wipe: 'gl:wipeLeft',
  slide: 'gl:Directional',
};

export function listTransitionShaders(): readonly TransitionCatalogEntry[] {
  return entries;
}

export function resolveTransitionShaderId(type: string): string {
  return Object.hasOwn(LEGACY_TRANSITION_ALIASES, type) ? LEGACY_TRANSITION_ALIASES[type]! : type;
}

export function getTransitionShader(type: string): TransitionCatalogEntry | undefined {
  return byId.get(resolveTransitionShaderId(type));
}

/**
 * Descriptor view consumed by the universal animation layer. Uniforms that
 * are not scalar are still advertised for UI/catalog introspection. The Pixi filter binds float and
 * vector uniforms (`resolveTransitionUniforms`); keyframes evaluate float uniforms only.
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
 * GLSL uniform types the Pixi transition filter (renderer-pixi `gl-transition-filter.ts`) binds
 * from a catalogue entry. A shader uniform of any other type would stay at zero on the GPU, so the
 * catalogue test refuses an entry that declares one.
 */
export const SUPPLIED_TRANSITION_UNIFORM_TYPES = [
  'float',
  'vec2',
  'vec3',
  'vec4',
  'ivec2',
  'ivec3',
  'ivec4',
] as const;

export type SuppliedTransitionUniformType = (typeof SUPPLIED_TRANSITION_UNIFORM_TYPES)[number];

export function isSuppliedTransitionUniformType(
  type: string,
): type is SuppliedTransitionUniformType {
  return (SUPPLIED_TRANSITION_UNIFORM_TYPES as readonly string[]).includes(type);
}

/** Component count of a supplied uniform type: 1 for `float`, N for `vecN` and `ivecN`. */
export function transitionUniformSize(type: SuppliedTransitionUniformType): number {
  return type === 'float' ? 1 : Number(type.slice(-1));
}

const COMPONENT_SLOTS: Readonly<Record<string, number>> = {
  x: 0,
  y: 1,
  z: 2,
  w: 3,
  r: 0,
  g: 1,
  b: 2,
  a: 3,
};

/**
 * The project stores transition params as numbers only (`TransitionV1.params`). A vector uniform is
 * stored one number per component under `<uniform>.<component>`: `direction.x`, `direction.y` for
 * a direction, `bgcolor.r` … `bgcolor.a` for a colour (x/y/z/w and r/g/b/a name the same slots).
 * Returns the uniform name and slot, or `undefined` for a plain key.
 */
export function parseTransitionComponentKey(
  key: string,
): { readonly name: string; readonly index: number } | undefined {
  const match = /^([A-Za-z_]\w*)\.([xyzwrgba])$/.exec(key);
  if (match === null) return undefined;
  return { name: match[1]!, index: COMPONENT_SLOTS[match[2]!]! };
}

export interface ResolvedTransitionUniform {
  readonly name: string;
  readonly type: SuppliedTransitionUniformType;
  /** A number for `float`; one number per component for vectors. */
  readonly value: number | readonly number[];
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Every uniform a catalogue entry declares in `paramsTypes`, with the value the filter binds:
 * the catalogue default, then a whole override from `params` (a number for a float, an array for a
 * vector), then single component keys such as `direction.x` or `bgcolor.r`. `ivec` values are
 * rounded. Unknown ids resolve to an empty list.
 */
export function resolveTransitionUniforms(
  type: string,
  params?: Readonly<Record<string, TransitionParamValue>>,
): readonly ResolvedTransitionUniform[] {
  const entry = getTransitionShader(type);
  if (entry === undefined) return [];
  const resolved: ResolvedTransitionUniform[] = [];
  for (const [name, uniformType] of Object.entries(entry.paramsTypes)) {
    if (!isSuppliedTransitionUniformType(uniformType)) continue;
    const fallback = entry.defaultParams[name];
    const override = params?.[name];
    if (uniformType === 'float') {
      resolved.push({ name, type: uniformType, value: finiteOr(override, finiteOr(fallback, 0)) });
      continue;
    }
    const size = transitionUniformSize(uniformType);
    const base = Array.isArray(fallback) ? fallback : [];
    const whole = Array.isArray(override) ? override : [];
    const value = Array.from({ length: size }, (_, index) =>
      finiteOr(whole[index], finiteOr(base[index], 0)),
    );
    for (const [key, item] of Object.entries(params ?? {})) {
      const component = parseTransitionComponentKey(key);
      if (component === undefined || component.name !== name || component.index >= size) continue;
      value[component.index] = finiteOr(item, value[component.index]!);
    }
    resolved.push({
      name,
      type: uniformType,
      value: uniformType.startsWith('ivec') ? value.map((item) => Math.round(item)) : value,
    });
  }
  return resolved;
}
/**
 * Wrap a gl-transitions `transition(vec2)` body for Pixi v8 Filter usage.
 * Expects uniforms: uTexture (from), uTextureTo (to), uProgress, uRatio, plus params.
 */
export function buildPixiTransitionFragment(glslBody: string): string {
  return `in vec2 vTextureCoord;
in vec2 vFromScale;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform sampler2D uTextureTo;
uniform float uProgress;
uniform float uRatio;

vec4 getFromColor(vec2 uv) {
  return texture(uTexture, uv * vFromScale);
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
