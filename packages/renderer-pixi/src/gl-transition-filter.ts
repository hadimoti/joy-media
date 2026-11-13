/**
 * Pixi v8 Filter adapter for curated gl-transitions shaders.
 */

import { Filter, GlProgram, Texture } from 'pixi.js';
import {
  buildPixiTransitionFragment,
  getTransitionShader,
  mergeTransitionParams,
  parseTransitionComponentKey,
  resolveTransitionUniforms,
  type SuppliedTransitionUniformType,
  type TransitionParamValue,
} from '@joy-media/transition-shaders';

const DEFAULT_FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vFromScale;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    // Transition uv runs 0..1 over the output frame. Pixi pads the filter input to a power of two,
    // so the first texture (from) needs its own scale; the second texture (to) is output-sized.
    vTextureCoord = aPosition;
    vFromScale = uOutputFrame.zw * uInputSize.zw;
}
`;

type VectorUniformType = Exclude<SuppliedTransitionUniformType, 'float'>;

const PIXI_VECTOR_TYPES = {
  vec2: 'vec2<f32>',
  vec3: 'vec3<f32>',
  vec4: 'vec4<f32>',
  ivec2: 'vec2<i32>',
  ivec3: 'vec3<i32>',
  ivec4: 'vec4<i32>',
} as const satisfies Record<VectorUniformType, string>;

/** One entry of the filter's `transitionUniforms` group, as Pixi's UniformGroup takes it. */
export type GlTransitionUniformSpec =
  | { value: number; type: 'f32' }
  | { value: Float32Array; type: 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>' }
  | { value: Int32Array; type: 'vec2<i32>' | 'vec3<i32>' | 'vec4<i32>' };

export interface GlTransitionUniformPlan {
  /** Uniform group for the filter: uProgress, uRatio, float params and vector params. */
  readonly uniforms: Record<string, GlTransitionUniformSpec>;
  /** The Pixi fragment with any missing param uniform declarations added. */
  readonly fragment: string;
  readonly glName: string;
}

const GLSL_IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * Builds the uniforms the filter binds for a catalogue entry. Float params behave as before:
 * catalogue default, overridden by a numeric project param, each bound as `f32`. Vector params
 * (`direction` as vec2, `bgcolor` as vec4, and any vec3/ivec an entry declares) are bound from the
 * catalogue default, overridden by an array or by component keys such as `direction.x` or
 * `bgcolor.r` (see `resolveTransitionUniforms`). Without this they would stay at zero.
 */
export function buildGlTransitionUniforms(
  shaderId: string,
  params?: Readonly<Record<string, TransitionParamValue>>,
): GlTransitionUniformPlan | undefined {
  const entry = getTransitionShader(shaderId);
  if (entry === undefined) return undefined;

  const uniforms: Record<string, GlTransitionUniformSpec> = {
    uProgress: { value: 0, type: 'f32' },
    uRatio: { value: 1, type: 'f32' },
  };
  const declarations: string[] = [];
  let fragment = buildPixiTransitionFragment(entry.glsl);
  const declares = (name: string): boolean =>
    new RegExp(`\\buniform\\s+\\w+\\s+${name}\\b`).test(fragment);

  const vectors = new Set<string>();
  for (const uniform of resolveTransitionUniforms(shaderId, params)) {
    if (uniform.type === 'float' || typeof uniform.value === 'number') continue;
    vectors.add(uniform.name);
    const type = PIXI_VECTOR_TYPES[uniform.type];
    uniforms[uniform.name] = type.endsWith('<i32>')
      ? { value: Int32Array.from(uniform.value), type: type as 'vec2<i32>' }
      : { value: Float32Array.from(uniform.value), type: type as 'vec2<f32>' };
    if (!declares(uniform.name)) declarations.push(`uniform ${uniform.type} ${uniform.name};`);
  }

  // Float params: unchanged from the float-only filter, except that component keys of a vector
  // (`direction.x`) and names that are not GLSL identifiers are never declared as floats.
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'number') numeric[key] = value;
  }
  const merged = mergeTransitionParams(shaderId, numeric);
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || vectors.has(key) || !GLSL_IDENTIFIER.test(key)) continue;
    uniforms[key] = { value, type: 'f32' };
    if (!fragment.includes(`uniform float ${key}`)) declarations.push(`uniform float ${key};`);
  }

  if (declarations.length > 0) {
    fragment = fragment.replace(
      'uniform float uRatio;',
      `uniform float uRatio;\n${declarations.join('\n')}`,
    );
  }
  return { uniforms, fragment, glName: entry.glName };
}

export interface GlTransitionFilterHandle {
  readonly filter: Filter;
  setProgress(progress: number): void;
  setRatio(ratio: number): void;
  setToTexture(texture: Texture): void;
  setParams(params: Readonly<Record<string, TransitionParamValue>>): void;
  destroy(): void;
}

export function createGlTransitionFilter(
  shaderId: string,
  initialParams?: Readonly<Record<string, TransitionParamValue>>,
): GlTransitionFilterHandle | undefined {
  const plan = buildGlTransitionUniforms(shaderId, initialParams);
  if (plan === undefined) return undefined;

  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: DEFAULT_FILTER_VERT,
      fragment: plan.fragment,
      name: `joy-gl-transition-${plan.glName}`,
    }),
    // Declare the second sampler now. Pixi only binds resource names that exist when the filter is
    // built, so a texture written to uTextureTo later never reaches the shader (F-01).
    resources: {
      transitionUniforms: plan.uniforms,
      uTextureTo: Texture.EMPTY.source,
    },
  });

  const uniforms = filter.resources['transitionUniforms'] as
    { uniforms: Record<string, number | Float32Array | Int32Array> } | undefined;

  const writeComponent = (name: string, index: number, value: number): void => {
    const vector = uniforms?.uniforms[name];
    if (typeof vector === 'number' || vector === undefined || index >= vector.length) return;
    if (!Number.isFinite(value)) return;
    vector[index] = vector instanceof Int32Array ? Math.round(value) : value;
  };

  return {
    filter,
    setProgress(progress: number): void {
      if (uniforms?.uniforms !== undefined) uniforms.uniforms['uProgress'] = progress;
    },
    setRatio(ratio: number): void {
      if (uniforms?.uniforms !== undefined) uniforms.uniforms['uRatio'] = ratio;
    },
    setToTexture(texture: Texture): void {
      // Pixi v8: bind second sampler via resources on the filter.
      (filter.resources as Record<string, unknown>)['uTextureTo'] = texture.source;
    },
    setParams(params: Readonly<Record<string, TransitionParamValue>>): void {
      if (uniforms?.uniforms === undefined) return;
      for (const [key, value] of Object.entries(params)) {
        const current = uniforms.uniforms[key];
        if (Array.isArray(value)) {
          value.forEach((item, index) => writeComponent(key, index, item));
          continue;
        }
        if (typeof value !== 'number') continue;
        const component = parseTransitionComponentKey(key);
        if (component !== undefined && typeof uniforms.uniforms[component.name] !== 'number') {
          writeComponent(component.name, component.index, value);
        } else if (current === undefined || typeof current === 'number') {
          uniforms.uniforms[key] = value;
        }
      }
    },
    destroy(): void {
      filter.destroy();
    },
  };
}
