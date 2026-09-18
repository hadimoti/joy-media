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
  type DesktopProviderProfile,
} from './desktop-client.js';
import { getStoredMediaToken } from './media-session.js';
import { DesktopAccountModal } from './DesktopAccountModal.js';
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

const TAB_CONFIG: {
  readonly id: JoyAgentSettingsTab;
  readonly label: string;
  readonly icon: string;
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    id: 'models',
    label: 'AI Models & APIs',
    icon: '⚡',
    kicker: 'Provider & Model Configuration',
    title: 'AI Models & Custom Links',
    description:
      'Configure endpoints, discover available models behind any link, and switch active reasoning brains.',
  },
  {
    id: 'execution',
    label: 'Execution & Safety',
    icon: '🛡️',
    kicker: 'Autonomy & Cost Limits',
    title: 'Execution Policy & Run Budgets',
    description:
      'Control how autonomously Joy Code applies timeline edits, cuts, and visual effects.',
  },
  {
    id: 'experience',
    label: 'Live Experience',
    icon: '👁️',
    kicker: 'Real-time Interaction',
    title: 'Live Previews & Experience',
    description:
      'Tune real-time visual ghost overlays and editor presence during agent runs.',
  },
  {
    id: 'permissions',
    label: 'Tools & Perms',
    icon: '🔧',
    kicker: 'Granular Engine Access',
    title: 'Tool Capabilities & Access Gates',
    description:
      'Toggle permissions for timeline modification, audio processing, and generative vision tools.',
  },
  {
    id: 'diagnostics',
    label: 'Media Diagnostics',
    icon: '🧪',
    kicker: 'Engine & Probe Telemetry',
    title: 'System Health & Modality Probes',
    description:
      'Run synthetic modality probes and inspect local GPU hardware acceleration telemetry.',
  },
];

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

  // Accordion state (keys: section IDs)
  const [openAccordions, setOpenAccordions] = useState<Record<string, boolean>>({
    'models-endpoint': true,
    'models-drawer': false,
    'models-probe': true,
    'exec-mode': true,
    'exec-budget': false,
    'exec-privacy': false,
    'exp-previews': true,
    'perms-timeline': true,
    'diag-probe': true,
    'diag-health': true,
  });

  const toggleAccordion = (id: string) => {
    setOpenAccordions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

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
  const [working, setWorking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();

  // Multi-profile state
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfile[]>([]);
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfile | undefined>(undefined);
  const [hasSavedKey, setHasSavedKey] = useState(false);

  // Dynamic model discovery & Drawer state
  const [discoveredModels, setDiscoveredModels] = useState<readonly string[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);

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
  }, [status]);

  useEffect(() => {
    const cached = matchingMediaCapabilityReport(
      engineClient.getMediaCapabilities(),
      connectionStatus?.modelId,
    );
    setMediaCapabilities(cached);
  }, [connectionStatus?.modelId, engineClient]);

  const invalidateMediaProbe = () => {
    mediaProbeEpochRef.current += 1;
    setMediaCapabilities(undefined);
    setMediaProbeNotice(undefined);
  };

  const close = () => {
    invalidateMediaProbe();
    onClose();
  };

  const handleProviderChange = (
    next: 'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible',
  ) => {
    setProvider(next);
    setConnectionNotice(undefined);
    setDiscoveryError(null);
    if (next === 'openrouter') {
      setBaseUrl('https://openrouter.ai/api/v1');
      if (!modelId || modelId === 'minimax/minimax-m3' || modelId === 'kilo-auto/efficient') {
        setModelId('openrouter/auto');
      }
    } else if (next === 'kilo') {
      setBaseUrl('https://api.kilo.ai/v1');
      if (!modelId || modelId === 'openrouter/auto') {
        setModelId('kilo-auto/efficient');
      }
    } else if (next === 'joy-hosted') {
      setBaseUrl('https://joyst.ir/api/v1/agent');
      setModelId('minimax/minimax-m3');
    } else {
      setBaseUrl('');
    }
  };

  const discoverModels = async (explicitKey?: string) => {
    const key = explicitKey ?? keyRef.current?.value ?? '';
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    if (!normalizedBaseUrl) {
      setDiscoveryError('Please enter a Base URL before discovering models');
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
      if (modelIds.length > 0) {
        // Auto-resolve and reveal the Model Drawer
        setOpenAccordions((prev) => ({ ...prev, 'models-drawer': true }));
        if (!modelIds.includes(modelId)) {
          const prefer =
            modelIds.find(
              (m) =>
                m.includes('minimax') ||
                m.includes('efficient') ||
                m.includes('auto') ||
                m.includes('claude'),
            ) || modelIds[0];
          if (prefer) {
            setModelId(prefer);
          }
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setDiscoveryError(
        err instanceof Error ? err.message : 'Failed to discover models behind endpoint',
      );
    } finally {
      if (mountedRef.current) setIsDiscovering(false);
    }
  };

  const connect = async () => {
    if (working) return;
    invalidateMediaProbe();
    setWorking(true);
    setConnectionNotice(undefined);
    setDiscoveryError(null);

    let key = keyRef.current?.value.trim() ?? '';
    if (provider !== 'joy-hosted' && !key && hasSavedKey && savedProfile?.id) {
      try {
        const session = (await beginDesktopProviderSession(savedProfile.id)) as
          | { apiKey?: string; baseUrl?: string; modelId?: string }
          | undefined;
        if (session?.apiKey) {
          key = session.apiKey;
        }
      } catch {
        /* proceed to validation */
      }
    }

    if (provider !== 'joy-hosted' && !key) {
      setConnectionNotice({ kind: 'error', message: 'API key is required.' });
      onNotice?.('API key is required.', 'error');
      setWorking(false);
      return;
    }

    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) {
      setConnectionNotice({ kind: 'error', message: 'Model ID is required.' });
      onNotice?.('Model ID is required.', 'error');
      setWorking(false);
      return;
    }

    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    if (!normalizedBaseUrl) {
      setConnectionNotice({ kind: 'error', message: 'Base URL is required.' });
      onNotice?.('Base URL is required.', 'error');
      setWorking(false);
      return;
    }

    try {
      if (isDesktopHost() && provider !== 'joy-hosted' && key) {
        const saved = await saveDesktopProviderProfile({
          provider: provider === 'openai-compatible' ? 'custom' : provider,
          name: connectionName.trim() || undefined,
          baseUrl: normalizedBaseUrl,
          modelId: normalizedModelId,
          apiKey: key,
        });
        if (saved) {
          setSavedProfile(saved);
          setHasSavedKey(true);
          await loadProfiles();
        }
      }

      let sessionKey = key;
      if (provider === 'joy-hosted') {
        const mediaToken =
          typeof window !== 'undefined' ? getStoredMediaToken(window.localStorage) : undefined;
        sessionKey = mediaToken ?? 'joy-hosted-default';
      }

      await engineClient.configure({
        provider,
        baseUrl: normalizedBaseUrl,
        modelId: normalizedModelId,
        apiKey: sessionKey,
      });

      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);

      const message =
        next.capability === 'tool-loop'
          ? 'Connected successfully. JOY is ready to edit in this session.'
          : next.capability === 'plan-only'
            ? 'Connected in plan-only mode. Timeline execution is restricted.'
            : 'The provider responded, but JOY could not use its tool loop.';
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);

      // Trigger automatic model discovery and resolve the drawer if we have an API key and URL
      if (provider !== 'joy-hosted' && next.capability !== 'incompatible') {
        void discoverModels(key);
      }
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

      if (key) {
        void discoverModels(key);
      }
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
    if (!configuredModelId) return;

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

  const activeTabMeta = TAB_CONFIG.find((t) => t.id === activeTab) ?? TAB_CONFIG[0];

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
            <div className="joy-settings-logo-mark">⚡</div>
            <div>
              <h2 id="joy-agent-settings-title">Joy Code Settings</h2>
              <span className="joy-settings-header-sub">Professional AI Engine Workspace</span>
            </div>
            <span className="joy-settings-badge">v2.0 Workspace</span>
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
          {/* Left Vertical Sidebar (faq-theme tabs navigation) */}
          <nav className="joy-agent-settings-sidebar" aria-label="Settings categories">
            <div className="joy-settings-sidebar-section-label">Categories</div>
            <div className="joy-settings-sidebar-list">
              {TAB_CONFIG.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`joy-settings-nav-item ${activeTab === id ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(id)}
                >
                  <span className="joy-settings-nav-icon">{icon}</span>
                  <span className="joy-settings-nav-label">{label}</span>
                </button>
              ))}
            </div>

            <div className="joy-settings-sidebar-footer">
              <div className="joy-settings-sidebar-status">
                <span
                  className={`joy-settings-sidebar-status-dot ${connectionStatus?.capability ? 'is-connected' : ''}`}
                />
                <div className="joy-settings-sidebar-status-text">
                  <div className="joy-settings-sidebar-status-label">
                    {connectionStatus?.capability ? 'Engine Online' : 'Offline'}
                  </div>
                  <div className="joy-settings-sidebar-status-sub">
                    {connectionStatus?.capability
                      ? `${connectionStatus.provider}: ${displayModelId(connectionStatus.modelId)}`
                      : 'No provider connected'}
                  </div>
                </div>
              </div>
            </div>
          </nav>

          {/* Right Main Panel (faq-theme accordion content) */}
          <main className="joy-agent-settings-main">
            {/* Section Header */}
            <div className="joy-settings-section-header">
              <span className="joy-settings-section-kicker">{activeTabMeta?.kicker ?? ''}</span>
              <h3 className="joy-settings-section-title">{activeTabMeta?.title ?? ''}</h3>
              <p className="joy-settings-section-desc">{activeTabMeta?.description ?? ''}</p>
            </div>

            {/* TAB 1: AI MODELS & APIS */}
            {activeTab === 'models' && (
              <div className="joy-accordion">
                {/* Active Connection Banner */}
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
                          ? `Connected to ${connectionStatus.provider} (Autonomous tool execution enabled)`
                          : connectionStatus?.capability === 'plan-only'
                            ? `Connected to ${connectionStatus.provider} (Plan-only mode)`
                            : 'Configure an API endpoint below to connect JOY Code.'}
                      </span>
                    </div>
                  </div>
                  {connectionStatus?.modelId && (
                    <button
                      type="button"
                      className="joy-btn-secondary joy-btn-sm"
                      onClick={clear}
                    >
                      Disconnect
                    </button>
                  )}
                </div>

                {/* Saved Vault Profiles Bar */}
                {profiles.length > 0 && (
                  <div className="joy-settings-vault-profiles">
                    <div className="joy-settings-vault-profiles-header">
                      <span>Saved Vault Profiles ({profiles.length})</span>
                    </div>
                    <div className="joy-settings-vault-profiles-grid">
                      {profiles.map((prof) => (
                        <div
                          key={prof.id}
                          className={`joy-settings-provider-card ${savedProfile?.id === prof.id ? 'is-active' : ''}`}
                        >
                          <div className="joy-settings-provider-meta">
                            <strong>{prof.name || prof.provider}</strong>
                            <span>{displayModelId(prof.modelId)}</span>
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              className="joy-btn-secondary joy-btn-sm"
                              onClick={() => void connectProfile(prof)}
                              disabled={working}
                            >
                              Use
                            </button>
                            <button
                              type="button"
                              className="joy-btn-danger joy-btn-sm"
                              onClick={() => void removeProfile(prof.id)}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ACCORDION 1: Connection Endpoint & Credentials */}
                <div
                  className={`joy-accordion-item ${openAccordions['models-endpoint'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('models-endpoint')}
                    aria-expanded={openAccordions['models-endpoint']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">🔌</span>
                      <span>API Connection &amp; Authentication</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {provider === 'joy-hosted'
                          ? 'JOY Pro AI'
                          : provider === 'kilo'
                            ? 'Kilo Gateway'
                            : provider === 'openrouter'
                              ? 'OpenRouter'
                              : 'Custom Endpoint'}
                      </span>
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['models-endpoint'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-form-grid">
                        <div className="joy-settings-field">
                          <label>
                            <span>Provider Platform</span>
                            <select
                              value={provider}
                              onChange={(e) =>
                                handleProviderChange(
                                  e.target.value as
                                    | 'joy-hosted'
                                    | 'openrouter'
                                    | 'kilo'
                                    | 'openai-compatible',
                                )
                              }
                            >
                              <option value="openrouter">OpenRouter (BYOK)</option>
                              <option value="kilo">Kilo Gateway (api.kilo.ai)</option>
                              <option value="openai-compatible">Custom S3 / OpenAI Compatible</option>
                              <option value="joy-hosted">Joy Model (Built-in Pro AI)</option>
                            </select>
                          </label>
                        </div>

                        <div className="joy-settings-field">
                          <label>
                            <span>Connection Profile Name (Optional)</span>
                            <input
                              type="text"
                              placeholder="e.g. My Kilo Fast, Local Ollama"
                              value={connectionName}
                              onChange={(e) => setConnectionName(e.target.value)}
                            />
                          </label>
                        </div>

                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <span>Base URL / Endpoint</span>
                            <input
                              type="text"
                              placeholder="https://..."
                              value={baseUrl}
                              onChange={(e) => setBaseUrl(e.target.value)}
                            />
                          </label>
                        </div>

                        {provider === 'joy-hosted' ? (
                          <div className="joy-settings-field-full joy-settings-pro-card">
                            <p style={{ margin: 0, fontSize: '13px', color: '#ffb020' }}>
                              ⚡ Included with your active JOY Pro subscription.
                            </p>
                            <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#888' }}>
                              Uses authenticated secure reverse-proxy via joyst.ir. No secret key required.
                            </p>
                            {typeof window !== 'undefined' && !getStoredMediaToken(window.localStorage) ? (
                              <div style={{ marginTop: '10px' }}>
                                <button
                                  type="button"
                                  className="joy-settings-text-btn"
                                  style={{
                                    padding: '6px 12px',
                                    background: 'linear-gradient(135deg, #00d2ff, #0077ff)',
                                    border: 'none',
                                    borderRadius: '6px',
                                    color: '#ffffff',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                  onClick={() => setAccountModalOpen(true)}
                                >
                                  🔑 Sign In with JOY Account to Activate
                                </button>
                              </div>
                            ) : (
                              <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: '#10b981' }}>
                                ✓ JOY Account session linked
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="joy-settings-field-full joy-settings-field">
                            <label>
                              <span>API Secret Key</span>
                              <input
                                ref={keyRef}
                                type="password"
                                placeholder={hasSavedKey ? '•••••••••••••••• (Leave blank to keep saved)' : 'sk-...'}
                                defaultValue=""
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
                        )}

                        {/* Model ID Text Input with Model Drawer Trigger */}
                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span>Model ID (User Editable)</span>
                              {provider !== 'joy-hosted' && (
                                <button
                                  type="button"
                                  className="joy-settings-text-btn"
                                  onClick={() => {
                                    toggleAccordion('models-drawer');
                                    if (discoveredModels.length === 0) {
                                      void discoverModels();
                                    }
                                  }}
                                >
                                  {openAccordions['models-drawer']
                                    ? '▲ Hide Model Drawer'
                                    : '⚡ Open Model Drawer ▾'}
                                </button>
                              )}
                            </div>
                            <div className="joy-settings-input-with-action">
                              <input
                                type="text"
                                placeholder="provider/model"
                                value={modelId}
                                onChange={(e) => setModelId(e.target.value)}
                              />
                              {provider !== 'joy-hosted' && (
                                <button
                                  type="button"
                                  className="joy-btn-secondary"
                                  onClick={() => void discoverModels()}
                                  disabled={isDiscovering || working}
                                  title="Discover models behind API endpoint"
                                >
                                  {isDiscovering ? '🔍 Scanning…' : '🔍 Discover Models'}
                                </button>
                              )}
                            </div>
                          </label>
                        </div>
                      </div>

                      {/* Connection Actions */}
                      <div className="joy-settings-actions-bar">
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                          <button
                            type="button"
                            className="joy-btn-primary"
                            onClick={() => void connect()}
                            disabled={working}
                          >
                            {working ? 'Connecting…' : 'Connect model'}
                          </button>
                          {connectionStatus?.capability && (
                            <button
                              type="button"
                              className="joy-btn-secondary"
                              onClick={clear}
                              disabled={working}
                            >
                              Clear connection
                            </button>
                          )}
                        </div>

                        {connectionNotice && (
                          <div
                            className={`joy-settings-notice ${connectionNotice.kind === 'error' ? 'is-error' : connectionNotice.kind === 'success' ? 'is-success' : 'is-info'}`}
                          >
                            {connectionNotice.message}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* ACCORDION 2: Discovered Models Palette / Selection Drawer */}
                {provider !== 'joy-hosted' && (
                  <div
                    className={`joy-accordion-item joy-model-drawer-item ${openAccordions['models-drawer'] ? 'is-open' : ''}`}
                  >
                    <button
                      type="button"
                      className="joy-accordion-trigger"
                      onClick={() => toggleAccordion('models-drawer')}
                      aria-expanded={openAccordions['models-drawer']}
                    >
                      <div className="joy-accordion-trigger-title">
                        <span className="joy-accordion-icon">🎨</span>
                        <span>Discovered Models Drawer</span>
                      </div>
                      <div className="joy-accordion-trigger-meta">
                        {discoveredModels.length > 0 ? (
                          <span className="joy-accordion-tag is-success">
                            ✓ {discoveredModels.length} Models Ready
                          </span>
                        ) : (
                          <span className="joy-accordion-tag">Click to Resolve</span>
                        )}
                        <span className="joy-accordion-chevron">▾</span>
                      </div>
                    </button>

                    {openAccordions['models-drawer'] && (
                      <div className="joy-accordion-content joy-model-drawer-content">
                        <div className="joy-model-drawer-header">
                          <p className="joy-model-drawer-hint">
                            Select a discovered model chip to populate the Model ID, or filter by keyword:
                          </p>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                              type="button"
                              className="joy-btn-secondary joy-btn-sm"
                              onClick={() => void discoverModels()}
                              disabled={isDiscovering || working}
                            >
                              {isDiscovering ? 'Refreshing…' : '🔄 Refresh Models'}
                            </button>
                          </div>
                        </div>

                        {discoveryError && (
                          <div className="joy-settings-notice is-error" style={{ marginBottom: '10px' }}>
                            {discoveryError}
                          </div>
                        )}

                        <div className="joy-model-drawer-search">
                          <input
                            type="text"
                            placeholder="Filter models (e.g. minimax, efficient, free, sonnet, 4o)..."
                            value={modelFilter}
                            onChange={(e) => setModelFilter(e.target.value)}
                          />
                        </div>

                        {/* Quick Filter Tag Buttons */}
                        <div className="joy-model-drawer-tags">
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === '' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('')}
                          >
                            All
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'minimax' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('minimax')}
                          >
                            MiniMax / M3
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'efficient' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('efficient')}
                          >
                            Efficient
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'free' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('free')}
                          >
                            Free
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'claude' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('claude')}
                          >
                            Claude
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'gpt' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('gpt')}
                          >
                            GPT
                          </button>
                        </div>

                        {/* Interactive Model Chips Grid */}
                        <div className="joy-settings-model-chips">
                          {filteredDiscoveredModels.length > 0 ? (
                            filteredDiscoveredModels.slice(0, 80).map((m) => (
                              <button
                                key={m}
                                type="button"
                                className={`joy-settings-model-chip ${modelId === m ? 'is-selected' : ''}`}
                                onClick={() => setModelId(m)}
                              >
                                {m}
                              </button>
                            ))
                          ) : (
                            <div className="joy-model-drawer-empty">
                              {isDiscovering
                                ? 'Scanning endpoint for available models...'
                                : discoveredModels.length === 0
                                  ? 'No models discovered yet. Enter Base URL and API Key above, then click "Discover Models".'
                                  : 'No models matching current filter.'}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ACCORDION 3: Synthetic Media Capability Diagnostics */}
                <div
                  className={`joy-accordion-item ${openAccordions['models-probe'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('models-probe')}
                    aria-expanded={openAccordions['models-probe']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">👁️</span>
                      <span>Synthetic Media Capability Probe</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      {mediaCapabilities ? (
                        <span className="joy-accordion-tag is-success">Probe Verified</span>
                      ) : (
                        <span className="joy-accordion-tag">Unprobed</span>
                      )}
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['models-probe'] && (
                    <div className="joy-accordion-content">
                      <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#999', lineHeight: 1.4 }}>
                        Runs three tiny product-owned synthetic samples to verify multimodal image,
                        audio, and video understanding. This check never sends your project, owner, or
                        uploaded media to the provider, but your provider may charge or log these
                        requests under its standard usage terms.
                      </p>

                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
                        <button
                          type="button"
                          className="joy-btn-secondary"
                          onClick={() => void probeMediaCapabilities()}
                          disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                        >
                          {mediaProbeWorking ? 'Checking media support…' : 'Check media support'}
                        </button>
                        {mediaProbeNotice && (
                          <span
                            className={`joy-settings-inline-notice ${mediaProbeNotice.kind === 'error' ? 'is-error' : 'is-success'}`}
                          >
                            {mediaProbeNotice.message}
                          </span>
                        )}
                      </div>

                      {mediaCapabilities !== undefined && (
                        <div className="agent-media-capability-result joy-settings-media-result">
                          <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#ccc', fontWeight: 600 }}>
                            Configured model: {mediaCapabilities.modelId}
                          </p>
                          <dl className="agent-media-capability-list joy-settings-probe-grid">
                            <MediaCapabilityRow label="Image" state={mediaCapabilities.image} />
                            <MediaCapabilityRow label="Audio" state={mediaCapabilities.audio} />
                            <MediaCapabilityRow label="Video" state={mediaCapabilities.video} />
                          </dl>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 2: EXECUTION & SAFETY */}
            {activeTab === 'execution' && (
              <div className="joy-accordion">
                <div
                  className={`joy-accordion-item ${openAccordions['exec-mode'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('exec-mode')}
                    aria-expanded={openAccordions['exec-mode']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">🛡️</span>
                      <span>Execution Mode</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">{MODES[policy.executionMode]}</span>
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['exec-mode'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-mode-grid">
                        {(Object.keys(MODES) as AgentExecutionMode[]).map((mode) => (
                          <div
                            key={mode}
                            className={`joy-settings-mode-card ${policy.executionMode === mode ? 'is-selected' : ''}`}
                            onClick={() => onPolicyChange({ ...policy, executionMode: mode })}
                          >
                            <div className="joy-settings-mode-card-title">
                              <span>{MODES[mode]}</span>
                              <input
                                type="radio"
                                name="executionMode"
                                checked={policy.executionMode === mode}
                                onChange={() => onPolicyChange({ ...policy, executionMode: mode })}
                              />
                            </div>
                            <div className="joy-settings-mode-card-desc">{MODE_DESCRIPTIONS[mode]}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className={`joy-accordion-item ${openAccordions['exec-budget'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('exec-budget')}
                    aria-expanded={openAccordions['exec-budget']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">💰</span>
                      <span>Run Budget &amp; Spend Safety</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">Max ${policy.maxCostPerRunUsd.toFixed(2)}/run</span>
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['exec-budget'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-field">
                        <label>
                          <span>Max Cost per Run (USD)</span>
                          <input
                            type="number"
                            min="0.10"
                            max="50.00"
                            step="0.10"
                            value={policy.maxCostPerRunUsd}
                            onChange={(e) =>
                              onPolicyChange({
                                ...policy,
                                maxCostPerRunUsd: Math.max(0.1, Number(e.target.value) || 0.1),
                              })
                            }
                          />
                        </label>
                        <span style={{ fontSize: '11.5px', color: '#888', marginTop: '4px' }}>
                          Limits API provider token consumption per autonomous execution session.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 3: LIVE EXPERIENCE */}
            {activeTab === 'experience' && (
              <div className="joy-accordion">
                <div
                  className={`joy-accordion-item ${openAccordions['exp-previews'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('exp-previews')}
                    aria-expanded={openAccordions['exp-previews']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">👁️</span>
                      <span>Real-time Previews &amp; Ghost Overlays</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['exp-previews'] && (
                    <div className="joy-accordion-content">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <label className="joy-settings-cap-item">
                          <input
                            type="checkbox"
                            checked={policy.livePreview}
                            onChange={(e) =>
                              onPolicyChange({ ...policy, livePreview: e.target.checked })
                            }
                          />
                          <span>Show real-time previews on the monitor canvas during agent operations</span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 4: TOOLS & PERMISSIONS */}
            {activeTab === 'permissions' && (
              <div className="joy-accordion">
                <div
                  className={`joy-accordion-item ${openAccordions['perms-timeline'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('perms-timeline')}
                    aria-expanded={openAccordions['perms-timeline']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">🔧</span>
                      <span>Tool Capabilities Grid</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {policy.allowedCapabilities.length}/{ALL_TOOL_CAPABILITIES.length} Allowed
                      </span>
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['perms-timeline'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-capabilities-grid">
                        {ALL_TOOL_CAPABILITIES.map((cap) => {
                          const isAllowed = policy.allowedCapabilities.includes(cap);
                          return (
                            <label key={cap} className="joy-settings-cap-item">
                              <input
                                type="checkbox"
                                checked={isAllowed}
                                onChange={(e) => {
                                  const nextCaps = e.target.checked
                                    ? [...policy.allowedCapabilities, cap]
                                    : policy.allowedCapabilities.filter((c: ToolCapability) => c !== cap);
                                  onPolicyChange({ ...policy, allowedCapabilities: nextCaps });
                                }}
                              />
                              <span>{cap}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* TAB 5: DIAGNOSTICS */}
            {activeTab === 'diagnostics' && (
              <div className="joy-accordion">
                <div
                  className={`joy-accordion-item ${openAccordions['diag-health'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('diag-health')}
                    aria-expanded={openAccordions['diag-health']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">⚡</span>
                      <span>Local Hardware &amp; Worker Acceleration</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag is-success">Direct3D 11 Active</span>
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['diag-health'] && (
                    <div className="joy-accordion-content">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div className="joy-settings-diagnostic-row">
                          <span>GPU Device</span>
                          <span style={{ color: '#ffb020', fontWeight: 600 }}>NVIDIA GeForce RTX 5070 Ti</span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Rendering Backend</span>
                          <span className="joy-settings-diagnostic-status is-supported">ANGLE D3D11</span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Local Asset Library</span>
                          <span style={{ color: '#ccc' }}>H:\VPS-DATA\joy-media-assets</span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Local Worker SEA</span>
                          <span className="joy-settings-diagnostic-status is-supported">joy-worker.exe</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className={`joy-accordion-item ${openAccordions['diag-probe'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="joy-accordion-trigger"
                    onClick={() => toggleAccordion('diag-probe')}
                    aria-expanded={openAccordions['diag-probe']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">🧪</span>
                      <span>Active Model Synthetic Modality Probe</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-chevron">▾</span>
                    </div>
                  </button>

                  {openAccordions['diag-probe'] && (
                    <div className="joy-accordion-content">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <span style={{ fontSize: '12px', color: '#999' }}>
                          Tests whether the active reasoning model parses image, audio, and video inputs.
                        </span>
                        <button
                          type="button"
                          className="joy-btn-secondary joy-btn-sm"
                          onClick={() => void probeMediaCapabilities()}
                          disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                        >
                          {mediaProbeWorking ? 'Checking…' : 'Check media support'}
                        </button>
                      </div>

                      {mediaCapabilities !== undefined ? (
                        <div className="agent-media-capability-result joy-settings-media-result">
                          <p style={{ margin: '0 0 8px', fontSize: '12px', color: '#ccc', fontWeight: 600 }}>
                            Configured model: {mediaCapabilities.modelId}
                          </p>
                          <dl className="agent-media-capability-list joy-settings-probe-grid">
                            <MediaCapabilityRow label="Image" state={mediaCapabilities.image} />
                            <MediaCapabilityRow label="Audio" state={mediaCapabilities.audio} />
                            <MediaCapabilityRow label="Video" state={mediaCapabilities.video} />
                          </dl>
                        </div>
                      ) : (
                        <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>
                          No probe run yet for the active model.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>
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
      <DesktopAccountModal
        isOpen={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        onSuccess={() => {
          setConnectionNotice({
            kind: 'info',
            message: 'JOY Account linked successfully! Joy Model is now ready to use.',
          });
        }}
      />
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
