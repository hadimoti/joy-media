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
  deleteDesktopProviderProfile,
  fetchDesktopProviderModels,
  beginDesktopProviderSession,
  getRemoteApiBaseUrl,
  type DesktopProviderProfile,
} from './desktop-client.js';
import { getStoredMediaToken } from './media-session.js';
import './JoyAgentSettingsDialog.css';

export type JoyAgentSettingsTab =
  | 'models'
  | 'execution'
  | 'experience'
  | 'permissions'
  | 'diagnostics';

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

const MODE_DESCRIPTIONS: Readonly<Record<AgentExecutionMode, string>> = {
  'suggest-only': 'Joy Code suggests creative plans and edits in chat without touching the timeline.',
  'preview-and-approve': 'Edits are previewed visually in the editor and require explicit approval before applying.',
  'auto-apply-low-risk': 'Automatically executes non-destructive edits (cuts, trims, labeling) while gating large changes.',
  'full-auto-limited': 'Autonomous multi-step execution within your configured cost and token budget limits.',
};

export function JoyAgentSettingsDialog({
  policy,
  onPolicyChange,
  engineClient,
  status,
  onStatusChange,
  onNotice,
  onClose,
  initialTab = 'models',
}: {
  readonly policy: AgentPolicyPreferences;
  readonly onPolicyChange: (next: AgentPolicyPreferences) => void;
  readonly engineClient: JoyAgentEngineClient;
  readonly status?: ByokSessionStatus;
  readonly onStatusChange?: (status: ByokSessionStatus | undefined) => void;
  readonly onNotice?: (message: string, kind: AgentSettingsNotice['kind']) => void;
  readonly onClose: () => void;
  readonly initialTab?: JoyAgentSettingsTab;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const mediaProbeEpochRef = useRef(0);

  const [activeTab, setActiveTab] = useState<JoyAgentSettingsTab>(initialTab);

  const [provider, setProvider] = useState<'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible'>(
    status?.provider === 'joy-hosted' ||
      status?.provider === 'openai-compatible' ||
      status?.provider === 'kilo'
      ? status.provider
      : 'openrouter',
  );
  const [baseUrl, setBaseUrl] = useState(
    status?.provider === 'openai-compatible'
      ? ''
      : status?.provider === 'joy-hosted'
        ? 'https://joyst.ir/api/v1/agent'
        : status?.provider === 'kilo'
          ? 'https://api.kilo.ai/v1'
          : 'https://openrouter.ai/api/v1',
  );
  const [modelId, setModelId] = useState(
    status?.modelId || (status?.provider === 'joy-hosted' ? 'minimax/minimax-m3' : 'openrouter/auto'),
  );
  const [connectionName, setConnectionName] = useState('');
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();

  // Multi-profile state
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfile[]>([]);
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfile | undefined>(undefined);
  const [hasSavedKey, setHasSavedKey] = useState(false);

  // Dynamic model discovery state
  const [discoveredModels, setDiscoveredModels] = useState<readonly string[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  // Media capability probe state
  const [mediaCapabilities, setMediaCapabilities] = useState<
    JoyAgentMediaCapabilityReport | undefined
  >(() => matchingMediaCapabilityReport(engineClient.getMediaCapabilities(), status?.modelId));
  const [mediaProbeWorking, setMediaProbeWorking] = useState(false);
  const [mediaProbeNotice, setMediaProbeNotice] = useState<AgentSettingsNotice | undefined>();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mediaProbeEpochRef.current += 1;
    };
  }, []);

  const loadProfiles = async () => {
    if (!isDesktopHost()) return;
    try {
      const list = await listDesktopProviderProfiles();
      if (!mountedRef.current) return;
      setProfiles(list);
      const openRouterProfile = list.find((p) => p.provider === 'openrouter');
      if (openRouterProfile) {
        setSavedProfile(openRouterProfile);
        setHasSavedKey(true);
        setModelId(openRouterProfile.modelId);
        setBaseUrl(openRouterProfile.baseUrl);
        setProvider('openrouter');
      }
    } catch {
      /* Ignore profile read error in background */
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  useEffect(() => {
    setConnectionStatus(status);
    if (status === undefined) return;
    setProvider(
      status.provider === 'joy-hosted' ||
        status.provider === 'openai-compatible' ||
        status.provider === 'kilo'
        ? status.provider
        : 'openrouter',
    );
    setModelId(status.modelId || 'openrouter/auto');
  }, [status]);

  useEffect(() => {
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

  const setProviderKind = (next: 'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible') => {
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
    } else if (next === 'kilo') {
      setBaseUrl('https://api.kilo.ai/v1');
      setModelId('minimax/minimax-m3');
    } else {
      setBaseUrl('');
      setModelId('');
    }
    setHasSavedKey(savedProfile !== undefined && savedProfile.provider === next);
    setDiscoveredModels([]);
    setDiscoveryError(null);
  };

  const discoverModels = async () => {
    if (!isDesktopHost()) {
      setDiscoveryError('Live model discovery requires Joy Media Desktop.');
      return;
    }
    const enteredKey = keyRef.current?.value.trim() ?? '';
    let key = enteredKey;
    if (!key && savedProfile) {
      try {
        const session = (await beginDesktopProviderSession(savedProfile.id)) as
          | { apiKey?: string }
          | undefined;
        if (session && typeof session.apiKey === 'string') {
          key = session.apiKey;
        }
      } catch {
        /* Ignore */
      }
    }
    if (!key && provider !== 'joy-hosted') {
      setDiscoveryError('Enter an API key first to discover models behind this link.');
      return;
    }
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, '');
    if (!normalizedBaseUrl) {
      setDiscoveryError('Enter a Base URL first.');
      return;
    }
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const models = await fetchDesktopProviderModels({
        provider: provider === 'openai-compatible' ? 'custom' : provider,
        baseUrl: normalizedBaseUrl,
        ...(key ? { apiKey: key } : {}),
      });
      if (!mountedRef.current) return;
      const modelIds = models.map((m) => m.id).filter(Boolean);
      setDiscoveredModels(modelIds);
      if (modelIds.length > 0 && !modelIds.includes(modelId)) {
        const prefer =
          modelIds.find((m) => m.includes('minimax') || m.includes('efficient') || m.includes('auto')) ||
          modelIds[0];
        if (prefer) {
          setModelId(prefer);
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setDiscoveryError(err instanceof Error ? err.message : 'Failed to discover models behind endpoint');
    } finally {
      if (mountedRef.current) setIsDiscovering(false);
    }
  };

  const connect = async () => {
    if (mediaProbeWorking) return;
    const enteredKey = keyRef.current?.value.trim() ?? '';
    let key = enteredKey;
    if (provider === 'joy-hosted') {
      key =
        (typeof localStorage !== 'undefined' ? getStoredMediaToken(localStorage) : undefined) ||
        'anonymous-token';
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
            provider: provider === 'openai-compatible' ? 'custom' : provider,
            name: connectionName.trim() || undefined,
            baseUrl: normalizedBaseUrl.replace(/\/$/, ''),
            modelId: normalizedModelId,
            apiKey: key,
            ...(discoveredModels.length > 0 ? { cachedModels: discoveredModels } : {}),
          });
          setSavedProfile(saved);
          setHasSavedKey(true);
          void loadProfiles();
        } catch (err) {
          console.warn('Failed to save desktop provider profile to DPAPI:', err);
        }
      }
      await engineClient.configure({
        provider: provider === 'openai-compatible' ? 'openai-compatible' : provider,
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

  const connectProfile = async (prof: DesktopProviderProfile) => {
    if (working) return;
    setWorking(true);
    try {
      const session = (await beginDesktopProviderSession(prof.id)) as
        | { apiKey?: string; baseUrl?: string; modelId?: string; provider?: string }
        | undefined;
      const key = session?.apiKey || '';
      const resolvedProvider = (prof.provider === 'custom' ? 'openai-compatible' : prof.provider) as
        | 'joy-hosted'
        | 'openrouter'
        | 'kilo'
        | 'openai-compatible';
      setProvider(resolvedProvider);
      setBaseUrl(prof.baseUrl);
      setModelId(prof.modelId);
      setSavedProfile(prof);
      setHasSavedKey(Boolean(key));

      await engineClient.configure({
        provider: resolvedProvider,
        baseUrl: prof.baseUrl.replace(/\/$/, ''),
        modelId: prof.modelId,
        apiKey: key,
      });
      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);
      const message = `Connected to ${prof.name || prof.provider}: ${prof.modelId}`;
      setConnectionNotice({ kind: 'success', message });
      onNotice?.(message, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to switch provider';
      setConnectionNotice({ kind: 'error', message });
    } finally {
      setWorking(false);
    }
  };

  const removeProfile = async (profId: string) => {
    if (!isDesktopHost()) return;
    try {
      await deleteDesktopProviderProfile(profId);
      await loadProfiles();
      if (savedProfile?.id === profId) {
        setSavedProfile(undefined);
        setHasSavedKey(false);
      }
    } catch (err) {
      console.warn('Failed to delete provider profile:', err);
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

  const filteredDiscoveredModels = discoveredModels.filter((m) =>
    modelFilter ? m.toLowerCase().includes(modelFilter.toLowerCase()) : true,
  );

  return (
    <div className="agent-settings-backdrop" role="presentation" onMouseDown={close}>
      <section
        className="joy-agent-settings-dialog-v2"
        role="dialog"
        aria-modal="true"
        aria-labelledby="joy-agent-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <header className="joy-agent-settings-header">
          <div className="joy-agent-settings-header-title">
            <h2 id="joy-agent-settings-title">Joy Code Settings</h2>
            <span className="joy-settings-badge">AI Engine Workspace</span>
          </div>
          <button
            className="joy-agent-settings-close-btn icon-button"
            type="button"
            aria-label="Close settings"
            onClick={close}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Two-Pane Body */}
        <div className="joy-agent-settings-body">
          {/* Left Sidebar */}
          <nav className="joy-agent-settings-sidebar" aria-label="Settings categories">
            <button
              type="button"
              className={`joy-settings-nav-item ${activeTab === 'models' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('models')}
            >
              <span className="joy-settings-nav-icon">⚡</span>
              <span>AI Models &amp; APIs</span>
            </button>
            <button
              type="button"
              className={`joy-settings-nav-item ${activeTab === 'execution' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('execution')}
            >
              <span className="joy-settings-nav-icon">🛡️</span>
              <span>Execution &amp; Safety</span>
            </button>
            <button
              type="button"
              className={`joy-settings-nav-item ${activeTab === 'experience' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('experience')}
            >
              <span className="joy-settings-nav-icon">👁️</span>
              <span>Live Experience</span>
            </button>
            <button
              type="button"
              className={`joy-settings-nav-item ${activeTab === 'permissions' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('permissions')}
            >
              <span className="joy-settings-nav-icon">🔧</span>
              <span>Tools &amp; Perms</span>
            </button>
            <button
              type="button"
              className={`joy-settings-nav-item ${activeTab === 'diagnostics' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('diagnostics')}
            >
              <span className="joy-settings-nav-icon">🧪</span>
              <span>Media Diagnostics</span>
            </button>

            <div className="joy-settings-sidebar-footer">
              <div className="joy-settings-sidebar-status">
                <span
                  className={`joy-settings-sidebar-status-dot ${connectionStatus?.capability ? 'is-connected' : ''}`}
                />
                <span>
                  {connectionStatus?.capability
                    ? `${connectionStatus.provider}: ${connectionStatus.modelId}`
                    : 'Not connected'}
                </span>
              </div>
            </div>
          </nav>

          {/* Right Main Panel */}
          <div className="joy-agent-settings-main">
            {/* TAB 1: MODELS & APIS */}
            {activeTab === 'models' && (
              <>
                <div className="joy-settings-section-header">
                  <span className="joy-settings-section-kicker">Connection &amp; Endpoints</span>
                  <h3 className="joy-settings-section-title">AI Models &amp; Providers</h3>
                  <p className="joy-settings-section-desc">
                    Connect Kilo Gateway, OpenRouter, or any custom OpenAI / S3-compatible link.
                    Discover available models behind any endpoint and switch models instantly.
                  </p>
                </div>

                {/* Active Model Status Banner */}
                <div className="joy-settings-active-banner">
                  <div className="joy-settings-active-info">
                    <div className="joy-settings-active-icon">⚡</div>
                    <div className="joy-settings-active-details">
                      <strong>
                        {connectionStatus?.modelId
                          ? `Active Model: ${connectionStatus.modelId}`
                          : 'No Active Model Connected'}
                      </strong>
                      <span>
                        {connectionStatus?.capability === 'tool-loop'
                          ? 'Tool loop ready · High capabilities'
                          : connectionStatus?.capability === 'plan-only'
                            ? 'Plan-only ready · Creative brief available'
                            : connectionStatus?.capability === 'incompatible'
                              ? (connectionStatus.message ?? 'Connection error')
                              : 'Connect a model below to enable Joy Code AI editing.'}
                      </span>
                    </div>
                  </div>
                  {connectionStatus && (
                    <button
                      type="button"
                      className="joy-btn-secondary"
                      onClick={clear}
                      disabled={working}
                    >
                      Disconnect
                    </button>
                  )}
                </div>

                {/* Configured Connections List */}
                {profiles.length > 0 && (
                  <div className="joy-settings-card">
                    <div className="joy-settings-card-header">
                      <h4 className="joy-settings-card-title">Saved API Connections</h4>
                      <span style={{ fontSize: '11.5px', color: '#888' }}>
                        {profiles.length} connection{profiles.length === 1 ? '' : 's'} in DPAPI vault
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {profiles.map((prof) => {
                        const isActive =
                          connectionStatus?.provider === prof.provider &&
                          connectionStatus?.modelId === prof.modelId;
                        return (
                          <div
                            key={prof.id}
                            className={`joy-settings-provider-card ${isActive ? 'is-active' : ''}`}
                          >
                            <div className="joy-settings-provider-meta">
                              <strong>
                                {prof.name || prof.provider}{' '}
                                {isActive && (
                                  <span style={{ color: '#ffb020', fontWeight: 'bold' }}>
                                    (Active)
                                  </span>
                                )}
                              </strong>
                              <span>
                                {prof.modelId} · {prof.baseUrl}
                                {prof.cachedModels ? ` · ${prof.cachedModels.length} models` : ''}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              {!isActive && (
                                <button
                                  type="button"
                                  className="joy-btn-secondary"
                                  onClick={() => void connectProfile(prof)}
                                  disabled={working}
                                >
                                  Use Model
                                </button>
                              )}
                              <button
                                type="button"
                                className="joy-btn-danger"
                                onClick={() => void removeProfile(prof.id)}
                                title="Remove connection"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Add / Connect Form */}
                <div className="joy-settings-card">
                  <div className="joy-settings-card-header">
                    <h4 className="joy-settings-card-title">Add or Connect Model Endpoint</h4>
                    <span className="agent-settings-session-chip">
                      {provider === 'joy-hosted' ? 'JOY Pro Gateway' : 'Session-only BYOK'}
                    </span>
                  </div>

                  <div className="joy-settings-form-grid">
                    <div className="joy-settings-field">
                      <label>
                        Connection Nickname
                        <input
                          type="text"
                          value={connectionName}
                          onChange={(e) => setConnectionName(e.target.value)}
                          placeholder="e.g. Kilo Gateway or OpenRouter"
                          disabled={working || mediaProbeWorking}
                        />
                      </label>
                    </div>

                    <div className="joy-settings-field">
                      <label>
                        Provider Mode
                        <select
                          value={provider}
                          onChange={(event) => setProviderKind(event.target.value as typeof provider)}
                          disabled={working || mediaProbeWorking}
                        >
                          <option value="joy-hosted">Joy Model (Built-in Pro AI)</option>
                          <option value="kilo">Kilo Gateway (BYOK)</option>
                          <option value="openrouter">OpenRouter (BYOK)</option>
                          <option value="openai-compatible">Custom OpenAI-compatible (BYOK)</option>
                        </select>
                      </label>
                    </div>

                    {provider === 'joy-hosted' ? (
                      <div className="joy-settings-field-full" style={{ fontSize: '0.85rem', color: '#888' }}>
                        Included with your active JOY Pro subscription. No external API key required.
                      </div>
                    ) : (
                      <>
                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            Base URL / Endpoint Link
                            <input
                              type="url"
                              value={baseUrl}
                              onChange={(e) => setBaseUrl(e.target.value)}
                              placeholder="https://..."
                              disabled={working || mediaProbeWorking}
                            />
                          </label>
                        </div>

                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            Model ID
                            <input
                              value={modelId}
                              onChange={(event) => setModelId(event.target.value)}
                              placeholder="provider/model"
                              disabled={working || mediaProbeWorking}
                            />
                          </label>
                        </div>

                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            API Key
                            <input
                              ref={keyRef}
                              type="password"
                              placeholder={hasSavedKey ? '(Saved in desktop vault)' : 'Enter API key'}
                              disabled={working || mediaProbeWorking}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </label>
                          {hasSavedKey && (
                            <span style={{ fontSize: '11px', color: '#10b981', marginTop: '2px' }}>
                              (Saved in desktop vault)
                            </span>
                          )}
                          <span style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                            🔒 Keys are encrypted via Windows DPAPI and never logged or proxied.
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Dynamic Discovery Action & Palette */}
                  {provider !== 'joy-hosted' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button
                          type="button"
                          className="joy-btn-secondary"
                          onClick={() => void discoverModels()}
                          disabled={isDiscovering || working}
                        >
                          {isDiscovering ? '🔍 Discovering Models…' : '🔍 Discover Models Behind Link'}
                        </button>
                        {discoveredModels.length > 0 && (
                          <span style={{ fontSize: '11.5px', color: '#10b981' }}>
                            ✓ {discoveredModels.length} models loaded
                          </span>
                        )}
                      </div>

                      {discoveryError && (
                        <div style={{ color: '#f87171', fontSize: '12px' }}>{discoveryError}</div>
                      )}

                      {discoveredModels.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <input
                            type="text"
                            placeholder="Filter discovered models (e.g. minimax, efficient, free)..."
                            value={modelFilter}
                            onChange={(e) => setModelFilter(e.target.value)}
                            style={{
                              background: '#111216',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              borderRadius: '6px',
                              padding: '6px 10px',
                              color: '#fff',
                              fontSize: '12px',
                            }}
                          />
                          <div className="joy-settings-model-chips">
                            {filteredDiscoveredModels.slice(0, 40).map((m) => (
                              <button
                                key={m}
                                type="button"
                                className={`joy-settings-model-chip ${modelId === m ? 'is-selected' : ''}`}
                                onClick={() => setModelId(m)}
                              >
                                {m}
                              </button>
                            ))}
                            {filteredDiscoveredModels.length > 40 && (
                              <span style={{ fontSize: '11px', color: '#666', alignSelf: 'center' }}>
                                +{filteredDiscoveredModels.length - 40} more
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {provider === 'openai-compatible' && (
                    <label className="agent-toggle" style={{ fontSize: '12px', color: '#aaa' }}>
                      <input
                        type="checkbox"
                        checked={customDisclosure}
                        onChange={(event) => setCustomDisclosure(event.target.checked)}
                        disabled={working || mediaProbeWorking}
                      />
                      I understand that custom endpoints may log requests according to their own policy.
                    </label>
                  )}

                  <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                    <button
                      type="button"
                      className="joy-btn-primary"
                      onClick={() => void connect()}
                      disabled={working || mediaProbeWorking}
                    >
                      {working ? 'Connecting…' : 'Connect model'}
                    </button>
                    <button
                      type="button"
                      className="joy-btn-secondary"
                      onClick={clear}
                      disabled={working}
                    >
                      Clear connection
                    </button>
                  </div>

                  {connectionNotice && (
                    <div
                      className={`agent-settings-notice is-${connectionNotice.kind}`}
                      role="status"
                    >
                      <span>{connectionNotice.message}</span>
                    </div>
                  )}
                </div>

                {/* Media Capability Probe Section */}
                <section className="agent-media-capability-probe joy-settings-card" aria-label="Media capability check">
                  <div className="agent-settings-section-heading">
                    <div>
                      <span className="agent-settings-kicker">Optional capability check</span>
                      <h3 style={{ margin: 0, fontSize: '14px', color: '#fff' }}>Check media support</h3>
                    </div>
                    <span className="agent-settings-session-chip">Explicit only</span>
                  </div>
                  <p className="agent-settings-hint" style={{ margin: 0 }}>
                    This sends three tiny product-owned synthetic samples (image, audio, and video) to
                    your configured provider. It never sends your project, owner, or uploaded media.
                    Your provider may charge or log these requests.
                  </p>
                  <div className="agent-settings-actions">
                    <button
                      type="button"
                      className="button-secondary joy-btn-secondary"
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
              </>
            )}

            {/* TAB 2: EXECUTION & SAFETY */}
            {activeTab === 'execution' && (
              <>
                <div className="joy-settings-section-header">
                  <span className="joy-settings-section-kicker">Agent Behavior</span>
                  <h3 className="joy-settings-section-title">Execution &amp; Safety</h3>
                  <p className="joy-settings-section-desc">
                    Control how aggressively Joy Code modifies your timeline, review policies, and set run budgets.
                  </p>
                </div>

                <div className="joy-settings-card">
                  <h4 className="joy-settings-card-title">Execution Mode</h4>
                  <div className="joy-settings-mode-grid">
                    {Object.entries(MODES).map(([val, lbl]) => {
                      const isSelected = policy.executionMode === val;
                      return (
                        <div
                          key={val}
                          className={`joy-settings-mode-card ${isSelected ? 'is-selected' : ''}`}
                          onClick={() => update('executionMode', val as AgentExecutionMode)}
                        >
                          <div className="joy-settings-mode-card-title">
                            <span>{lbl}</span>
                            {isSelected && <span style={{ color: '#ffb020' }}>✓</span>}
                          </div>
                          <span className="joy-settings-mode-card-desc">
                            {MODE_DESCRIPTIONS[val as AgentExecutionMode]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="joy-settings-card">
                  <h4 className="joy-settings-card-title">Budget &amp; Privacy</h4>
                  <div className="joy-settings-form-grid">
                    <div className="joy-settings-field">
                      <label>
                        Maximum Provider Cost per Run (USD)
                        <input
                          type="number"
                          min={0}
                          step={0.25}
                          value={policy.maxCostPerRunUsd}
                          onChange={(e) =>
                            update('maxCostPerRunUsd', Math.max(0, Number(e.target.value) || 0))
                          }
                        />
                      </label>
                    </div>

                    <div className="joy-settings-field">
                      <label>
                        Privacy Policy
                        <select
                          value={policy.privacyMode}
                          onChange={(e) =>
                            update('privacyMode', e.target.value as AgentPolicyPreferences['privacyMode'])
                          }
                        >
                          <option value="ask-before-remote">Ask before remote processing</option>
                          <option value="local-only">Local only</option>
                        </select>
                      </label>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* TAB 3: LIVE EXPERIENCE */}
            {activeTab === 'experience' && (
              <>
                <div className="joy-settings-section-header">
                  <span className="joy-settings-section-kicker">Interactive Feedback</span>
                  <h3 className="joy-settings-section-title">Live Experience</h3>
                  <p className="joy-settings-section-desc">
                    Configure real-time preview playback and visual feedback when the agent performs actions.
                  </p>
                </div>

                <div className="joy-settings-card">
                  <label className="agent-toggle" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <input
                      type="checkbox"
                      checked={policy.livePreview}
                      onChange={(event) => update('livePreview', event.target.checked)}
                      style={{ accentColor: '#ffb020' }}
                    />
                    <strong style={{ fontSize: '13.5px', color: '#fff' }}>
                      Preview edits live before approval
                    </strong>
                  </label>
                  <p style={{ margin: 0, fontSize: '12px', color: '#888', paddingLeft: '24px' }}>
                    When enabled, timeline changes are rendered in a preview overlay so you can visually verify
                    before applying.
                  </p>
                </div>
              </>
            )}

            {/* TAB 4: TOOLS & PERMISSIONS */}
            {activeTab === 'permissions' && (
              <>
                <div className="joy-settings-section-header">
                  <span className="joy-settings-section-kicker">Security Boundaries</span>
                  <h3 className="joy-settings-section-title">Tools &amp; Permissions</h3>
                  <p className="joy-settings-section-desc">
                    Control which tools and capabilities Joy Code is allowed to invoke.
                  </p>
                </div>

                <div className="joy-settings-card">
                  <div className="joy-settings-card-header">
                    <h4 className="joy-settings-card-title">Allowed Capabilities</h4>
                    <span style={{ fontSize: '12px', color: '#ffb020' }}>
                      {policy.allowedCapabilities.length} of {ALL_TOOL_CAPABILITIES.length} enabled
                    </span>
                  </div>

                  <div className="joy-settings-capabilities-grid">
                    {ALL_TOOL_CAPABILITIES.map((cap) => {
                      const isAllowed = policy.allowedCapabilities.includes(cap);
                      return (
                        <label key={cap} className="joy-settings-cap-item">
                          <input
                            type="checkbox"
                            checked={isAllowed}
                            onChange={() =>
                              update(
                                'allowedCapabilities',
                                isAllowed
                                  ? policy.allowedCapabilities.filter((c) => c !== cap)
                                  : ([...policy.allowedCapabilities, cap] as readonly ToolCapability[]),
                              )
                            }
                          />
                          <span>{cap}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            {/* TAB 5: DIAGNOSTICS */}
            {activeTab === 'diagnostics' && (
              <>
                <div className="joy-settings-section-header">
                  <span className="joy-settings-section-kicker">Diagnostics</span>
                  <h3 className="joy-settings-section-title">Media Diagnostics &amp; Health</h3>
                  <p className="joy-settings-section-desc">
                    Run synthetic probe tests on image, audio, and video modalities for your active model.
                  </p>
                </div>

                <div className="joy-settings-card">
                  <div className="joy-settings-card-header">
                    <h4 className="joy-settings-card-title">Modality Probe</h4>
                    <button
                      type="button"
                      className="joy-btn-secondary"
                      onClick={() => void probeMediaCapabilities()}
                      disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                    >
                      {mediaProbeWorking ? 'Checking media support…' : 'Check media support'}
                    </button>
                  </div>

                  {mediaCapabilities !== undefined ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div className="joy-settings-diagnostic-row">
                        <span>Image Modality</span>
                        <span
                          className={`joy-settings-diagnostic-status ${mediaCapabilities.image === 'supported' ? 'is-supported' : 'is-unavailable'}`}
                        >
                          {mediaCapabilities.image === 'supported' ? 'Supported' : 'Unavailable'}
                        </span>
                      </div>
                      <div className="joy-settings-diagnostic-row">
                        <span>Audio Modality</span>
                        <span
                          className={`joy-settings-diagnostic-status ${mediaCapabilities.audio === 'supported' ? 'is-supported' : 'is-unavailable'}`}
                        >
                          {mediaCapabilities.audio === 'supported' ? 'Supported' : 'Unavailable'}
                        </span>
                      </div>
                      <div className="joy-settings-diagnostic-row">
                        <span>Video Modality</span>
                        <span
                          className={`joy-settings-diagnostic-status ${mediaCapabilities.video === 'supported' ? 'is-supported' : 'is-unavailable'}`}
                        >
                          {mediaCapabilities.video === 'supported' ? 'Supported' : 'Unavailable'}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>
                      No probe run yet for the active model. Click &quot;Check media support&quot; above to probe.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="joy-agent-settings-footer">
          <div className="joy-agent-settings-footer-vault">
            <span>🔒 Policy saved locally in browser. Sensitive keys secured in Windows DPAPI vault.</span>
          </div>
          <button type="button" className="agent-settings-done joy-btn-primary" onClick={close}>
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
