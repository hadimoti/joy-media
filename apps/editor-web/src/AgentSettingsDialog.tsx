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
            <p className="agent-settings-eyebrow" lang="fa">
              هوشمندی ویرایش
            </p>
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
            <p lang="fa">KiloCode تنها میزبان ویرایش است. Hermes به ابزارهای ویرایشگر متصل نیست.</p>
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
            <p lang="fa">
              فقط مدل‌های سالم یا پیکربندی‌شده نمایش داده می‌شوند؛ اطلاعات ورود مدل در سمت سرور باقی
              می‌ماند.
            </p>
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
            <p lang="fa">
              ارائه‌دهندگان تصویر، ویدئو، گفتار، صدا و رونویسی مستقل از یکدیگر باقی می‌مانند.
            </p>
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
            <p lang="fa">
              مقدار خام کلیدها هرگز وارد مرورگر، پروژه، درخواست، افزونه یا گزارش‌ها نمی‌شود.
            </p>
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
            <p lang="fa">جفت‌سازی، سلامت، پیشرفت، لغو و تلاش دوباره در بخش Jobs قابل مشاهده است.</p>
          </section>
        </div>

        <footer>
          <span lang="fa">تغییرات برای همین مرورگر ذخیره می‌شوند.</span>
          <button type="button" className="agent-settings-done" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
