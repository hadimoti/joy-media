import { useEffect, useRef, useState } from 'react';
import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';
import { ALL_TOOL_CAPABILITIES } from '@joy-media/agent-tools';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';
import { CloseIcon } from './icons.js';

const MODES: Readonly<Record<AgentExecutionMode, string>> = {
  'suggest-only': 'Suggest only',
  'preview-and-approve': 'Preview and approve',
  'auto-apply-low-risk': 'Auto-apply low risk',
  'full-auto-limited': 'Full auto within limits',
};

export function JoyAgentSettingsDialog({
  policy,
  onPolicyChange,
  engineClient,
  status,
  onStatusChange,
  onClose,
}: {
  readonly policy: AgentPolicyPreferences;
  readonly onPolicyChange: (next: AgentPolicyPreferences) => void;
  readonly engineClient: JoyAgentEngineClient;
  readonly status?: ByokSessionStatus;
  readonly onStatusChange?: (status: ByokSessionStatus | undefined) => void;
  readonly onClose: () => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<'openrouter' | 'openai-compatible'>('openrouter');
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [modelId, setModelId] = useState('openrouter/auto');
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(status);
  useEffect(() => setConnectionStatus(status), [status]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const update = <K extends keyof AgentPolicyPreferences>(
    key: K,
    value: AgentPolicyPreferences[K],
  ) => onPolicyChange({ ...policy, [key]: value });
  const setProviderKind = (next: 'openrouter' | 'openai-compatible') => {
    engineClient.clear();
    setConnectionStatus(undefined);
    onStatusChange?.(undefined);
    if (keyRef.current) keyRef.current.value = '';
    setCustomDisclosure(false);
    setProvider(next);
    setBaseUrl(next === 'openrouter' ? 'https://openrouter.ai/api/v1' : '');
  };
  const connect = async () => {
    const key = keyRef.current?.value.trim() ?? '';
    if (
      !key ||
      !modelId.trim() ||
      !baseUrl.trim() ||
      (provider === 'openai-compatible' && !customDisclosure)
    )
      return;
    setWorking(true);
    try {
      await engineClient.configure({
        provider,
        baseUrl: baseUrl.trim().replace(/\/$/, ''),
        modelId: modelId.trim(),
        apiKey: key,
      });
      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);
    } catch (error) {
      setConnectionStatus({
        provider,
        modelId,
        capability: 'incompatible',
        message: error instanceof Error ? error.message : 'Unable to configure connection',
      });
      onStatusChange?.({
        provider,
        modelId,
        capability: 'incompatible',
        message: error instanceof Error ? error.message : 'Unable to configure connection',
      });
    } finally {
      if (keyRef.current) keyRef.current.value = '';
      setWorking(false);
    }
  };
  const clear = () => {
    engineClient.clear();
    setConnectionStatus(undefined);
    onStatusChange?.(undefined);
    if (keyRef.current) keyRef.current.value = '';
  };
  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="agent-settings-dialog joy-agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="joy-agent-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="agent-settings-eyebrow">Editing intelligence</p>
            <h2 id="joy-agent-settings-title">JOY Agent Engine</h2>
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
          <section className="agent-engine-card">
            <h3>Built in · Browser Worker</h3>
            <p>
              JOY owns the tool loop, previews, approvals, and edits. The worker is created only for
              this page session.
            </p>
            <span
              className={`agent-connection-badge is-${connectionStatus?.capability ?? 'untested'}`}
            >
              {connectionStatus?.capability === 'tool-loop'
                ? 'Tool loop ready'
                : connectionStatus?.capability === 'plan-only'
                  ? 'Plan-only'
                  : connectionStatus?.capability === 'incompatible'
                    ? (connectionStatus.message ?? 'Connection unavailable')
                    : 'Not connected'}
            </span>
          </section>
          <section>
            <h3>Model connection</h3>
            <p className="agent-settings-hint">
              This page session only. JOY does not save, proxy, or log your key. Provider charges
              may apply.
            </p>
            <label>
              Provider
              <select
                value={provider}
                onChange={(event) => setProviderKind(event.target.value as typeof provider)}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="openai-compatible">Custom OpenAI-compatible</option>
              </select>
            </label>
            <label>
              Base URL
              <input
                type="url"
                value={baseUrl}
                disabled={provider === 'openrouter'}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://provider.example/v1"
              />
            </label>
            <label>
              Model ID
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="provider/model"
              />
            </label>
            {provider === 'openai-compatible' && (
              <label className="agent-disclosure">
                <input
                  type="checkbox"
                  checked={customDisclosure}
                  onChange={(event) => setCustomDisclosure(event.target.checked)}
                />{' '}
                I understand the custom provider receives the context I send
              </label>
            )}
            <label>
              API key
              <input
                ref={keyRef}
                type="password"
                autoComplete="off"
                placeholder="Entered once for this session"
              />
            </label>
            <div className="agent-settings-actions">
              <button
                type="button"
                className="agent-settings-done"
                onClick={() => void connect()}
                disabled={working}
              >
                {working ? 'Connecting…' : 'Test & use'}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={clear}
                disabled={working || connectionStatus === undefined}
              >
                Clear connection
              </button>
            </div>
          </section>
          <section>
            <h3>Editing policy & budgets</h3>
            <label>
              Execution mode
              <select
                value={policy.executionMode}
                onChange={(event) =>
                  update('executionMode', event.target.value as AgentExecutionMode)
                }
              >
                {Object.entries(MODES).map(([value, label]) => (
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
                value={policy.maxCostPerRunUsd}
                onChange={(event) =>
                  update('maxCostPerRunUsd', Math.max(0, Number(event.target.value) || 0))
                }
              />
            </label>
            <label>
              Privacy
              <select
                value={policy.privacyMode}
                onChange={(event) =>
                  update('privacyMode', event.target.value as AgentPolicyPreferences['privacyMode'])
                }
              >
                <option value="ask-before-remote">Ask before remote processing</option>
                <option value="local-only">Local only</option>
              </select>
            </label>
          </section>
          <section>
            <h3>Live work</h3>
            <label className="agent-toggle">
              <input
                type="checkbox"
                checked={policy.livePreview}
                onChange={(event) => update('livePreview', event.target.checked)}
              />{' '}
              Preview edits live before approval
            </label>
            <p className="agent-settings-hint">
              Follow agent is off by default and stays in memory for this session.
            </p>
            <div className="agent-settings-readonly" aria-label="Agent executor">
              <span>Executor</span>
              <strong>Built-in browser Worker</strong>
              <small>
                One page-session engine. No external editor agent or local model process is used.
              </small>
            </div>
          </section>
          <section className="agent-settings-permissions">
            <h3>Capabilities</h3>
            <div className="agent-capability-grid">
              {ALL_TOOL_CAPABILITIES.map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={policy.allowedCapabilities.includes(capability)}
                    onChange={() =>
                      update(
                        'allowedCapabilities',
                        policy.allowedCapabilities.includes(capability)
                          ? policy.allowedCapabilities.filter((item) => item !== capability)
                          : ([
                              ...policy.allowedCapabilities,
                              capability,
                            ] as readonly ToolCapability[]),
                      )
                    }
                  />
                  {capability}
                </label>
              ))}
            </div>
          </section>
        </div>
        <footer>
          <span>Editing policy is saved in this browser. Connection details are session-only.</span>
          <button type="button" className="agent-settings-done" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
