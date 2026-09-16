import { useEffect, useRef, useState } from 'react';
import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';
import { ALL_TOOL_CAPABILITIES } from '@joy-media/agent-tools';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type {
  ByokSessionStatus,
  JoyAgentMediaCapabilityReport,
  JoyAgentMediaCapabilityState,
} from './joy-agent/protocol.js';
import { CloseIcon } from './icons.js';
import {
  isDesktopHost,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  beginDesktopProviderSession,
  getRemoteApiBaseUrl,
  type DesktopProviderProfile,
} from './desktop-client.js';
import { getStoredMediaToken } from './media-session.js';

type AgentSettingsNotice = {
  readonly kind: 'info' | 'success' | 'error';
  readonly message: string;
};

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
  onNotice,
  onClose,
}: {
  readonly policy: AgentPolicyPreferences;
  readonly onPolicyChange: (next: AgentPolicyPreferences) => void;
  readonly engineClient: JoyAgentEngineClient;
  readonly status?: ByokSessionStatus;
  readonly onStatusChange?: (status: ByokSessionStatus | undefined) => void;
  readonly onNotice?: (message: string, kind: AgentSettingsNotice['kind']) => void;
  readonly onClose: () => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const mediaProbeEpochRef = useRef(0);
  const [provider, setProvider] = useState<'joy-hosted' | 'openrouter' | 'openai-compatible'>(
    status?.provider ?? 'openrouter',
  );
  const [baseUrl, setBaseUrl] = useState(
    status?.provider === 'openai-compatible'
      ? ''
      : status?.provider === 'joy-hosted'
        ? 'https://joyst.ir/api/v1/agent'
        : 'https://openrouter.ai/api/v1',
  );
  const [modelId, setModelId] = useState(
    status?.modelId || (status?.provider === 'joy-hosted' ? 'minimax/minimax-m3' : 'openrouter/auto'),
  );
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();
  const [mediaCapabilities, setMediaCapabilities] = useState<
    JoyAgentMediaCapabilityReport | undefined
  >(() => matchingMediaCapabilityReport(engineClient.getMediaCapabilities(), status?.modelId));
  const [mediaProbeWorking, setMediaProbeWorking] = useState(false);
  const [mediaProbeNotice, setMediaProbeNotice] = useState<AgentSettingsNotice | undefined>();
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfile | undefined>(undefined);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mediaProbeEpochRef.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!isDesktopHost()) return;
    let cancelled = false;
    void listDesktopProviderProfiles()
      .then((profiles) => {
        if (cancelled) return;
        const openRouterProfile = profiles.find((p) => p.provider === 'openrouter');
        if (openRouterProfile) {
          setSavedProfile(openRouterProfile);
          setHasSavedKey(true);
          setModelId(openRouterProfile.modelId);
          setBaseUrl(openRouterProfile.baseUrl);
          setProvider('openrouter');
        }
      })
      .catch(() => {
        /* Ignore background profile read errors. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setConnectionStatus(status);
    if (status === undefined) return;
    setProvider(status.provider);
    setModelId(status.modelId || 'openrouter/auto');
  }, [status]);
  useEffect(() => {
    // Reading a previous redacted session result is intentionally passive. It
    // never contacts a provider; only the explicit button below may probe.
    setMediaCapabilities(
      matchingMediaCapabilityReport(engineClient.getMediaCapabilities(), connectionStatus?.modelId),
    );
    setMediaProbeNotice(undefined);
  }, [connectionStatus?.modelId, engineClient]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      mediaProbeEpochRef.current += 1;
      setMediaProbeWorking(false);
      setMediaCapabilities(undefined);
      setMediaProbeNotice(undefined);
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const update = <K extends keyof AgentPolicyPreferences>(
    key: K,
    value: AgentPolicyPreferences[K],
  ) => onPolicyChange({ ...policy, [key]: value });
  const invalidateMediaProbe = () => {
    mediaProbeEpochRef.current += 1;
    setMediaProbeWorking(false);
    setMediaCapabilities(undefined);
    setMediaProbeNotice(undefined);
  };
  const close = () => {
    invalidateMediaProbe();
    onClose();
  };
  const setProviderKind = (next: 'joy-hosted' | 'openrouter' | 'openai-compatible') => {
    invalidateMediaProbe();
    engineClient.clear();
    setConnectionStatus(undefined);
    setConnectionNotice(undefined);
    onStatusChange?.(undefined);
    if (keyRef.current) keyRef.current.value = '';
    setCustomDisclosure(false);
    setProvider(next);
    if (next === 'joy-hosted') {
      const remote = getRemoteApiBaseUrl();
      setBaseUrl(remote.startsWith('http') ? `${remote}/v1/agent` : 'https://joyst.ir/api/v1/agent');
      setModelId('minimax/minimax-m3');
    } else if (next === 'openrouter') {
      setBaseUrl('https://openrouter.ai/api/v1');
      setModelId('openrouter/auto');
    } else {
      setBaseUrl('');
      setModelId('');
    }
    setHasSavedKey(savedProfile !== undefined && savedProfile.provider === next);
  };
  const connect = async () => {
    if (mediaProbeWorking) return;
    const enteredKey = keyRef.current?.value.trim() ?? '';
    let key = enteredKey;
    if (provider === 'joy-hosted') {
      key = (typeof localStorage !== 'undefined' ? getStoredMediaToken(localStorage) : undefined) || 'anonymous-token';
    } else if (!key && isDesktopHost() && hasSavedKey && savedProfile) {
      try {
        const sessionConfig = (await beginDesktopProviderSession(savedProfile.id)) as
          | { apiKey?: string }
          | undefined;
        if (sessionConfig && typeof sessionConfig.apiKey === 'string') {
          key = sessionConfig.apiKey;
        }
      } catch {
        /* Failed to resolve saved key; fall through to validation. */
      }
    }
    const normalizedModelId = modelId.trim();
    const normalizedBaseUrl =
      provider === 'joy-hosted'
        ? baseUrl.trim() || 'https://joyst.ir/api/v1/agent'
        : baseUrl.trim();
    const missing: string[] = [];
    if (!key && provider !== 'joy-hosted') missing.push('an API key');
    if (!normalizedModelId) missing.push('a model ID');
    if (!normalizedBaseUrl) missing.push('a base URL');
    if (provider === 'openai-compatible' && !customDisclosure)
      missing.push('the custom-provider acknowledgement');
    if (missing.length > 0) {
      const message = `Enter ${missing.join(', ')} before connecting.`;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    invalidateMediaProbe();
    setWorking(true);
    try {
      if (isDesktopHost() && key) {
        try {
          const profileId =
            savedProfile && savedProfile.provider === provider ? savedProfile.id : undefined;
          const saved = await saveDesktopProviderProfile({
            ...(profileId !== undefined ? { id: profileId } : {}),
            provider,
            baseUrl: normalizedBaseUrl.replace(/\/$/, ''),
            modelId: normalizedModelId,
            apiKey: key,
          });
          setSavedProfile(saved);
          setHasSavedKey(true);
        } catch (err) {
          console.warn('Failed to save desktop provider profile to DPAPI:', err);
        }
      }
      await engineClient.configure({
        provider,
        baseUrl: normalizedBaseUrl.replace(/\/$/, ''),
        modelId: normalizedModelId,
        apiKey: key,
      });
      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);
      const message =
        next.capability === 'tool-loop'
          ? 'Connected successfully. JOY is ready to edit in this session.'
          : next.capability === 'plan-only'
            ? 'Connected successfully in plan-only mode. Creative Brief is ready in this session.'
            : 'The provider responded, but JOY could not use its tool loop.';
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);
      // Keep the dialog open after a successful test so the user can see the
      // durable session status and explicitly finish.  Auto-closing hid the
      // success confirmation and made BYOK setup feel like it had failed.
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to configure connection';
      const safeMessage = rawMessage.replaceAll(key, '[redacted]').slice(0, 180);
      const message = `Connection failed: ${safeMessage}`;
      setConnectionStatus({
        provider,
        modelId: normalizedModelId,
        capability: 'incompatible',
        message: safeMessage,
      });
      onStatusChange?.({
        provider,
        modelId: normalizedModelId,
        capability: 'incompatible',
        message: safeMessage,
      });
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      if (keyRef.current) keyRef.current.value = '';
      setWorking(false);
    }
  };
  const canProbeMediaCapabilities =
    connectionStatus?.capability === 'tool-loop' || connectionStatus?.capability === 'plan-only';
  const probeMediaCapabilities = async () => {
    if (!canProbeMediaCapabilities || working || mediaProbeWorking) return;
    const configuredModelId = connectionStatus?.modelId;
    if (configuredModelId === undefined) return;
    const probeEpoch = mediaProbeEpochRef.current + 1;
    mediaProbeEpochRef.current = probeEpoch;
    setMediaProbeWorking(true);
    setMediaProbeNotice(undefined);
    try {
      const report = safeMediaCapabilityReport(await engineClient.probeMediaCapabilities());
      if (!mountedRef.current || probeEpoch !== mediaProbeEpochRef.current) return;
      if (report === undefined || report.modelId !== configuredModelId) {
        const message =
          'Media capability check returned an invalid result. Reconnect the model and try again.';
        setMediaCapabilities(undefined);
        setMediaProbeNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        return;
      }
      setMediaCapabilities(report);
      const message = `Media capability check complete for ${displayModelId(report.modelId)}.`;
      setMediaProbeNotice({ kind: 'success', message });
      onNotice?.(message, 'success');
    } catch {
      if (!mountedRef.current || probeEpoch !== mediaProbeEpochRef.current) return;
      // Provider text is deliberately never shown here: it can contain an
      // endpoint, credential echo, synthetic payload, or raw response body.
      const message =
        'Media capability check could not be completed. Reconnect the model and try again.';
      setMediaProbeNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      if (mountedRef.current && probeEpoch === mediaProbeEpochRef.current) {
        setMediaProbeWorking(false);
      }
    }
  };
  const clear = () => {
    invalidateMediaProbe();
    engineClient.clear();
    setConnectionStatus(undefined);
    onStatusChange?.(undefined);
    const message = 'Connection cleared. Your API key was removed from this page session.';
    setConnectionNotice({ kind: 'info', message });
    onNotice?.(message, 'info');
    if (keyRef.current) keyRef.current.value = '';
  };
  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={close}>
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
          <button className="icon-button" type="button" aria-label="Close settings" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="agent-settings-grid">
          <section className="agent-settings-connection agent-engine-card">
            <div className="agent-engine-identity">
              <div className="agent-engine-mark" aria-hidden="true">
                JOY
              </div>
              <div className="agent-engine-copy">
                <span className="agent-settings-kicker">Built in · Browser Worker</span>
                <h3>JOY owns the creative loop</h3>
                <p>
                  Previews, approvals, and edits stay in this page session. Your provider key is
                  held in memory only and is never saved or proxied by JOY.
                </p>
              </div>
              <span
                className={`agent-connection-badge is-${connectionStatus?.capability ?? 'untested'}`}
                aria-live="polite"
              >
                {connectionStatus?.capability === 'tool-loop'
                  ? 'Tool loop ready'
                  : connectionStatus?.capability === 'plan-only'
                    ? 'Plan-only ready'
                    : connectionStatus?.capability === 'incompatible'
                      ? (connectionStatus.message ?? 'Connection unavailable')
                      : 'Not connected'}
              </span>
            </div>
            <div className="agent-settings-connection-form">
              <div className="agent-settings-section-heading">
                <div>
                  <span className="agent-settings-kicker">Connection</span>
                  <h3>{provider === 'joy-hosted' ? 'Built-in Joy Model' : 'Bring your own model'}</h3>
                </div>
                <span className="agent-settings-session-chip">
                  {provider === 'joy-hosted' ? 'JOY Pro Gateway' : 'Session-only BYOK'}
                </span>
              </div>
              <p className="agent-settings-hint">
                {provider === 'joy-hosted'
                  ? 'Access our curated models with zero setup. Requests are routed through our secure VPS gateway.'
                  : 'Connect OpenRouter or any approved HTTPS OpenAI-compatible provider. Provider charges apply.'}
              </p>
              <div className="agent-settings-form-grid">
                <label>
                  Mode
                  <select
                    value={provider}
                    onChange={(event) => setProviderKind(event.target.value as typeof provider)}
                    disabled={working || mediaProbeWorking}
                  >
                    <option value="joy-hosted">Joy Model (Built-in Pro AI)</option>
                    <option value="openrouter">OpenRouter (BYOK)</option>
                    <option value="openai-compatible">Custom OpenAI-compatible (BYOK)</option>
                  </select>
                </label>
                {provider === 'joy-hosted' ? (
                  <label>
                    Model
                    <select
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={working || mediaProbeWorking}
                    >
                      <option value="minimax/minimax-m3">Joy Pro (MiniMax M3 — Recommended)</option>
                      <option value="anthropic/claude-3.5-sonnet">Joy Studio (Claude 3.5 Sonnet)</option>
                      <option value="openai/gpt-4o-mini">Joy Fast (GPT-4o mini)</option>
                      <option value="meta-llama/llama-3.3-70b-instruct">Joy Open (Llama 3.3 70B)</option>
                    </select>
                  </label>
                ) : (
                  <label>
                    Model ID
                    <input
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      placeholder="provider/model"
                      disabled={working || mediaProbeWorking}
                    />
                  </label>
                )}
                {provider === 'joy-hosted' ? (
                  <div className="agent-settings-field-wide" style={{ fontSize: '0.85rem', color: '#888' }}>
                    Included with your active JOY Pro subscription. No external API key required.
                  </div>
                ) : (
                  <>
                    <label className="agent-settings-field-wide">
                      Base URL
                      <input
                        type="url"
                        value={baseUrl}
                        disabled={provider === 'openrouter' || working || mediaProbeWorking}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="https://provider.example/v1"
                      />
                    </label>
                    {provider === 'openai-compatible' && (
                      <label className="agent-disclosure agent-settings-field-wide">
                        <input
                          type="checkbox"
                          checked={customDisclosure}
                          onChange={(event) => setCustomDisclosure(event.target.checked)}
                          disabled={working || mediaProbeWorking}
                        />{' '}
                        I understand the custom provider receives the context I send
                      </label>
                    )}
                    <label className="agent-settings-field-wide">
                      API key{hasSavedKey ? ' (Saved in desktop vault)' : ''}
                      <input
                        ref={keyRef}
                        type="password"
                        autoComplete="off"
                        placeholder={
                          hasSavedKey
                            ? 'Using saved desktop key (enter to replace)'
                            : 'Entered once for this session'
                        }
                        disabled={working || mediaProbeWorking}
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="agent-settings-actions">
                <button
                  type="button"
                  className="agent-settings-done"
                  onClick={() => void connect()}
                  disabled={working || mediaProbeWorking}
                >
                  {working
                    ? 'Connecting…'
                    : connectionStatus === undefined
                      ? 'Connect model'
                      : 'Test & use'}
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
              {connectionNotice !== undefined && (
                <div
                  className={`agent-settings-notice is-${connectionNotice.kind}`}
                  role={connectionNotice.kind === 'error' ? 'alert' : 'status'}
                  aria-live="polite"
                >
                  <span className="agent-settings-notice-icon" aria-hidden="true">
                    {connectionNotice.kind === 'success'
                      ? '✓'
                      : connectionNotice.kind === 'error'
                        ? '!'
                        : 'i'}
                  </span>
                  <span>{connectionNotice.message}</span>
                </div>
              )}
              <section className="agent-media-capability-probe" aria-label="Media capability check">
                <div className="agent-settings-section-heading">
                  <div>
                    <span className="agent-settings-kicker">Optional capability check</span>
                    <h3>Check media support</h3>
                  </div>
                  <span className="agent-settings-session-chip">Explicit only</span>
                </div>
                <p className="agent-settings-hint">
                  This sends three tiny product-owned synthetic samples (image, audio, and video) to
                  your configured provider. It never sends your project, owner, or uploaded media.
                  Your provider may charge or log these requests.
                </p>
                <div className="agent-settings-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void probeMediaCapabilities()}
                    disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                  >
                    {mediaProbeWorking ? 'Checking media support…' : 'Check media support'}
                  </button>
                </div>
                {mediaCapabilities !== undefined && (
                  <div className="agent-media-capability-result" role="status" aria-live="polite">
                    <strong>Configured model: {displayModelId(mediaCapabilities.modelId)}</strong>
                    <dl>
                      <MediaCapabilityRow label="Image" state={mediaCapabilities.image} />
                      <MediaCapabilityRow label="Audio" state={mediaCapabilities.audio} />
                      <MediaCapabilityRow label="Video" state={mediaCapabilities.video} />
                    </dl>
                  </div>
                )}
                {mediaProbeNotice !== undefined && (
                  <div
                    className={`agent-settings-notice is-${mediaProbeNotice.kind}`}
                    role={mediaProbeNotice.kind === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    <span className="agent-settings-notice-icon" aria-hidden="true">
                      {mediaProbeNotice.kind === 'success'
                        ? '✓'
                        : mediaProbeNotice.kind === 'error'
                          ? '!'
                          : 'i'}
                    </span>
                    <span>{mediaProbeNotice.message}</span>
                  </div>
                )}
              </section>
            </div>
          </section>
          <section>
            <div className="agent-settings-section-heading">
              <div>
                <span className="agent-settings-kicker">Behavior</span>
                <h3>Editing policy &amp; budgets</h3>
              </div>
            </div>
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
            <div className="agent-settings-section-heading">
              <div>
                <span className="agent-settings-kicker">Live experience</span>
                <h3>Keep work visible</h3>
              </div>
              <span
                className={`agent-settings-live-dot is-${connectionStatus?.capability ?? 'untested'}`}
                aria-label={`Connection capability: ${connectionStatus?.capability ?? 'untested'}`}
                role="img"
              />
            </div>
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
          </section>
          <details className="agent-settings-permissions" aria-label="Advanced permissions">
            <summary>
              <span>
                <span className="agent-settings-kicker">Advanced</span>
                <strong>Permissions</strong>
              </span>
              <span className="agent-settings-permissions-count">
                {policy.allowedCapabilities.length} enabled
              </span>
            </summary>
            <div className="agent-settings-permissions-body">
              <p className="agent-settings-hint">
                These capabilities control what JOY may inspect or stage. Changes apply to this
                browser only.
              </p>
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
            </div>
          </details>
        </div>
        <footer>
          <span>Editing policy is saved in this browser. Connection details are session-only.</span>
          <button type="button" className="agent-settings-done" onClick={close}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

function MediaCapabilityRow({
  label,
  state,
}: {
  readonly label: string;
  readonly state: JoyAgentMediaCapabilityState;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`is-${state}`}>{state === 'supported' ? 'Supported' : 'Unavailable'}</dd>
    </div>
  );
}

function safeMediaCapabilityReport(value: unknown): JoyAgentMediaCapabilityReport | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['modelId', 'image', 'audio', 'video', 'modalities'])
  )
    return undefined;
  if (!isSafeModelId(value.modelId)) return undefined;
  if (
    !isCapabilityState(value.image) ||
    !isCapabilityState(value.audio) ||
    !isCapabilityState(value.video) ||
    !Array.isArray(value.modalities)
  )
    return undefined;
  const expected = ['image', 'audio', 'video'].filter(
    (modality) => value[modality] === 'supported',
  );
  if (
    value.modalities.length !== expected.length ||
    value.modalities.some((modality, index) => modality !== expected[index])
  )
    return undefined;
  return {
    modelId: value.modelId,
    image: value.image,
    audio: value.audio,
    video: value.video,
    modalities: expected as JoyAgentMediaCapabilityReport['modalities'],
  };
}

function matchingMediaCapabilityReport(
  value: unknown,
  configuredModelId: string | undefined,
): JoyAgentMediaCapabilityReport | undefined {
  const report = safeMediaCapabilityReport(value);
  return report !== undefined && report.modelId === configuredModelId ? report : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSafeModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !/(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|https?:\/\/|blob:|data:|file:|opfs:|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+)/i.test(
      value,
    )
  );
}

function isCapabilityState(value: unknown): value is JoyAgentMediaCapabilityState {
  return value === 'supported' || value === 'unavailable';
}

function displayModelId(modelId: string): string {
  return modelId.length <= 96 ? modelId : `${modelId.slice(0, 93)}…`;
}
