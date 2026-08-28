import { describe, expect, it } from 'vitest';
import {
  bundleDigestV2,
  captionBurnInDigestV2,
  canonicalJsonV2,
  createCompositionPlanV2,
  createRenderBundleV2,
  assertPlanV2,
  planDigestV2,
  normalizeCaptionBurnInPayloadV2,
  preflightCompositionPlanV2,
  sha256HexV2,
  transitionDigestV2,
  normalizeTransitionV2,
  validateRenderBundleV2,
  type CompositionPlanV2,
} from './v2.js';
import type { MotionSceneDocument } from '../../motion-core/src/scene.js';

const plan: CompositionPlanV2 = {
  version: 2,
  composition: { id: 'comp', width: 64, height: 64 },
  viewport: { width: 64, height: 64 },
  frameRate: { num: 30, den: 1 },
  durationUs: 1_000_000,
  background: '#000000',
  layers: [],
  audio: [],
  outputPreset: 'preview',
  planSha256: '',
};

describe('render contract v2', () => {
  it('pre-rasterized bitmap text requires pinned font metadata', () => {
    const candidate = {
      ...plan,
      layers: [
        {
          id: 'title',
          kind: 'text' as const,
          text: 'JOY',
          bitmapAssetId: 'title-bitmap',
          fontId: 'falsafeh-light',
          sourceSha256: 'a'.repeat(64),
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
    } as CompositionPlanV2;
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toEqual({ allowed: true });
  });

  it('text font allowlist rejects arbitrary font discovery', () => {
    const candidate = {
      ...plan,
      layers: [
        {
          id: 'title',
          kind: 'text' as const,
          text: 'JOY',
          bitmapAssetId: 'title-bitmap',
          fontId: 'untrusted-font',
          sourceSha256: 'a'.repeat(64),
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
    } as CompositionPlanV2;
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/allowlist/),
    });
  });

  it('text bitmap binding is required before verified delivery', () => {
    const candidate = {
      ...plan,
      layers: [
        {
          id: 'title',
          kind: 'text' as const,
          text: 'JOY',
          fontId: 'falsafeh-light',
          sourceSha256: 'a'.repeat(64),
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
    } as CompositionPlanV2;
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/bitmap binding/),
    });
  });
  it.each([2, 0.5])('allows source-backed video rate %sx in V2 preflight', (playbackRate) => {
    const candidate: CompositionPlanV2 = {
      ...plan,
      layers: [
        {
          id: 'video',
          kind: 'video',
          assetId: 'video',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      planSha256: planDigestV2({
        ...plan,
        layers: [
          {
            id: 'video',
            kind: 'video',
            assetId: 'video',
            startUs: 0,
            durationUs: 1_000_000,
            sourceInUs: 0,
            playbackRate,
            zIndex: 0,
            x: 0,
            y: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
          },
        ],
      }),
    };
    expect(preflightCompositionPlanV2(candidate)).toEqual({ allowed: true });
  });

  it('fails closed for freeze video rate', () => {
    const candidate = {
      ...plan,
      layers: [
        {
          id: 'video',
          kind: 'video' as const,
          assetId: 'video',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate: 0,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
    } as CompositionPlanV2;
    expect(preflightCompositionPlanV2(candidate)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Freeze'),
    });
  });

  it.each([0.1, 0.5, 2, 8])('allows standalone audio playback rate %sx', (playbackRate) => {
    const candidate = {
      ...plan,
      audio: [
        {
          id: 'music',
          sourceKind: 'audio-asset' as const,
          assetId: 'music',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
    };
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toEqual({ allowed: true });
    expect(() => assertPlanV2(signed)).not.toThrow();
  });

  it.each([0, 0.09, 8.01])('rejects invalid standalone audio playback rate %s', (playbackRate) => {
    const candidate = {
      ...plan,
      audio: [
        {
          id: 'music',
          sourceKind: 'audio-asset' as const,
          assetId: 'music',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate,
          gain: 1,
          pan: 0,
          mute: false,
        },
      ],
    };
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toMatchObject({ allowed: false });
    expect(() => assertPlanV2(signed)).toThrow(/playbackRate/);
  });

  it('canonicalizes sorted keys and computes SHA-256', () => {
    expect(canonicalJsonV2({ b: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":1}');
    expect(sha256HexV2('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('requires matching canonical plan, bundle and asset integrity', () => {
    const withDigest = { ...plan, planSha256: planDigestV2(plan) };
    const bundle = createRenderBundleV2({
      plan: withDigest,
      projectRef: 'project-ref',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'video/mp4' },
        },
      },
    });
    expect(bundle.snapshot.planSha256).toBe(withDigest.planSha256);
    expect(bundle.snapshot.bundleSha256).toBe(bundleDigestV2(bundle));
    expect(() =>
      validateRenderBundleV2({
        ...bundle,
        snapshot: { ...bundle.snapshot, bundleSha256: 'b'.repeat(64) },
      }),
    ).toThrow(/digest/);
    expect(() =>
      createRenderBundleV2({
        plan: withDigest,
        projectRef: 'project-ref',
        assets: {
          video: {
            assetId: 'video',
            opaqueRef: 'file:///tmp/video.mp4',
            integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'video/mp4' },
          },
        },
      }),
    ).toThrow(/opaque/);
  });

  it('normalizes flat integrity aliases and ignores volatile createdAt', () => {
    const withDigest = { ...plan, planSha256: planDigestV2(plan) };
    const first = createRenderBundleV2({
      plan: withDigest,
      projectRef: 'project-ref',
      createdAt: '2026-01-01T00:00:00.000Z',
      assets: {
        video: {
          assetId: 'video',
          opaqueRef: 'asset:video',
          sha256: 'a'.repeat(64),
          bytes: 1,
          mimeType: 'video/mp4',
        },
      },
    });
    const second = {
      ...first,
      snapshot: { ...first.snapshot, createdAt: '2027-01-01T00:00:00.000Z' },
    };
    expect(bundleDigestV2(first)).toBe(bundleDigestV2(second));
    expect(first.assets.video?.integrity).toEqual({
      sha256: 'a'.repeat(64),
      bytes: 1,
      mime: 'video/mp4',
    });
  });

  it('includes the normalized master grade in plan and bundle identity', () => {
    const identity = { ...plan, planSha256: planDigestV2(plan) };
    const graded = {
      ...plan,
      colorGrade: { lift: 0.1, gamma: 1.2, gain: 0.9, saturation: 1.1, lutId: 'rec709' as const },
      planSha256: '',
    };
    const gradedSigned = { ...graded, planSha256: planDigestV2(graded) };
    const plainBundle = createRenderBundleV2({
      plan: identity,
      projectRef: 'project-ref',
      assets: {},
    });
    const gradedBundle = createRenderBundleV2({
      plan: gradedSigned,
      projectRef: 'project-ref',
      assets: {},
    });
    expect(gradedBundle.plan.colorGrade).toEqual(graded.colorGrade);
    expect(gradedBundle.snapshot.planSha256).not.toBe(plainBundle.snapshot.planSha256);
    expect(gradedBundle.snapshot.bundleSha256).not.toBe(plainBundle.snapshot.bundleSha256);
  });

  it('canonicalizes identity grades and the no-LUT alias to the same digest', () => {
    const plainDigest = planDigestV2(plan);
    const identityPlan = {
      ...plan,
      colorGrade: { lift: 0, gamma: 1, gain: 1, saturation: 1, lutId: 'none' as const },
    };
    const noLutPlan = {
      ...plan,
      colorGrade: { lift: 0, gamma: 1, gain: 1, saturation: 1 },
    };
    expect(planDigestV2(identityPlan)).toBe(plainDigest);
    expect(planDigestV2(noLutPlan)).toBe(plainDigest);
    const plainBundle = createRenderBundleV2({
      plan: { ...plan, planSha256: plainDigest },
      projectRef: 'project-ref',
      assets: {},
    });
    expect(
      bundleDigestV2({
        ...plainBundle,
        plan: { ...plainBundle.plan, colorGrade: identityPlan.colorGrade },
      }),
    ).toBe(plainBundle.snapshot.bundleSha256);
  });

  it('rejects malformed or unsafe master grades at the V2 boundary', () => {
    const cases = [
      { lift: Number.NaN, gamma: 1, gain: 1, saturation: 1 },
      { lift: 0, gamma: 1, gain: 1.6, saturation: 1 },
      { lift: 0, gamma: 1, gain: 1, saturation: 1, lutId: 'film' },
      { lift: 0, gamma: 1, gain: 1, saturation: 1, unexpected: true },
    ];
    for (const colorGrade of cases) {
      expect(() => assertPlanV2({ ...plan, colorGrade } as unknown as CompositionPlanV2)).toThrow(
        /colorGrade/,
      );
    }
  });

  it('keeps the V2 preflight effect rejection fail-closed', () => {
    const candidate = {
      ...plan,
      layers: [{ id: 'image', kind: 'image', assetId: 'image', effects: [] }],
    } as unknown as CompositionPlanV2;
    expect(preflightCompositionPlanV2(candidate)).toEqual({
      allowed: false,
      reason: 'Effects are not supported for verified delivery.',
    });
  });

  it('admits only static-image brightness/contrast effects and binds them to plan digest', () => {
    const effects = [
      {
        id: 'grade-1',
        effectId: 'brightness-contrast',
        enabled: true,
        params: { brightness: 0.2, contrast: -0.1 },
      },
    ] as const;
    const candidate = {
      ...plan,
      layers: [{ ...plan.layers[0], kind: 'image', assetId: 'image', effects }],
      planSha256: '',
    } as unknown as CompositionPlanV2;
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toEqual({ allowed: true });
    expect(planDigestV2(signed)).not.toBe(planDigestV2(plan));
    for (const bad of [
      [{ id: 'e', effectId: 'sepia', enabled: true, params: { amount: 0.5 } }],
      [
        {
          id: 'e',
          effectId: 'brightness-contrast',
          enabled: true,
          params: { brightness: 2, contrast: 0 },
        },
      ],
      [
        {
          id: 'e',
          effectId: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0, contrast: 0 },
          animations: {},
        },
      ],
    ]) {
      const malformed = {
        ...candidate,
        layers: [{ ...candidate.layers[0], effects: bad }],
        planSha256: '',
      } as unknown as CompositionPlanV2;
      const malformedSigned = { ...malformed, planSha256: planDigestV2(malformed) };
      expect(preflightCompositionPlanV2(malformedSigned)).toMatchObject({ allowed: false });
    }
  });

  it.each(['video', 'text', 'html-scene', 'motion-scene'] as const)(
    'rejects brightness/contrast effects on %s layers',
    (kind) => {
      const layer = {
        id: kind,
        kind,
        assetId: kind,
        ...(kind === 'text'
          ? {
              text: 'x',
              bitmapAssetId: 'bitmap',
              fontId: 'system-ui',
              sourceSha256: 'a'.repeat(64),
            }
          : {}),
        startUs: 0,
        durationUs: 1_000_000,
        zIndex: 1,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        effects: [
          {
            id: 'e',
            effectId: 'brightness-contrast',
            enabled: true,
            params: { brightness: 0, contrast: 0 },
          },
        ],
      };
      const candidate = {
        ...plan,
        layers: [layer],
        planSha256: '',
      } as unknown as CompositionPlanV2;
      const signed = { ...candidate, planSha256: planDigestV2(candidate) };
      expect(preflightCompositionPlanV2(signed)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('static image'),
      });
      expect(() => assertPlanV2(signed)).toThrow(/static image/);
    },
  );

  it('accepts only a bounded master-bus limiter in the normalized V2 plan', () => {
    const limited = {
      ...plan,
      masterLimiter: { ceilingDb: -1, releaseUs: 50_000 },
      planSha256: '',
    } as CompositionPlanV2;
    const signed = { ...limited, planSha256: planDigestV2(limited) };
    expect(preflightCompositionPlanV2(signed)).toEqual({ allowed: true });
    expect(() => assertPlanV2(signed)).not.toThrow();
  });

  it.each([
    { ceilingDb: -25, releaseUs: 50_000 },
    { ceilingDb: 1, releaseUs: 50_000 },
    { ceilingDb: -1, releaseUs: 9_999 },
    { ceilingDb: -1, releaseUs: 1_000_001 },
  ])('rejects an out-of-contract master limiter %#', (masterLimiter) => {
    const candidate = { ...plan, masterLimiter, planSha256: '' } as CompositionPlanV2;
    const signed = { ...candidate, planSha256: planDigestV2(candidate) };
    expect(preflightCompositionPlanV2(signed)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Master limiter'),
    });
    expect(() => assertPlanV2(signed)).toThrow(/Master limiter/);
  });

  it('rejects a video or audio binding masquerading as a static image layer', () => {
    const imagePlan = {
      ...plan,
      layers: [{ id: 'image', kind: 'image', assetId: 'image' }],
      planSha256: '',
    } as unknown as CompositionPlanV2;
    const signed = { ...imagePlan, planSha256: planDigestV2(imagePlan) };
    for (const mime of ['video/mp4', 'audio/mpeg']) {
      expect(() =>
        createRenderBundleV2({
          plan: signed,
          projectRef: 'project-ref',
          assets: {
            image: {
              assetId: 'image',
              opaqueRef: 'asset:image',
              integrity: { sha256: 'a'.repeat(64), bytes: 1, mime },
            },
          },
        }),
      ).toThrow(/image asset binding/);
    }
  });

  it('forbids HTML-scene bindings in the initial V2 delivery envelope', () => {
    expect(() =>
      createRenderBundleV2({
        plan: { ...plan, planSha256: planDigestV2(plan) },
        projectRef: 'project-ref',
        assets: {
          scene: {
            assetId: 'scene',
            opaqueRef: 'html-scene:scene',
            integrity: {
              sha256: 'a'.repeat(64),
              bytes: 1,
              mime: 'application/octet-stream',
            },
          },
        },
      }),
    ).toThrow(/HTML scene/);
  });

  it('admits a published static Motion scene with canonical snapshot and layer binding', () => {
    const snapshot = {
      schemaVersion: 1,
      id: 'scene',
      name: 'Static',
      width: 8,
      height: 8,
      durationMs: 1000,
      frameRate: 30,
      background: { kind: 'solid', color: '#000000' },
      layers: [],
      variables: [],
      components: [],
      markers: [],
    } as const;
    const snapshotSha256 = sha256HexV2(canonicalJsonV2(snapshot));
    const motionPlan = {
      ...plan,
      layers: [
        {
          id: 'motion',
          kind: 'motion-scene' as const,
          assetId: 'scene',
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      planSha256: '',
    };
    const signed = { ...motionPlan, planSha256: planDigestV2(motionPlan) };
    const bundle = createRenderBundleV2({
      plan: signed,
      projectRef: 'project-ref',
      assets: {
        scene: {
          assetId: 'scene',
          opaqueRef: 'motion-scene:scene',
          integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'application/octet-stream' },
          motionScene: { snapshot, snapshotSha256, layers: {} },
        },
      },
    });
    expect(bundle.plan.layers[0]?.kind).toBe('motion-scene');
  });

  it('rejects incomplete and non-static published Motion snapshots', () => {
    const snapshot = {
      schemaVersion: 1,
      id: 'scene',
      name: 'Animated',
      width: 8,
      height: 8,
      durationMs: 1000,
      frameRate: 30,
      background: { kind: 'transparent' },
      layers: [
        {
          id: 'shape',
          type: 'shape',
          name: 'Shape',
          visible: true,
          locked: false,
          transform: {
            x: 0,
            y: 0,
            z: 0,
            width: 4,
            height: 4,
            scaleX: 1,
            scaleY: 1,
            rotationDeg: 0,
            rotationXDeg: 0,
            rotationYDeg: 0,
            skewX: 0,
            skewY: 0,
            transformOriginX: '50%',
            transformOriginY: '50%',
            perspective: 0,
            opacity: 1,
          },
          fills: [{ kind: 'solid', color: '#fff', opacity: 1 }],
          strokes: [],
          shadows: [],
          filters: [],
          blendMode: 'normal',
          borderRadius: [0, 0, 0, 0],
          overflow: 'visible',
          layout: { mode: 'free' },
          children: [],
          animations: [{ property: 'transform.x', curve: { keyframes: [] } }],
        },
      ],
      variables: [],
      components: [],
      markers: [],
    } as unknown as MotionSceneDocument;
    const base = {
      ...plan,
      layers: [
        {
          id: 'motion',
          kind: 'motion-scene' as const,
          assetId: 'scene',
          startUs: 0,
          durationUs: 1_000_000,
          zIndex: 1,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      planSha256: '',
    };
    expect(() =>
      createRenderBundleV2({
        plan: { ...base, planSha256: planDigestV2(base) },
        projectRef: 'p',
        assets: {
          scene: {
            assetId: 'scene',
            opaqueRef: 'motion-scene:scene',
            integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'application/octet-stream' },
          },
        },
      }),
    ).toThrow(/canonical snapshot/);
    const digest = sha256HexV2(canonicalJsonV2(snapshot));
    expect(() =>
      createRenderBundleV2({
        plan: { ...base, planSha256: planDigestV2(base) },
        projectRef: 'p',
        assets: {
          scene: {
            assetId: 'scene',
            opaqueRef: 'motion-scene:scene',
            integrity: { sha256: 'a'.repeat(64), bytes: 1, mime: 'application/octet-stream' },
            motionScene: { snapshot, snapshotSha256: digest, layers: {} },
          },
        },
      }),
    ).toThrow(/static placement/);
  });

  it('fails closed when an image layer has no asset binding', () => {
    const transform = {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotationDeg: 0,
      opacity: 1,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    const timelineProject = {
      schemaVersion: 0 as const,
      id: 'project',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'root',
          width: 64,
          height: 64,
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          tracks: [],
        },
      },
    };
    const visualProject = {
      schemaVersion: 1 as const,
      id: 'project',
      title: 'project',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'root',
          width: 64,
          height: 64,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: { broken: { id: 'broken', kind: 'image' as const, transform } },
      captionDocuments: {},
      pluginData: {},
    };
    expect(() =>
      createCompositionPlanV2({
        timelineProject,
        visualProject,
      }),
    ).toThrow(/missing an asset/);
  });

  it('normalizes and hashes only renderer-safe caption payload fields', () => {
    const base = {
      intent: 'burn-in' as const,
      styleRef: 'joy-clean' as const,
      segments: [
        {
          id: 'clip:rtl',
          startUs: 500_000,
          endUs: 900_000,
          text: 'سلام',
          direction: 'rtl' as const,
        },
        { id: 'clip:ltr', startUs: 0, endUs: 400_000, text: 'JOY', direction: 'ltr' as const },
      ].sort((left, right) => left.startUs - right.startUs),
    };
    const payload = normalizeCaptionBurnInPayloadV2({
      ...base,
      payloadSha256: captionBurnInDigestV2(base),
    });
    expect(payload.segments.map((segment) => segment.direction)).toEqual(['ltr', 'rtl']);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(() =>
      normalizeCaptionBurnInPayloadV2({
        ...payload,
        animationRef: 'pop',
      }),
    ).toThrow(/unsupported field/);
    expect(() =>
      normalizeCaptionBurnInPayloadV2({
        ...payload,
        styleRef: 'provider-style',
      }),
    ).toThrow(/built-in/);
  });

  it('normalizes and hashes only the supported dissolve junction', () => {
    const transitionBase = {
      id: 't1',
      trackId: 'V1',
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'dissolve' as const,
      durationUs: 250_000,
      startUs: 750_000,
      endUs: 1_000_000,
    };
    const transition = normalizeTransitionV2({
      ...transitionBase,
      transitionSha256: transitionDigestV2(transitionBase),
    });
    expect(transition.transitionSha256).toBe(transitionDigestV2(transition));
    expect(Object.isFrozen(transition)).toBe(true);
    expect(() => normalizeTransitionV2({ ...transition, type: 'wipe' })).toThrow(/dissolve/);
    expect(() =>
      normalizeTransitionV2({ ...transition, transitionSha256: 'a'.repeat(64) }),
    ).toThrow(/digest mismatch/);
  });

  it('rejects a dissolve whose active interval is not a contiguous clip junction', () => {
    const transitionBase = {
      id: 't1',
      trackId: 'V1',
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'dissolve' as const,
      durationUs: 250_000,
      startUs: 700_000,
      endUs: 950_000,
    };
    const transition = { ...transitionBase, transitionSha256: transitionDigestV2(transitionBase) };
    const invalidUnsigned: Omit<CompositionPlanV2, 'planSha256'> = {
      ...plan,
      durationUs: 2_000_000,
      layers: [
        {
          id: 'left',
          kind: 'video',
          trackId: 'V1',
          assetId: 'a',
          startUs: 0,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
        {
          id: 'right',
          kind: 'video',
          trackId: 'V1',
          assetId: 'b',
          startUs: 1_000_000,
          durationUs: 1_000_000,
          sourceInUs: 0,
          playbackRate: 1,
          zIndex: 0,
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
        },
      ],
      transitions: [transition],
    };
    expect(() =>
      assertPlanV2({
        ...invalidUnsigned,
        planSha256: planDigestV2(invalidUnsigned),
      } as CompositionPlanV2),
    ).toThrow(/active junction/);

    const validTransitionBase = {
      id: 't1',
      trackId: 'V1',
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'dissolve' as const,
      durationUs: 250_000,
      startUs: 750_000,
      endUs: 1_000_000,
    };
    const validTransition = {
      ...validTransitionBase,
      transitionSha256: transitionDigestV2(validTransitionBase),
    };
    const validPlan = { ...invalidUnsigned, transitions: [validTransition] };
    expect(() =>
      assertPlanV2({ ...validPlan, planSha256: planDigestV2(validPlan) } as CompositionPlanV2),
    ).not.toThrow();
    const tooManyTransitions = { ...validPlan, transitions: [validTransition, validTransition] };
    expect(() =>
      assertPlanV2({
        ...tooManyTransitions,
        planSha256: planDigestV2(tooManyTransitions),
      } as CompositionPlanV2),
    ).toThrow(/at most one/);
    const thirdVideo = { ...invalidUnsigned.layers[1]!, id: 'third', startUs: 2_000_000 };
    const tooManyVideos = { ...validPlan, layers: [...validPlan.layers, thirdVideo] };
    expect(() =>
      assertPlanV2({
        ...tooManyVideos,
        planSha256: planDigestV2(tooManyVideos),
      } as CompositionPlanV2),
    ).toThrow(/exactly two video clips/);
  });
});
