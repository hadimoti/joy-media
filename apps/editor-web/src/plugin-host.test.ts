import { describe, expect, it } from 'vitest';
import { DEMO_PANEL_PLUGIN_ID, createEditorPluginHost } from './plugin-host.js';

describe('WP-18 plugin host', () => {
  it('keeps the demo panel unavailable by default', () => {
    const storage = new Map<string, string>();
    const host = createEditorPluginHost({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    expect(host.isSafeMode()).toBe(true);
    expect(host.list()).toHaveLength(0);
    expect(host.canMountDemoPanel()).toBe(false);
    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({
      ok: false,
      issues: ['plugin/not-installed'],
    });
  });

  it('enables experimental demo mount only when explicitly registered, and preserves project data on disable', () => {
    const storage = new Map<string, string>();
    const host = createEditorPluginHost(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      { enableExperimentalDemoPanel: true },
    );
    expect(host.list()).toHaveLength(1);
    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({
      ok: false,
      issues: ['plugin/enable-denied:safe-mode'],
    });
    host.setSafeMode(false);
    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({ ok: true });
    expect(host.canMountDemoPanel()).toBe(true);
    host.setProjectData(DEMO_PANEL_PLUGIN_ID, { note: 'keep-me' });
    expect(host.disable(DEMO_PANEL_PLUGIN_ID)).toBe(true);
    expect(host.canMountDemoPanel()).toBe(false);
    expect(host.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });

    const reopened = createEditorPluginHost(
      {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
      { enableExperimentalDemoPanel: true },
    );
    expect(reopened.isSafeMode()).toBe(false);
    expect(reopened.list()[0]?.state).toBe('disabled');
    expect(reopened.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });
  });
});
