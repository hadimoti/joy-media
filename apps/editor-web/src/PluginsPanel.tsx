import { CheckIcon, CloseIcon, LockIcon } from './icons.js';
import {
  DEMO_PANEL_PLUGIN_ID,
  type EditorPluginHost,
} from './plugin-host.js';

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
    <article className="plugins-panel">
      <div className="plugins-header">
        <h3>Plugins</h3>
        <button
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
      </div>

      <p className="empty-hint" aria-live="polite">
        {safeMode
          ? 'Safe mode is on. Third-party and first-party UI entrypoints stay disabled.'
          : 'Safe mode is off. Enable a first-party plugin to mount its contribution.'}
      </p>

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
            <p>SDK host alive · capability ui.panel supported={String(pluginHost.sdk.supports('ui.panel'))}</p>
            <p dir="ltr">Project data: {projectData === undefined ? '(empty)' : JSON.stringify(projectData)}</p>
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
          <p className="empty-hint">Enable Demo Panel (with safe mode off) to mount this contribution.</p>
        )}
      </section>
    </article>
  );
}
