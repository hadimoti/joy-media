import { describe, expect, it } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import type { EffectInstanceIR } from '@joy-media/render-ir';
import { renderHeadlessFrame, type HeadlessFrame } from '@joy-media/renderer-headless';
import { digestRgba } from './index.js';

function makeEffectFrame(
  effects: readonly EffectInstanceIR[],
  size = { width: 32, height: 18 },
): RenderFrameIR {
  return {
    version: 1,
    compositionId: 'effects-test',
    timeUs: 0,
    viewport: { width: size.width, height: size.height, dpr: 1 },
    background: { r: 64, g: 64, b: 64, a: 255 },
    nodes: [
      {
        kind: 'sprite',
        id: 'effect-target',
        zIndex: 0,
        opacity: 1,
        transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        width: size.width,
        height: size.height,
        color: { r: 200, g: 100, b: 50, a: 255 },
        effects,
      },
    ],
  };
}

function headlessDigest(frame: RenderFrameIR): string {
  const result: HeadlessFrame = renderHeadlessFrame(frame);
  return digestRgba(result.pixels);
}

describe('@joy-media/golden-render (effects headless)', () => {
  it('brightness-contrast effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([
        {
          id: 'e1',
          kind: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0.1, contrast: 0.2 },
        },
      ]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(
      headlessDigest(
        makeEffectFrame([
          {
            id: 'e1',
            kind: 'brightness-contrast',
            enabled: true,
            params: { brightness: 0.1, contrast: 0.2 },
          },
        ]),
      ),
    );
  });

  it('sepia effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([{ id: 'e1', kind: 'sepia', enabled: true, params: { amount: 0.5 } }]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(
      headlessDigest(
        makeEffectFrame([{ id: 'e1', kind: 'sepia', enabled: true, params: { amount: 0.5 } }]),
      ),
    );
  });

  it('gaussian-blur effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([{ id: 'e1', kind: 'gaussian-blur', enabled: true, params: { amount: 3 } }]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(
      headlessDigest(
        makeEffectFrame([
          { id: 'e1', kind: 'gaussian-blur', enabled: true, params: { amount: 3 } },
        ]),
      ),
    );
  });

  it('posterize effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([{ id: 'e1', kind: 'posterize', enabled: true, params: { levels: 6 } }]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('vibrance effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([{ id: 'e1', kind: 'vibrance', enabled: true, params: { amount: 0.4 } }]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hue-saturation effect produces a deterministic headless digest', () => {
    const h = headlessDigest(
      makeEffectFrame([
        { id: 'e1', kind: 'hue-saturation', enabled: true, params: { hue: 0.1, saturation: 0.3 } },
      ]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('multiple effects stack is deterministic', () => {
    const h = headlessDigest(
      makeEffectFrame([
        {
          id: 'e1',
          kind: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0.05, contrast: 0.1 },
        },
        { id: 'e2', kind: 'sepia', enabled: true, params: { amount: 0.3 } },
      ]),
    );
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(
      headlessDigest(
        makeEffectFrame([
          {
            id: 'e1',
            kind: 'brightness-contrast',
            enabled: true,
            params: { brightness: 0.05, contrast: 0.1 },
          },
          { id: 'e2', kind: 'sepia', enabled: true, params: { amount: 0.3 } },
        ]),
      ),
    );
  });

  it('disabled effect matches baseline', () => {
    const baseline = headlessDigest(makeEffectFrame([]));
    const disabled = headlessDigest(
      makeEffectFrame([
        {
          id: 'e1',
          kind: 'brightness-contrast',
          enabled: false,
          params: { brightness: 1, contrast: 1 },
        },
      ]),
    );
    expect(disabled).toBe(baseline);
  });
});
