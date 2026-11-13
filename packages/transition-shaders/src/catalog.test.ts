import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRANSITION_GLSL_BY_FILE } from './glsl-sources.js';
import {
  TRANSITION_CATEGORIES,
  TRANSITION_OPTIONS,
  buildPixiTransitionFragment,
  isSuppliedTransitionUniformType,
  listTransitionShaders,
  resolveTransitionUniforms,
  transitionUniformSize,
  type TransitionCatalogEntry,
} from './index.js';

const shadersDir = resolve(dirname(fileURLToPath(import.meta.url)), 'shaders');
const catalog = listTransitionShaders();

function readShader(file: string): string {
  return readFileSync(resolve(shadersDir, file), 'utf8').replace(/\r\n/g, '\n');
}

function headerField(source: string, field: 'Author' | 'License'): string | undefined {
  const head = source.split('\n').slice(0, 12);
  const line = head.find((item) => new RegExp(`^\\s*//\\s*${field}\\s*:`, 'i').test(item));
  return line?.replace(new RegExp(`^\\s*//\\s*${field}\\s*:\\s*`, 'i'), '').trim();
}

/** `uniform <type> <name>` declarations, whatever follows the name. */
function uniforms(source: string): { type: string; name: string }[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/\buniform\s+(\w+)\s+(\w+)/g)].map((match) => ({
    type: match[1]!,
    name: match[2]!,
  }));
}

type ShaderLike = Pick<TransitionCatalogEntry, 'id' | 'glsl' | 'defaultParams' | 'paramsTypes'>;

/**
 * Shader uniforms the Pixi transition filter would leave at zero: a type it does not bind, no
 * catalogue type or a type that differs from the shader, or no default of the right size. The
 * filter binds exactly what `resolveTransitionUniforms` returns, so that is checked too.
 */
function unsuppliedUniforms(entry: ShaderLike): string[] {
  const supplied = new Map(
    entry.id.startsWith('test:')
      ? []
      : resolveTransitionUniforms(entry.id).map((uniform) => [uniform.name, uniform] as const),
  );
  const problems: string[] = [];
  for (const uniform of uniforms(entry.glsl)) {
    const label = `${uniform.type} ${uniform.name}`;
    const type = entry.paramsTypes[uniform.name];
    const value = entry.defaultParams[uniform.name];
    if (!isSuppliedTransitionUniformType(uniform.type) || type !== uniform.type) {
      problems.push(label);
      continue;
    }
    const size = transitionUniformSize(uniform.type);
    const fits =
      size === 1
        ? typeof value === 'number'
        : Array.isArray(value) && value.length === size && value.every(Number.isFinite);
    if (!fits) problems.push(label);
    else if (!entry.id.startsWith('test:') && !supplied.has(uniform.name)) problems.push(label);
  }
  return problems;
}

