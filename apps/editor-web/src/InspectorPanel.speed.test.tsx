import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  formatInspectorSpeedRate,
  InspectorPanel,
  SpeedSection,
  validInspectorSpeedRate,
} from './InspectorPanel.js';

describe('Inspector Speed tab controls', () => {
  it('keeps the Speed tab available when the timeline supplies a selected clip', () => {
    const markup = renderToStaticMarkup(
      <InspectorPanel
        object={undefined}
        selectedClipId="clip-video-1"
        clipSpeed={{ rate: 1, supportsReverse: true }}
        onSpeedChange={() => undefined}
        allObjects={{}}
        playheadUs={0}
        onSetStatic={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-label="Speed"');
    expect(markup).not.toContain('joy-panel-body is-inactive');
  });

  it('renders manual, common-rate, reverse, and ramp controls for a capable video clip', () => {
    const markup = renderToStaticMarkup(
      <SpeedSection
        open={true}
        onToggle={() => undefined}
        clipId="clip-video-1"
        speed={{ rate: 1.25, supportsReverse: true, supportsRamps: true, ramp: 'ease-in-out' }}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Speed"');
    expect(markup).toContain('id="insp-speed-rate-clip-video-1"');
    expect(markup).toContain('aria-label="Set speed to 0.25×"');
    expect(markup).toContain('aria-label="Set speed to 1.25×"');
    expect(markup).toContain('aria-label="Set speed to reverse"');
    expect(markup).toContain('aria-label="Speed ramp presets"');
    expect(markup).toContain('aria-label="Ease In/Out"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('keeps unsupported reverse and ramp actions visibly disabled', () => {
    const markup = renderToStaticMarkup(
      <SpeedSection
        open={true}
        onToggle={() => undefined}
        clipId="clip-image-1"
        speed={{ rate: 1 }}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('title="Reverse is unavailable for this clip"');
    expect(markup).toContain('Speed ramps are unavailable for this clip.');
    expect(markup).toContain('disabled=""');
  });

  it('validates manual rates without folding freeze or unsupported reverse into a speed edit', () => {
    expect(validInspectorSpeedRate(0)).toBeUndefined();
    expect(validInspectorSpeedRate(-1)).toBeUndefined();
    expect(validInspectorSpeedRate(-1, true)).toBe(-1);
    expect(validInspectorSpeedRate(8)).toBe(8);
    expect(validInspectorSpeedRate(8.01)).toBeUndefined();
    expect(formatInspectorSpeedRate(-1.25)).toBe('−1.25×');
  });

  it('keeps freeze frames read-only instead of converting them to one times speed', () => {
    const markup = renderToStaticMarkup(
      <SpeedSection
        open={true}
        onToggle={() => undefined}
        clipId="freeze-clip"
        speed={{ rate: 0 }}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('This is a freeze frame.');
    expect(markup).not.toContain('insp-speed-rate-freeze-clip');
  });
});
