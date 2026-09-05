import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONITOR_ASPECT_RATIO,
  MONITOR_ASPECT_RATIO_PRESETS,
  MonitorAspectRatioSelector,
  monitorAspectRatioCssValue,
  monitorAspectRatioDimensions,
  monitorAspectRatioForDimensions,
  monitorAspectRatioLabel,
} from './MonitorAspectRatioSelector.js';

describe('MonitorAspectRatioSelector', () => {
  it('keeps the existing Fit behavior as its uncontrolled default', () => {
    const markup = renderToStaticMarkup(<MonitorAspectRatioSelector />);

    expect(DEFAULT_MONITOR_ASPECT_RATIO).toBe('fit');
    expect(monitorAspectRatioCssValue('fit')).toBeUndefined();
    expect(markup).toContain('aria-label="Canvas aspect ratio (Fit)"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('data-guide="Ratio"');
  });

  it('exposes all common landscape, square, and portrait presets', () => {
    expect(MONITOR_ASPECT_RATIO_PRESETS.map((preset) => preset.id)).toEqual([
      'fit',
      '16:9',
      '4:3',
      '3:2',
      '21:9',
      '1:1',
      '9:16',
      '4:5',
      '3:4',
      '2:3',
    ]);
    expect(monitorAspectRatioCssValue('16:9')).toBe('16 / 9');
    expect(monitorAspectRatioCssValue('1:1')).toBe('1 / 1');
    expect(monitorAspectRatioCssValue('9:16')).toBe('9 / 16');
    expect(monitorAspectRatioLabel('21:9')).toBe('21:9');
    expect(monitorAspectRatioDimensions('21:9')).toEqual({ width: 2520, height: 1080 });
    expect(monitorAspectRatioDimensions('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(monitorAspectRatioDimensions('fit')).toBeUndefined();
    expect(monitorAspectRatioForDimensions(1080, 1920)).toBe('9:16');
    expect(monitorAspectRatioForDimensions(1080, 1080)).toBe('1:1');
    expect(monitorAspectRatioForDimensions(1234, 567)).toBe('fit');
  });

  it('renders a controlled selection as an accessible radio menu state', () => {
    const markup = renderToStaticMarkup(
      <MonitorAspectRatioSelector
        selectedAspectRatio="9:16"
        onAspectRatioChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Canvas aspect ratio (9:16)"');
    expect(markup).toContain('title="Canvas format: 9:16"');
    expect(markup).toContain('monitor-aspect-ratio-trigger-details');
    expect(markup).toContain('role="menu"');
    expect(markup).toContain('aria-label="Landscape"');
    expect(markup).toContain('aria-label="Square"');
    expect(markup).toContain('aria-label="Portrait"');
    expect(markup).toContain('data-monitor-aspect-ratio-option="9:16"');
    expect(markup).toContain('role="menuitemradio"');
    expect(markup).toContain('aria-checked="true"');
  });
});
