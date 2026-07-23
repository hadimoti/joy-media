import { describe, expect, it } from 'vitest';
import {
  DEMO_PANEL_PLUGIN_ID,
  createEditorPluginHost,
} from './plugin-host.js';

describe('WP-18 plugin host', () => {
  it('seeds the demo panel disabled under safe mode by default', () => {
    const storage = new Map<string, string>();
    const host = createEditorPluginHost({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    expect(host.isSafeMode()).toBe(true);
    expect(host.list()).toHaveLength(1);
    expect(host.list()[0]?.state).toBe('disabled');
    expect(host.canMountDemoPanel()).toBe(false);
    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({
      ok: false,
      issues: ['plugin/enable-denied:safe-mode'],
    });
  });

  it('enables mount only when safe mode is off, and preserves project data on disable', () => {
    const storage = new Map<string, string>();
    const host = createEditorPluginHost({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    host.setSafeMode(false);
    expect(host.enable(DEMO_PANEL_PLUGIN_ID)).toEqual({ ok: true });
    expect(host.canMountDemoPanel()).toBe(true);
    host.setProjectData(DEMO_PANEL_PLUGIN_ID, { note: 'keep-me' });
    expect(host.disable(DEMO_PANEL_PLUGIN_ID)).toBe(true);
    expect(host.canMountDemoPanel()).toBe(false);
    expect(host.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });

    const reopened = createEditorPluginHost({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    expect(reopened.isSafeMode()).toBe(false);
    expect(reopened.list()[0]?.state).toBe('disabled');
    expect(reopened.getProjectData(DEMO_PANEL_PLUGIN_ID)).toEqual({ note: 'keep-me' });
  });
});
