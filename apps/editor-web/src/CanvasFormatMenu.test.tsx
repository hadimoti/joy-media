import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExportPresetId } from '@joy-media/project-schema';
import { describe, expect, it } from 'vitest';
import { CanvasFormatPopover } from './CanvasFormatMenu.js';
import { EXPORT_PRESET_MENU_IDS } from './export-presets.js';
import type { PopupControl } from './popup-manager.js';

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

const openPopup: PopupControl = {
  open: true,
  show: () => undefined,
  toggle: () => undefined,
  close: () => undefined,
  rootRef: () => undefined,
};

function renderPopover(width = 1920, height = 1080, presetId: ExportPresetId = 'youtube-1080') {
  return renderToStaticMarkup(
    <CanvasFormatPopover
      popup={openPopup}
      width={width}
      height={height}
      presetId={presetId}
      onApplyCanvas={() => undefined}
      onApplyPreset={() => undefined}
    />,
  );
}

describe('CanvasFormatPopover', () => {
  it('has both sections: Canvas and Export preset', () => {
    const markup = renderPopover();

    expect(markup).toContain('aria-labelledby="canvas-format-heading-canvas"');
    expect(markup).toContain('<h3 id="canvas-format-heading-canvas">Canvas</h3>');
    expect(markup).toContain('aria-labelledby="canvas-format-heading-preset"');
    expect(markup).toContain('<h3 id="canvas-format-heading-preset">Export preset</h3>');
  });

  it('shows the read-out of the current format at the top', () => {
    expect(renderPopover()).toContain('16:9 · 1920×1080 · YouTube · 1080p');
  });

  it('offers the nine canvas shapes, with the current one pressed', () => {
    const markup = renderPopover(1080, 1920, 'tiktok-1080');

    expect(markup.match(/class="canvas-format-shape"/g)).toHaveLength(9);
    expect(markup).toContain('aria-pressed="true" title="9:16 · 1080×1920"');
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('has width and height fields and an apply control for a typed size', () => {
    const markup = renderPopover();

    expect(markup).toContain('aria-label="Canvas size"');
    expect(markup).toContain('>Width<');
    expect(markup).toContain('>Height<');
    expect(markup).toContain('Apply size');
  });

  it('lists exactly the export presets of the T-N02 menu', () => {
    const markup = renderPopover();
    const items = markup.match(/role="menuitemradio"/g) ?? [];

    expect(items).toHaveLength(EXPORT_PRESET_MENU_IDS.length);
    expect(markup).toContain('aria-label="Export preset"');
  });

  it('has no Fit choice and no Preview view-only group', () => {
    const markup = renderPopover();

    expect(markup).not.toContain('Preview — view only');
    expect(markup).not.toContain('monitor-preview-only');
    expect(markup).not.toContain('data-monitor-aspect-ratio-option="fit"');
    expect(markup).not.toContain('>Fit<');
  });

  it('is a named dialog, as the other header and monitor popups are', () => {
    const markup = renderPopover();

    expect(markup).toMatch(/<section[^>]*role="dialog"[^>]*aria-label="Format"/);
  });

  it('gives its icon-only close button an accessible name and a tooltip', () => {
    const markup = renderPopover();

    expect(markup).toContain('aria-label="Close format options"');
    expect(markup).toContain('title="Close"');
  });
});

describe('the Format control replaces the old export preset menu', () => {
  const appSource = readFileSync(join(SOURCE_DIR, 'App.tsx'), 'utf8');

  it('App no longer has a header export preset menu', () => {
    expect(appSource).not.toContain('header-export-preset');
    expect(appSource).not.toContain('exportPresetMenu');
    expect(appSource).not.toContain('POPUP_IDS.exportPreset');
  });

  it('the preset list is built in one place only: the Format popover', () => {
    const files = ['CanvasFormatMenu.tsx', 'App.tsx', 'monitor/MonitorTransport.tsx'];
    const usingList = files.filter((name) =>
      readFileSync(join(SOURCE_DIR, name), 'utf8').includes('EXPORT_PRESET_MENU_IDS'),
    );

    expect(usingList).toEqual(['CanvasFormatMenu.tsx']);
  });

  it('App mounts the popover once, from the header Format control', () => {
    expect(appSource.match(/<CanvasFormatPopover/g)).toHaveLength(1);
    expect(appSource).toContain('ref={formatMenu.rootRef}');
  });

  it('lists presets grouped by shape and keeps the header button and preset icons aligned', () => {
    expect(EXPORT_PRESET_MENU_IDS.slice(0, 3)).toEqual([
      'youtube-1080',
      'landscape-4k',
      'high-bitrate',
    ]);
    const css = readFileSync(join(SOURCE_DIR, 'app.css'), 'utf8');
    // The header Format button sits in a stretched flex wrapper: it must centre itself.
    expect(css).toMatch(/\.header-format-btn \{[^}]*align-self: center;/);
    // The icon group must not take the whole row (it pushed the label to the right edge).
    expect(css).toMatch(/\.export-preset-list \.preset-icon-group \{[^}]*width: 1\.5rem;/);
  });

  it('the header Format button keeps its full read-out as an accessible name at every width', () => {
    // At 75rem and below .header-format-btn-label is display:none, so the name must be explicit.
    expect(appSource).toContain('aria-label={`Format: ${formatReadout}`}');
    expect(appSource).toContain('title={`Format: ${formatReadout}. Canvas and export preset.`}');
  });
});
