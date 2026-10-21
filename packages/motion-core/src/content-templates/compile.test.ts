import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileTitleInstance, serializeTemplate, templateSha256 } from './index.js';
import type { TitleCompileRequest } from './compile.js';

const measure = (text: string, size: number) => ([...text].length * size) / 2;
function request(overrides: Partial<TitleCompileRequest> = {}): TitleCompileRequest {
  return {
    instanceId: 'speaker',
    templateId: 'joy.p0.title',
    objectId: 'object-speaker',
    clipId: 'clip-speaker',
    lines: { primary: 'Hello', secondary: 'Welcome' },
    direction: 'ltr',
    font: { family: 'Noto Sans Arabic', weight: 700 },
    fontSha256: `sha256:${'a'.repeat(64)}`,
    placement: { xPx: 100, yPx: 100, maxWidthPx: 800, safeInsetPx: 20 },
    motion: { presetId: 'joy-fade-in', inUs: 200_000, outUs: 200_000 },
    clipDurationUs: 2_000_000,
    frame: { widthPx: 1280, heightPx: 720 },
    ...overrides,
  };
}

describe('compileTitleInstance', () => {
  it('produces the golden short English title layout', () => {
    const result = compileTitleInstance(request(), measure);
    expect(result).toMatchObject({
      ok: true,
      instance: {
        templateId: 'joy.p0.title',
        templateVersion: 1,
        compilerVersion: 1,
        objectId: 'object-speaker',
        clipId: 'clip-speaker',
        layout: {
          primaryLines: ['Hello'],
          secondaryLines: ['Welcome'],
          fontSizePx: 48,
          secondarySizePx: 30,
          lineHeightPx: 60,
          boxHeightPx: 98,
        },
      },
    });
  });
  it('preserves an RTL Arabic headline in its wrapped order', () => {
    const result = compileTitleInstance(
      request({
        direction: 'rtl',
        lines: {
          primary: '\u0633\u0644\u0627\u0645 \u062f\u0646\u06cc\u0627',
          secondary: '\u0632\u06cc\u0631\u0646\u0648\u06cc\u0633',
        },
      }),
      measure,
    );
    expect(result).toMatchObject({
      ok: true,
      instance: {
        direction: 'rtl',
        lines: { primary: '\u0633\u0644\u0627\u0645 \u062f\u0646\u06cc\u0627' },
        layout: {
          primaryLines: ['\u0633\u0644\u0627\u0645 \u062f\u0646\u06cc\u0627'],
          secondaryLines: ['\u0632\u06cc\u0631\u0646\u0648\u06cc\u0633'],
        },
      },
    });
  });
  it('wraps the primary line into two lines without losing words', () => {
    const source = 'one two three four';
    const result = compileTitleInstance(
      request({
        lines: { primary: source, secondary: '' },
        placement: { xPx: 0, yPx: 0, maxWidthPx: 200, safeInsetPx: 0 },
      }),
      measure,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.instance.layout.primaryLines).toHaveLength(2);
      expect(result.instance.layout.primaryLines.join(' ')).toBe(source);
    }
  });
  it('shrinks primary text when the largest size does not fit', () => {
    const result = compileTitleInstance(
      request({
        lines: { primary: 'abcdefgh', secondary: '' },
        placement: { xPx: 0, yPx: 0, maxWidthPx: 135, safeInsetPx: 0 },
      }),
      measure,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.layout.fontSizePx).toBeLessThan(48);
  });
  it('returns TEXT_OVERFLOW when 24px cannot fit', () => {
    expect(
      compileTitleInstance(
        request({
          lines: { primary: 'abcdefgh', secondary: '' },
          placement: { xPx: 0, yPx: 0, maxWidthPx: 90, safeInsetPx: 0 },
        }),
        measure,
      ),
    ).toMatchObject({ ok: false, code: 'TEXT_OVERFLOW' });
  });
  it('rejects an ID that differs from its derived clip or object id', () => {
    expect(compileTitleInstance(request({ objectId: 'wrong' }), measure)).toMatchObject({
      ok: false,
      code: 'ID_CONFLICT',
    });
  });
  it('returns the specified validation errors', () => {
    expect(compileTitleInstance(request({ templateId: 'unsupported' }), measure)).toMatchObject({
      ok: false,
      code: 'TEMPLATE_UNSUPPORTED',
    });
    expect(
      compileTitleInstance(
        request({ font: { family: 'Arial' as 'Noto Sans Arabic', weight: 700 } }),
        measure,
      ),
    ).toMatchObject({ ok: false, code: 'FONT_UNAVAILABLE' });
    expect(
      compileTitleInstance(request({ lines: { primary: '  ', secondary: '' } }), measure),
    ).toMatchObject({ ok: false, code: 'PRIMARY_REQUIRED' });
    expect(
      compileTitleInstance(
        request({ motion: { presetId: 'hold', inUs: 1_000_000, outUs: 1_000_001 } }),
        measure,
      ),
    ).toMatchObject({ ok: false, code: 'RANGE_ERROR' });
  });
  it('rejects a title box that leaves the frame safe area', () => {
    expect(
      compileTitleInstance(
        request({ placement: { xPx: 100, yPx: 700, maxWidthPx: 800, safeInsetPx: 20 } }),
        measure,
      ),
    ).toMatchObject({ ok: false, code: 'TEXT_OVERFLOW' });
  });

  it('matches the standard SHA-256 digest of each serialized template', () => {
    for (const id of ['joy.p0.title', 'joy.p0.lower-third'] as const) {
      expect(templateSha256(id)).toBe(
        `sha256:${createHash('sha256').update(serializeTemplate(id)).digest('hex')}`,
      );
    }
  });

  it('returns stable, distinct catalog hashes for each P0 template', () => {
    expect(templateSha256('joy.p0.title')).toBe(templateSha256('joy.p0.title'));
    expect(templateSha256('joy.p0.title')).not.toBe(templateSha256('joy.p0.lower-third'));
    expect(templateSha256('joy.p0.title')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
