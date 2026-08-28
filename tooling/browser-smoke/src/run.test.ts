import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_CORE_CONTROL_SPECS,
  AUTHENTICATED_SHELL_VIEWPORTS,
  buildBrowserSmokeCliPlan,
  clippedCoreControls,
  hasPageOverflow,
  workspaceFitsViewport,
} from './run.js';

describe('browser smoke CLI planning', () => {
  it('reuses an external browser URL without starting a local server', () => {
    const plan = buildBrowserSmokeCliPlan(
      { JOY_MEDIA_BROWSER_URL: 'http://127.0.0.1:6199' },
      'linux',
    );

    expect(plan.baseUrl).toBe('http://127.0.0.1:6199');
    expect(plan.server).toBeUndefined();
  });

  it('starts the repo editor dev server with the platform pnpm executable by default', () => {
    const plan = buildBrowserSmokeCliPlan({ JOY_MEDIA_BROWSER_PORT: '6123' }, 'win32');

    expect(plan.baseUrl).toBe('http://127.0.0.1:6123');
    expect(plan.server).toEqual({
      command: 'pnpm.cmd',
      args: [
        '--filter',
        '@joy-media/editor-web',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        '6123',
        '--strictPort',
      ],
      port: 6123,
    });
  });

  it('covers the authenticated shell at the supported desktop viewport matrix', () => {
    expect(AUTHENTICATED_SHELL_VIEWPORTS).toEqual([
      { width: 1024, height: 768 },
      { width: 1280, height: 720 },
      { width: 1440, height: 900 },
    ]);
  });

  it('defines stable named locators for every required shell control', () => {
    expect(AUTHENTICATED_CORE_CONTROL_SPECS).toEqual([
      { name: 'Import media', selector: 'button[aria-label="Import media"]' },
      { name: 'Export action', selector: 'button.header-export-btn' },
      { name: 'Delivery action', selector: 'button.header-deliver-btn' },
      { name: 'Timeline seek', selector: 'button[aria-label="Seek forward 1s"]' },
      { name: 'Timeline clip', selector: '.timeline-clip' },
    ]);
    const controls = AUTHENTICATED_CORE_CONTROL_SPECS.map((spec, index) => ({
      name: spec.name,
      index,
      rect: { left: 8, top: 8, right: 120, bottom: 40 },
    }));
    expect(controls.every((control) => control.name && Number.isInteger(control.index))).toBe(true);
    expect(
      controls.every(
        (control) => Object.keys(control.rect).sort().join(',') === 'bottom,left,right,top',
      ),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(controls))).toEqual(controls);
  });

  it('distinguishes document overflow from intentional internal scrolling', () => {
    expect(
      hasPageOverflow({ innerWidth: 1024, innerHeight: 768, scrollWidth: 1024, scrollHeight: 768 }),
    ).toBe(false);
    expect(
      hasPageOverflow({ innerWidth: 1024, innerHeight: 768, scrollWidth: 1025, scrollHeight: 768 }),
    ).toBe(true);
    expect(
      hasPageOverflow({ innerWidth: 1024, innerHeight: 768, scrollWidth: 1024, scrollHeight: 769 }),
    ).toBe(true);
    const internallyScrollable = {
      innerWidth: 1024,
      innerHeight: 768,
      scrollWidth: 1024,
      scrollHeight: 768,
    };
    expect(hasPageOverflow(internallyScrollable)).toBe(false);
    const clipped = clippedCoreControls(
      [{ name: 'Timeline clip', index: 0, rect: { left: -2, top: 8, right: 100, bottom: 40 } }],
      { width: 1024, height: 768 },
    );
    expect(JSON.parse(JSON.stringify(clipped))).toEqual([
      { name: 'Timeline clip', index: 0, rect: { left: -2, top: 8, right: 100, bottom: 40 } },
    ]);
  });

  it('requires the Dockview workspace host to stay below the app header', () => {
    expect(workspaceFitsViewport({ top: 40, bottom: 768, height: 728 }, { height: 768 })).toBe(
      true,
    );
    expect(workspaceFitsViewport({ top: 40, bottom: 808, height: 768 }, { height: 768 })).toBe(
      false,
    );
  });
});
