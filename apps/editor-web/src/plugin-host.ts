// apps/editor-web/src/plugin-host.ts

import {
  FirstPartyPluginHost,
  createPluginSdkHost,
  type FirstPartyInstalledPlugin,
  type PluginExecutionPolicy,
  type PluginManifestV1,
  type PluginPermission,
} from '@joy-media/plugin-sdk/browser';

export const DEMO_PANEL_PLUGIN_ID = 'joy.first-party.demo-panel';

export const DEMO_PANEL_MANIFEST: PluginManifestV1 = {
  manifestVersion: 1,
  id: DEMO_PANEL_PLUGIN_ID,
  name: 'Demo Panel',
  version: '1.0.0',
  publisher: 'JOY',
  joyApi: '>=1.0.0 <2.0.0',
  entrypoints: { ui: 'ui/demo-panel.js' },
  contributes: { panels: ['joy.first-party.demo-panel.view'] },
  permissions: ['ui.panel', 'project.read.metadata'],
};

const STORAGE_KEY = 'joy-media.plugin-host.v1';

interface PersistedHostState {
  readonly safeMode: boolean;
  readonly enabledIds: readonly string[];
  readonly projectData: Readonly<Record<string, unknown>>;
}

function defaultPolicy(safeMode: boolean): PluginExecutionPolicy {
  const approvedPermissions = new Set<PluginPermission>(['ui.panel', 'project.read.metadata']);
  return { safeMode, approvedPermissions };
}

export interface EditorPluginHost {
  readonly sdk: ReturnType<typeof createPluginSdkHost>;
  readonly host: FirstPartyPluginHost;
  list(): readonly FirstPartyInstalledPlugin[];
  isSafeMode(): boolean;
  setSafeMode(safeMode: boolean): void;
  enable(pluginId: string): { readonly ok: boolean; readonly issues?: readonly string[] };
  disable(pluginId: string): boolean;
  canMountDemoPanel(): boolean;
  /** Opaque namespaced project data — survives disable (non-destructive). */
  getProjectData(pluginId: string): unknown;
  setProjectData(pluginId: string, value: unknown): void;
}

export interface EditorPluginHostOptions {
  readonly enableExperimentalDemoPanel?: boolean;
}

export function createEditorPluginHost(
  storage:
    | { getItem(key: string): string | null; setItem(key: string, value: string): void }
    | undefined = typeof window !== 'undefined' ? window.localStorage : undefined,
  options: EditorPluginHostOptions = {},
): EditorPluginHost {
  const persisted = (() => {
    if (storage === undefined) {
      return {
        safeMode: true,
        enabledIds: [] as string[],
        projectData: {} as Record<string, unknown>,
      };
    }
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw === null) {
        return {
          safeMode: true,
          enabledIds: [] as string[],
          projectData: {} as Record<string, unknown>,
        };
      }
      const parsed = JSON.parse(raw) as PersistedHostState;
      return {
        safeMode: parsed.safeMode === true,
        enabledIds: Array.isArray(parsed.enabledIds)
          ? parsed.enabledIds.filter((id): id is string => typeof id === 'string')
          : [],
        projectData:
          typeof parsed.projectData === 'object' && parsed.projectData !== null
            ? ({ ...parsed.projectData } as Record<string, unknown>)
            : {},
      };
    } catch {
      return {
        safeMode: true,
        enabledIds: [] as string[],
        projectData: {} as Record<string, unknown>,
      };
    }
  })();

  const host = new FirstPartyPluginHost(defaultPolicy(persisted.safeMode));
  if (options.enableExperimentalDemoPanel === true) {
    host.register(DEMO_PANEL_MANIFEST);
  }
  for (const id of persisted.enabledIds) {
    host.enable(id, 'ui');
  }

  const sdk = createPluginSdkHost(['ui.panel']);

  function persist(): void {
    if (storage === undefined) return;
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        safeMode: host.getPolicy().safeMode,
        enabledIds: host
          .list()
          .filter((plugin) => plugin.state === 'enabled')
          .map((plugin) => plugin.manifest.id),
        projectData: persisted.projectData,
      } satisfies PersistedHostState),
    );
  }

  return {
    sdk,
    host,
    list: () => host.list(),
    isSafeMode: () => host.getPolicy().safeMode,
    setSafeMode(safeMode: boolean) {
      host.setPolicy(defaultPolicy(safeMode));
      if (safeMode) {
        for (const plugin of host.list()) {
          if (plugin.state === 'enabled') host.disable(plugin.manifest.id);
        }
      }
      persist();
    },
    enable(pluginId: string) {
      const result = host.enable(pluginId, 'ui');
      if (result.state === 'updated') {
        persist();
        return { ok: true };
      }
      return { ok: false, issues: result.issues };
    },
    disable(pluginId: string) {
      const ok = host.disable(pluginId);
      if (ok) persist();
      return ok;
    },
    canMountDemoPanel: () => host.canMount(DEMO_PANEL_PLUGIN_ID, 'ui'),
    getProjectData(pluginId: string) {
      return persisted.projectData[pluginId];
    },
    setProjectData(pluginId: string, value: unknown) {
      persisted.projectData[pluginId] = value;
      persist();
    },
  };
}