describe('transition catalogue (T-V08)', () => {
  it('has at least 30 transitions for v1.1.1, including the three dips', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(30);
    const labels = catalog.map((entry) => entry.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Dip to Black', 'Dip to White', 'Dip to Colour']),
    );
  });
  it('has unique ids and unique names that fit two lines on a card', () => {
    const ids = catalog.map((entry) => entry.id);
    const labels = catalog.map((entry) => entry.label.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const entry of catalog) {
      expect(entry.label.trim(), entry.id).toBe(entry.label);
      expect(entry.label.length, entry.id).toBeLessThanOrEqual(24);
      expect(entry.label.split(/\s+/).length, entry.id).toBeLessThanOrEqual(3);
    }
  });

  it('gives every entry a one-line description', () => {
    for (const entry of catalog) {
      expect(entry.description.length, entry.id).toBeGreaterThan(10);
      expect(entry.description.length, entry.id).toBeLessThanOrEqual(90);
      expect(entry.description, entry.id).not.toMatch(/\n/);
      expect(entry.description, entry.id).toMatch(/\.$/);
    }
  });

  it('puts every entry in one of the eight categories and fills all eight', () => {
    expect(TRANSITION_CATEGORIES.map((category) => category.label)).toEqual([
      'Basic and fades',
      'Wipes',
      'Slides and pushes',
      'Zooms and spins',
      'Shapes and masks',
      'Glitch and digital',
      'Light and glow',
      'Creative',
    ]);
    const ids = new Set<string>(TRANSITION_CATEGORIES.map((category) => category.id));
    for (const entry of catalog) expect(ids.has(entry.category), entry.id).toBe(true);
    for (const category of TRANSITION_CATEGORIES) {
      expect(
        catalog.filter((entry) => entry.category === category.id).length,
        category.label,
      ).toBeGreaterThan(0);
    }
  });

  it('lists only options that apply to each entry', () => {
    for (const entry of catalog) {
      expect(entry.options, entry.id).toContain('duration');
      expect(new Set(entry.options).size, entry.id).toBe(entry.options.length);
      for (const option of entry.options) expect(TRANSITION_OPTIONS, entry.id).toContain(option);
      const params = Object.keys(entry.paramsTypes);
      if (entry.options.includes('direction')) expect(params, entry.id).toContain('direction');
      if (entry.options.includes('colour'))
        expect(
          params.some((name) => /colou?r/i.test(name)),
          entry.id,
        ).toBe(true);
      // The project schema stores no easing for a transition, so no entry can offer it yet.
      expect(entry.options, entry.id).not.toContain('easing');
    }
  });

  it('credits every entry with the author and licence written in its own shader file', () => {
    for (const entry of catalog) {
      const source = readShader(entry.glslFile);
      expect(headerField(source, 'License'), entry.glslFile).toBe('MIT');
      expect(entry.license, entry.id).toBe('MIT');
      expect(headerField(source, 'Author'), entry.glslFile).toBe(entry.author);
      expect(entry.credit, entry.id).toContain(entry.author);
      expect(entry.credit, entry.id).toContain('MIT');
      expect(entry.credit, entry.id).toContain(entry.glslFile);
    }
  });

  it('ships the committed .glsl files unchanged and leaves no file unused', () => {
    const files = readdirSync(shadersDir).filter((name) => name.endsWith('.glsl'));
    expect(new Set(catalog.map((entry) => entry.glslFile))).toEqual(new Set(files));
    for (const file of files) expect(TRANSITION_GLSL_BY_FILE[file], file).toBe(readShader(file));
    for (const entry of catalog) expect(entry.glsl).toBe(readShader(entry.glslFile));
  });

  it('only uses what the Pixi transition filter provides (static compile check)', () => {
    for (const entry of catalog) {
      const source = entry.glsl;
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      // The entry point the filter calls: finalColor = transition(vTextureCoord).
      expect(code, entry.id).toMatch(/\bvec4\s+transition\s*\(\s*vec2\s+\w+\s*\)/);
      // Only the two textures behind getFromColor/getToColor exist; no extra samplers.
      expect(code, entry.id).not.toMatch(/\b(sampler2D|samplerCube|texture2D|textureCube)\b/);
      // Pixi compiles these with WebGL1 defines: in -> varying, texture -> texture2D,
      // finalColor -> gl_FragColor. Any of these names in the body breaks the compile.
      expect(code, entry.id).not.toMatch(/\b(gl_FragColor|finalColor|varying|attribute)\b/);
      expect(code, entry.id).not.toMatch(/\btexture\b/);
      expect(code, entry.id).not.toMatch(/[(,]\s*(in|inout)\s+\w/);
      expect(code, entry.id).not.toMatch(/#version|\bmain\s*\(/);
      // Every uniform a shader declares must be one the filter supplies; no exceptions.
      expect(unsuppliedUniforms(entry), entry.id).toEqual([]);
      const declared = new Set(uniforms(source).map((uniform) => uniform.name));
      for (const name of Object.keys(entry.defaultParams))
        expect(declared, entry.id).toContain(name);
      const fragment = buildPixiTransitionFragment(source);
      expect(fragment).toContain('transition(vTextureCoord)');
    }
  });

  it('fails a shader that needs a uniform the filter does not supply', () => {
    const shader = (
      glsl: string,
      params: ShaderLike['defaultParams'],
      types: ShaderLike['paramsTypes'],
    ) => unsuppliedUniforms({ id: 'test:shader', glsl, defaultParams: params, paramsTypes: types });
    expect(shader('uniform vec2 direction;', {}, {})).toEqual(['vec2 direction']);
    expect(shader('uniform vec4 bgcolor;', { bgcolor: [0, 0, 0] }, { bgcolor: 'vec4' })).toEqual([
      'vec4 bgcolor',
    ]);
    expect(shader('uniform int count;', { count: 3 }, { count: 'int' })).toEqual(['int count']);
    expect(shader('uniform bool flip;', { flip: 1 }, { flip: 'bool' })).toEqual(['bool flip']);
    expect(shader('uniform float amount;', {}, { amount: 'float' })).toEqual(['float amount']);
    expect(shader('uniform vec2 direction;', { direction: [1, 0] }, { direction: 'vec2' })).toEqual(
      [],
    );
  });

  it('matches each float default to the value written in the shader file', () => {
    for (const entry of catalog) {
      for (const match of entry.glsl.matchAll(
        /\buniform\s+float\s+(\w+)\s*;\s*\/\/\s*=\s*(-?[\d.]+)/g,
      )) {
        expect(entry.defaultParams[match[1]!], `${entry.id} ${match[1]}`).toBe(Number(match[2]));
      }
    }
  });
});
