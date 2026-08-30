import { CheckIcon, CloseIcon, LockIcon } from './icons.js';
import { DEMO_PANEL_PLUGIN_ID, type EditorPluginHost } from './plugin-host.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

export function PluginsPanel({
  pluginHost,
  onChange,
}: {
  readonly pluginHost: EditorPluginHost;
  readonly onChange: () => void;
}) {
  const safeMode = pluginHost.isSafeMode();
  const plugins = pluginHost.list();
  const demoMounted = pluginHost.canMountDemoPanel();
  const projectData = pluginHost.getProjectData(DEMO_PANEL_PLUGIN_ID);

  return (
    <PanelShell
      title="Plugins"
      iconUrl={panelTabIconUrl('plugins')}
      className="plugins-panel"
      note={
        safeMode
          ? 'Safe mode is on; UI plugin inputs stay disabled.'
          : 'Safe mode is off. Plugin UI inputs are available.'
      }
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label={safeMode ? 'Disable safe mode' : 'Enable safe mode'}
          title={safeMode ? 'Safe mode on — click to allow enabling plugins' : 'Safe mode off'}
          aria-pressed={safeMode}
          onClick={() => {
            pluginHost.setSafeMode(!safeMode);
            onChange();
          }}
        >
          <LockIcon />
        </button>
      }
    >
      <ul className="plugin-list">
        {plugins.map((plugin) => {
          const enabled = plugin.state === 'enabled';
          return (
            <li key={plugin.manifest.id} className="plugin-row">
              <div className="plugin-row-main">
                <strong>{plugin.manifest.name}</strong>
                <span>v{plugin.manifest.version}</span>
                <span className="plugin-state-badge">{plugin.state}</span>
              </div>
              <div className="plugin-row-actions">
                {enabled ? (
                  <button
                    className="icon-button"
                    aria-label={`Disable ${plugin.manifest.name}`}
                    title={`Disable ${plugin.manifest.name}`}
                    onClick={() => {
                      pluginHost.disable(plugin.manifest.id);
                      onChange();
                    }}
                  >
                    <CloseIcon />
                  </button>
                ) : (
                  <button
                    className="icon-button"
                    aria-label={`Enable ${plugin.manifest.name}`}
                    title={`Enable ${plugin.manifest.name}`}
                    disabled={safeMode}
                    onClick={() => {
                      pluginHost.enable(plugin.manifest.id);
                      onChange();
                    }}
                  >
                    <CheckIcon />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <section className="plugin-contribution">
        <h4>Demo contribution</h4>
        {demoMounted ? (
          <div className="plugin-demo-surface">
            <p>
              SDK host is active · <bdi>ui.panel</bdi> capability supported:
              <bdi>{String(pluginHost.sdk.supports('ui.panel'))}</bdi>
            </p>
            <p dir="ltr">
              Project data: {projectData === undefined ? '(empty)' : JSON.stringify(projectData)}
            </p>
            <button
              className="icon-button icon-button-labeled"
              title="Write demo project data"
              aria-label="Write demo project data"
              onClick={() => {
                pluginHost.setProjectData(DEMO_PANEL_PLUGIN_ID, {
                  note: 'demo-panel-data',
                  at: 'local',
                });
                onChange();
              }}
            >
              <CheckIcon />
              Write data
            </button>
          </div>
        ) : (
          <p className="empty-hint">
            Turn safe mode off and enable Demo Panel to show this section.
          </p>
        )}
      </section>
    </PanelShell>
  );
}
