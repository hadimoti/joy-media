import { describe, expect, it } from 'vitest';
import { textGradientAnchors } from './text-style.js';
import { DEFAULT_TEXT_STYLE_V1 } from './text-style.js';
import { validateJoyProjectV1 } from './v1.js';

describe('text gradient anchors', () => {
  it('draws the saved angle through the centre when no anchors are saved', () => {
    const { start, end } = textGradientAnchors({ angleDeg: 0 });
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0.5);
    expect(end.x).toBeCloseTo(1);
    expect(end.y).toBeCloseTo(0.5);
    const down = textGradientAnchors({ angleDeg: 90 });
    expect(down.start.y).toBeCloseTo(0);
    expect(down.end.y).toBeCloseTo(1);
  });

  it('uses the saved anchors when both are saved', () => {
    const start = { x: 0.1, y: 0.2 };
    const end = { x: 0.9, y: 0.8 };
    expect(textGradientAnchors({ angleDeg: 45, start, end })).toEqual({ start, end });
  });

  it('ignores a lone anchor and keeps the angle', () => {
    const { start, end } = textGradientAnchors({ angleDeg: 0, start: { x: 0.3, y: 0.3 } });
    expect(start.x).toBeCloseTo(0);
    expect(end.x).toBeCloseTo(1);
  });
});

function projectWithFill(fill: unknown) {
  return {
    schemaVersion: 1,
    id: 'p',
    name: 'p',
    visualObjects: {
      t: {
        id: 't',
        kind: 'text',
        text: 'Hi',
        textStyle: { ...DEFAULT_TEXT_STYLE_V1, fill },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0, opacity: 1 },
      },
    },
  };
}

describe('text gradient anchors in a saved project', () => {
  const stops = [
    { offset: 0, color: '#ffffff' },
    { offset: 1, color: '#f6c453' },
  ];
  const textDiagnostics = (fill: unknown) =>
    validateJoyProjectV1(projectWithFill(fill)).filter((d) => d.code === 'PROJECT_SCHEMA_V1_TEXT');

  it('accepts a gradient without anchors (every project saved before them)', () => {
    expect(textDiagnostics({ kind: 'linear-gradient', angleDeg: 20, stops })).toEqual([]);
  });

  it('accepts anchors inside the text box and a little beyond it', () => {
    expect(
      textDiagnostics({
        kind: 'linear-gradient',
        angleDeg: 20,
        stops,
        start: { x: -0.25, y: 0 },
        end: { x: 1.25, y: 1 },
      }),
    ).toEqual([]);
  });

  it('refuses an anchor that is not a finite point near the box', () => {
    const bad = {
      kind: 'linear-gradient',
      angleDeg: 20,
      stops,
      start: { x: Number.NaN, y: 0 },
      end: { x: 1, y: 1 },
    };
    expect(textDiagnostics(bad).length).toBeGreaterThan(0);
    expect(
      textDiagnostics({ ...bad, start: { x: 0, y: 0 }, end: { x: 99, y: 0 } }).length,
    ).toBeGreaterThan(0);
    expect(
      textDiagnostics({ ...bad, start: { x: 0, y: 0 }, end: undefined }).length,
    ).toBeGreaterThan(0);
  });
});
