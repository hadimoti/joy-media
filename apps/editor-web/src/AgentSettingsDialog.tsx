import { ALL_TOOL_CAPABILITIES, createKiloCodeAgentHostManifest } from '@joy-media/agent-tools';
import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';
import { useEffect, useState } from 'react';
import type { AgentSettings, ConfigurableReasoningModel } from './agent-settings.js';
import {
  BrowserControlPlaneClient,
  type BrowserReasoningProvider,
} from './control-plane-client.js';
import { CloseIcon } from './icons.js';

const MODE_LABELS: Readonly<Record<AgentExecutionMode, string>> = {
  'suggest-only': 'Suggest Only',
  'preview-and-approve': 'Preview and Approve',
  'auto-apply-low-risk': 'Auto-apply Low-Risk',
  'full-auto-limited': 'Full Auto Within Limits',
};

export function AgentSettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  readonly settings: AgentSettings;
  readonly onChange: (settings: AgentSettings) => void;
  readonly onClose: () => void;
}) {
  const [reasoningProviders, setReasoningProviders] = useState<readonly BrowserReasoningProvider[]>(
    [],
  );
  const [modelsLoaded, setModelsLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const client = new BrowserControlPlaneClient();
    void client
      .reasoningProviders()
      .then((providers) => {
        if (active) setReasoningProviders(providers);
      })
      .catch(() => {
        // Missing credentials/network never become a false configured state.
        if (active) setReasoningProviders([]);
      })
      .finally(() => {
        if (active) setModelsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const configuredModels = reasoningProviders.flatMap((provider) =>
    provider.state === 'configured' || provider.state === 'healthy'
      ? provider.models.map((model) => ({ ...model, providerId: provider.providerId }))
      : [],
  );
  const manifest = createKiloCodeAgentHostManifest({
    reasoningModels: configuredModels.map((model) => ({
      kind: 'reasoning-model' as const,
      providerId: model.providerId,
      model: {
        id: model.id,
        displayName: model.displayName,
        ...(model.version === undefined ? {} : { version: model.version }),
      },
    })),
  });
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  const update = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };
  const toggleCapability = (capability: ToolCapability) => {
    const selected = settings.allowedCapabilities.includes(capability);
    update(
      'allowedCapabilities',
      selected
        ? settings.allowedCapabilities.filter((item) => item !== capability)
        : [...settings.allowedCapabilities, capability],
    );
  };

  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="agent-settings-eyebrow">Editing Intelligence</p>
            <h2 id="agent-settings-title">Agent Settings</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="agent-settings-grid">
          <section>
            <h3>Agents</h3>
            <div className="agent-settings-host">
              <strong>{manifest.displayName}</strong>
              <span>Active · {manifest.transport}</span>
            </div>
            <p>KiloCode is the editing host only. Hermes is not connected to editor tools.</p>
          </section>

          <section>
            <h3>Models</h3>
            <label>
              Reasoning model
              <select
                value={settings.reasoningModel}
                disabled={!modelsLoaded || configuredModels.length === 0}
                onChange={(event) =>
                  update('reasoningModel', event.target.value as ConfigurableReasoningModel)
                }
              >
                <option value="">
                  {modelsLoaded
                    ? configuredModels.length === 0
                      ? 'No configured reasoning model'
                      : 'Select a configured model'
                    : 'Checking provider status…'}
                </option>
                {configuredModels.map((model) => (
                  <option key={`${model.providerId}:${model.id}`} value={model.id}>
                    {model.displayName} · {model.providerId}
                  </option>
                ))}
              </select>
            </label>
            <p>Only healthy or configured models appear. Model credentials remain on the server.</p>
          </section>

          <section>
            <h3>Joy Code Engine</h3>
            <label>
              Planning engine
              <select
                value={settings.joyCodeEngine}
                onChange={(event) =>
                  update('joyCodeEngine', event.target.value as AgentSettings['joyCodeEngine'])
                }
              >
                <option value="cloud-openrouter">JOY cloud planner</option>
                <option value="local-deepseek-harness">Local DeepSeek harness</option>
              </select>
            </label>
            {settings.joyCodeEngine === 'local-deepseek-harness' && (
              <>
                <label>
                  OpenRouter-compatible endpoint
                  <input
                    type="url"
                    value={settings.deepSeekHarnessEndpoint}
                    placeholder="https://provider.example/v1/chat/completions"
                    autoComplete="off"
                    onChange={(event) => update('deepSeekHarnessEndpoint', event.target.value)}
                  />
                </label>
                <label>
                  Model ID
                  <input
                    value={settings.deepSeekHarnessModel}
                    autoComplete="off"
                    onChange={(event) => update('deepSeekHarnessModel', event.target.value)}
                  />
                </label>
                <label>
                  API key (kept locally)
                  <input
                    type="password"
                    value={settings.deepSeekHarnessApiKey}
                    autoComplete="new-password"
                    onChange={(event) => update('deepSeekHarnessApiKey', event.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={settings.localProviderDisclosureAccepted}
                    onChange={(event) =>
                      update('localProviderDisclosureAccepted', event.target.checked)
                    }
                  />{' '}
                  I understand this provider may receive project context
                </label>
                {(settings.deepSeekHarnessEndpoint.trim() === '' ||
                  settings.deepSeekHarnessModel.trim() === '' ||
                  settings.deepSeekHarnessApiKey.trim() === '') && (
                  <p role="status">
                    Local DSH is unavailable until its endpoint, model, and API key are configured;
                    it will not fall back to JOY cloud.
                  </p>
                )}
                <p>
                  This app keeps the key in this browser session’s memory only. Packaged JoyStudio
                  Windows/Linux desktop and CLI builds must inject a native OS vault. The key is
                  never persisted here or sent to JOY cloud, projects, logs, or reports.
                </p>
              </>
            )}
          </section>

          <section>
            <h3>Media Providers</h3>
            <label>
              Preferred provider
              <input
                value={settings.mediaProvider}
                onChange={(event) => update('mediaProvider', event.target.value)}
              />
            </label>
            <p>Image, video, speech, audio, and transcription providers remain independent.</p>
          </section>

          <section className="agent-settings-permissions">
            <h3>Permissions</h3>
            <div className="agent-capability-grid">
              {ALL_TOOL_CAPABILITIES.map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={settings.allowedCapabilities.includes(capability)}
                    onChange={() => toggleCapability(capability)}
                  />
                  {capability}
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3>Execution & Budgets</h3>
            <label>
              Execution mode
              <select
                value={settings.executionMode}
                onChange={(event) =>
                  update('executionMode', event.target.value as AgentExecutionMode)
                }
              >
                {Object.entries(MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Maximum provider cost per run (USD)
              <input
                type="number"
                min={0}
                step={0.25}
                value={settings.maxCostPerRunUsd}
                onChange={(event) =>
                  update('maxCostPerRunUsd', Math.max(0, Number(event.target.value) || 0))
                }
              />
            </label>
          </section>

          <section>
            <h3>Privacy</h3>
            <label>
              Remote data policy
              <select
                value={settings.privacyMode}
                onChange={(event) =>
                  update('privacyMode', event.target.value as AgentSettings['privacyMode'])
                }
              >
                <option value="ask-before-remote">Ask before remote processing</option>
                <option value="local-only">Local only</option>
              </select>
            </label>
          </section>

          <section>
            <h3>Secret References</h3>
            {manifest.settings.secretReferences.map((reference) => (
              <div
                className="agent-secret-reference"
                key={`${reference.providerId}:${reference.fieldName}`}
              >
                <span>
                  {reference.providerId} / {reference.fieldName}
                </span>
                <strong>{reference.scope}</strong>
              </div>
            ))}
            <p>Raw key values never enter the browser, project, requests, plugins, or reports.</p>
          </section>

          <section>
            <h3>Local Worker</h3>
            <label>
              Routing preference
              <select
                value={settings.workerPreference}
                onChange={(event) =>
                  update(
                    'workerPreference',
                    event.target.value as AgentSettings['workerPreference'],
                  )
                }
              >
                <option value="prefer-local">Prefer JOY Windows Worker</option>
                <option value="any-approved">Any approved executor</option>
              </select>
            </label>
            <p>Pairing, health, progress, cancellation, and retries are available in Jobs.</p>
          </section>
        </div>

        <footer>
          <span>Changes are saved for this browser.</span>
          <button type="button" className="agent-settings-done" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
