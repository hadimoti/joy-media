import { describe, expect, it } from 'vitest';
import { rational } from '@joy-media/project-schema';
import { captureSceneFrames, createSandboxedReactScene, SceneSandboxError } from './runtime.js';
import { createManifestResolver } from './resolver.js';
import type { SceneManifest } from './runtime.js';

const manifest: SceneManifest = {
  formatVersion: 1,
  id: 'joy.firstparty.parameterized-card',
  version: '0.0.0-spike',
  runtime: 'joy-html-scene-1',
  viewport: { width: 1080, height: 1920 },
  transparent: true,
  durationUs: 1_000_000,
  permissions: { network: [], storage: 'none' },
  determinism: { seededRandom: true, wallClock: false },
};

const productCardSource = `
globalThis.__joyScene = (ctx) => {
  const sparkle = Math.floor(ctx.random() * 1000);
  return React.createElement(
    'article',
    { className: 'product-card ' + ctx.variables.tone, 'data-time-us': ctx.timeUs },
    React.createElement('h1', null, ctx.variables.title),
    React.createElement('p', null, ctx.frameIndex + ':' + sparkle + ':' + ctx.locale)
  );
};
`;

describe('sandboxed React scene spike', () => {
  it('renders parameterized React output deterministically from JOY time and seed', () => {
    const scene = createSandboxedReactScene<{ title: string; tone: string }>(
      manifest,
      productCardSource,
    );
    const request = {
      timeUs: 500_000,
      frameRate: rational(30, 1),
      seed: 'fixed-seed',
      variables: { title: 'Launch', tone: 'violet' },
      locale: 'en-US',
    };
    const first = scene.render(request);
    const second = scene.render(request);
    expect(first).toEqual(second);
    expect(first.frameIndex).toBe(15);
    expect(first.markup).toContain('product-card violet');
    expect(first.markup).toContain('Launch');
    expect(first.markup).toContain('15:');
    expect(scene.render({ ...request, seed: 'other-seed' }).sha256).not.toBe(first.sha256);
  });

  it('captures exact end-exclusive sequences at 30 and 60 fps', () => {
    const scene = createSandboxedReactScene(manifest, productCardSource);
    const capture = (frameRate: ReturnType<typeof rational>) =>
      captureSceneFrames(scene, {
        frameRate,
        seed: 'capture-seed',
        variables: { title: 'Frame', tone: 'blue' },
        locale: 'en-US',
      });

    const at30 = capture(rational(30, 1));
    const at60 = capture(rational(60, 1));
    expect(at30).toHaveLength(30);
    expect(at60).toHaveLength(60);
    expect(at30[0]!.timeUs).toBe(0);
    expect(at30[29]!.timeUs).toBe(966_667);
    expect(at60[59]!.timeUs).toBe(983_334);
    expect(capture(rational(30, 1))).toEqual(at30);
    expect(capture(rational(60, 1))).toEqual(at60);
  });

  it('exposes neither network nor host-process globals to the scene', () => {
    const scene = createSandboxedReactScene(
      manifest,
      `globalThis.__joyScene = () => React.createElement('p', null, typeof globalThis['f' + 'etch'] + ':' + typeof process + ':' + typeof require);`,
    );
    expect(
      scene.render({
        timeUs: 0,
        frameRate: rational(30, 1),
        seed: 'sandbox',
        variables: {},
        locale: 'en-US',
      }).markup,
    ).toBe('<p>undefined:undefined:undefined</p>');
  });

  it('injects only explicit asset/font resolvers into a scene context', () => {
    const resolverScene = createSandboxedReactScene(
      manifest,
      `globalThis.__joyScene = (ctx) => React.createElement('p', null,
        ctx.assets.resolve('logo') + ':' + ctx.fonts.resolve('JOY Sans'));`,
    );
    expect(
      resolverScene.render({
        timeUs: 500_000,
        frameRate: rational(30, 1),
        seed: 'fixed-seed',
        variables: { title: 'Launch', tone: 'violet' },
        locale: 'en-US',
        resolvers: createManifestResolver(
          { logo: 'data:image/png;base64,AA==' },
          { 'JOY Sans': 'data:font/woff2;base64,AA==' },
        ),
      }).markup,
    ).toContain('data:image/png;base64,AA==:data:font/woff2;base64,AA==');
    expect(() =>
      resolverScene.render({
        timeUs: 500_000,
        frameRate: rational(30, 1),
        seed: 'fixed-seed',
        variables: { title: 'Launch', tone: 'violet' },
        locale: 'en-US',
      }),
    ).toThrow('unresolved asset "logo"');
  });

  it('rejects a source that attempts network access before rendering', () => {
    expect(() =>
      createSandboxedReactScene(
        manifest,
        `globalThis.__joyScene = () => fetch('https://example.invalid');`,
      ),
    ).toThrow(expect.objectContaining({ code: 'SCENE_SANDBOX_NETWORK_DENIED' }));
  });

  it('rejects manifests that request network or wall-clock access', () => {
    expect(() =>
      createSandboxedReactScene(
        { ...manifest, permissions: { network: ['https://example.invalid'], storage: 'none' } },
        productCardSource,
      ),
    ).toThrow(SceneSandboxError);
    expect(() =>
      createSandboxedReactScene(
        JSON.parse(
          JSON.stringify({ ...manifest, determinism: { seededRandom: true, wallClock: true } }),
        ) as SceneManifest,
        productCardSource,
      ),
    ).toThrow(SceneSandboxError);
  });
});
