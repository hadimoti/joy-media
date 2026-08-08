/**
 * Pixi v8 Filter adapter for curated gl-transitions shaders.
 */

import type { Texture } from 'pixi.js';
import { Filter, GlProgram } from 'pixi.js';
import {
  buildPixiTransitionFragment,
  getTransitionShader,
  mergeTransitionParams,
  type TransitionParamValue,
} from '@joy-media/transition-shaders';

const DEFAULT_FILTER_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

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

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

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
  initialParams?: Readonly<Record<string, number>>,
): GlTransitionFilterHandle | undefined {
  const entry = getTransitionShader(shaderId);
  if (entry === undefined) return undefined;

  const fragment = buildPixiTransitionFragment(entry.glsl);
  // Declare optional float uniforms used by curated set (vectors use defaults in GLSL).
  const floatUniforms: Record<string, { value: number; type: 'f32' }> = {
    uProgress: { value: 0, type: 'f32' },
    uRatio: { value: 1, type: 'f32' },
  };
  const merged = mergeTransitionParams(shaderId, initialParams);
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'number') {
      floatUniforms[key] = { value, type: 'f32' };
    }
  }

  // Inject uniform declarations for param floats into fragment if missing.
  let fragWithUniforms = fragment;
  for (const key of Object.keys(floatUniforms)) {
    if (key === 'uProgress' || key === 'uRatio') continue;
    if (!fragWithUniforms.includes(`uniform float ${key}`)) {
      fragWithUniforms = fragWithUniforms.replace(
        'uniform float uRatio;',
        `uniform float uRatio;\nuniform float ${key};`,
      );
    }
  }

  const filter = new Filter({
    glProgram: GlProgram.from({
      vertex: DEFAULT_FILTER_VERT,
      fragment: fragWithUniforms,
      name: `joy-gl-transition-${entry.glName}`,
    }),
    resources: {
      transitionUniforms: floatUniforms,
    },
  });

  const uniforms = filter.resources['transitionUniforms'] as
    { uniforms: Record<string, number> } | undefined;

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
        if (typeof value === 'number') uniforms.uniforms[key] = value;
      }
    },
    destroy(): void {
      filter.destroy();
    },
  };
}
