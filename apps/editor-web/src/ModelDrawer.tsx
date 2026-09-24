import { useEffect, useMemo, useRef, useState } from 'react';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus, JoyProviderMode } from './joy-agent/protocol.js';
import { CloseIcon, PlusIcon, CheckIcon } from './icons.js';
import {
  isDesktopHost,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  deleteDesktopProviderProfile,
  beginDesktopProviderSession,
  fetchDesktopProviderModels,
  type DesktopProviderProfile,
} from './desktop-client.js';
import './ModelDrawer.css';
import {
  acknowledgeCustomEndpoint,
  revokeCustomEndpointAcknowledgementsForUrl,
  requiresCustomEndpointConsent,
  requireCustomEndpointAcknowledgement,
} from './custom-endpoint-acknowledgement.js';

export interface ModelDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly engineClient?: JoyAgentEngineClient | undefined;
  readonly status?: ByokSessionStatus | undefined;
  readonly onStatusChange?: ((status: ByokSessionStatus | undefined) => void) | undefined;
  readonly onNotice?: ((message: string, kind: 'info' | 'success' | 'error') => void) | undefined;
}

type ProviderType = 'kilo' | 'openrouter' | 'openai-compatible' | 'custom';

const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  kilo: 'https://api.kilo.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': '',
  custom: '',
};

const COMMON_MODEL_PRESETS: Record<ProviderType, readonly string[]> = {
  kilo: ['minimax/minimax-m3', 'kilo-auto/efficient', 'kilo-auto/free'],
  openrouter: [
    'openrouter/free',
    'openrouter/auto',
    'minimax/minimax-m3',
    'anthropic/claude-3.5-sonnet',
  ],
  'openai-compatible': ['gpt-4o-mini', 'gpt-4o'],
  custom: [],
};

function publishConfigurationFailure(
  onStatusChange: ModelDrawerProps['onStatusChange'],
  profile: Pick<DesktopProviderProfile, 'provider' | 'modelId'>,
  error: unknown,
): void {
  const failed: ByokSessionStatus = {
    provider: profile.provider as JoyProviderMode,
    modelId: profile.modelId,
    capability: 'incompatible',
    message: error instanceof Error ? error.message : String(error),
  };
  onStatusChange?.(failed);
}

export function ModelDrawer({
  open,
  onClose,
  engineClient,
  status,
  onStatusChange,
  onNotice,
}: ModelDrawerProps) {
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [refreshingProfileId, setRefreshingProfileId] = useState<string | undefined>(undefined);

  // New Connection Form State
  const [newName, setNewName] = useState('');
  const [newProvider, setNewProvider] = useState<ProviderType>('kilo');
  const [newBaseUrl, setNewBaseUrl] = useState(PROVIDER_DEFAULT_URLS.kilo);
  const [newApiKey, setNewApiKey] = useState('');
  const [newSelectedModel, setNewSelectedModel] = useState('minimax/minimax-m3');
  const [discoveredModels, setDiscoveredModels] = useState<readonly string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [customAcknowledged, setCustomAcknowledged] = useState(false);
  const [pendingCustomProfile, setPendingCustomProfile] = useState<DesktopProviderProfile>();

  const acknowledge = (baseUrl: string, profileId?: string) => {
    acknowledgeCustomEndpoint({ provider: 'custom', baseUrl, profileId });
    setCustomAcknowledged(true);
    setPendingCustomProfile(undefined);
  };

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshProfiles = async () => {
    if (!isDesktopHost()) return;
    try {
      const list = await listDesktopProviderProfiles();
      if (mountedRef.current) {
        setProfiles(list);
      }
    } catch (err) {
      console.warn('Failed to list provider profiles:', err);
    }
  };

  useEffect(() => {
    if (open) {
      void refreshProfiles();
    }
  }, [open]);

  // Handle Escape key to close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handleProviderTypeChange = (type: ProviderType) => {
    setNewProvider(type);
    setCustomAcknowledged(false);
    setNewBaseUrl(PROVIDER_DEFAULT_URLS[type]);
    const presets = COMMON_MODEL_PRESETS[type];
    if (presets.length > 0 && presets[0] !== undefined) {
      setNewSelectedModel(presets[0]);
    }
    setDiscoveredModels([]);
    setDiscoveryError(null);
  };

  const handleDiscoverModels = async () => {
    if (
      requiresCustomEndpointConsent(newProvider, newBaseUrl) &&
      !requireCustomEndpointAcknowledgement({ provider: 'custom', baseUrl: newBaseUrl })
    ) {
      setDiscoveryError('Acknowledge this custom endpoint before discovering models.');
      return;
    }
    if (!newBaseUrl.trim()) {
      setDiscoveryError('Please provide a valid Base URL.');
      return;
    }
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const models = await fetchDesktopProviderModels({
        baseUrl: newBaseUrl.trim(),
        apiKey: newApiKey.trim() || undefined,
      });
      if (!mountedRef.current) return;
      const modelIds = models.map((m) => m.id);
      setDiscoveredModels(modelIds);
      if (
        modelIds.length > 0 &&
        modelIds[0] !== undefined &&
        !modelIds.includes(newSelectedModel)
      ) {
        setNewSelectedModel(modelIds[0]);
      }
      onNotice?.(`Discovered ${modelIds.length} models successfully!`, 'success');
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : String(err);
        setDiscoveryError(msg);
        onNotice?.(msg, 'error');
      }
    } finally {
      if (mountedRef.current) {
        setIsDiscovering(false);
      }
    }
  };

  const handleSaveAndConnect = async () => {
    if (
      requiresCustomEndpointConsent(newProvider, newBaseUrl) &&
      !requireCustomEndpointAcknowledgement({ provider: 'custom', baseUrl: newBaseUrl })
    ) {
      onNotice?.('Acknowledge this custom endpoint before connecting.', 'error');
      return;
    }
    if (!newBaseUrl.trim() || !newSelectedModel.trim()) {
      onNotice?.('Base URL and Model ID are required.', 'error');
      return;
    }
    setIsSaving(true);
    let configurationFailed = false;
    try {
      const profileName = newName.trim() || `${newProvider.toUpperCase()} (${newSelectedModel})`;
      const saved = await saveDesktopProviderProfile({
        name: profileName,
        provider: newProvider,
        baseUrl: newBaseUrl.trim(),
        modelId: newSelectedModel.trim(),
        apiKey: newApiKey.trim() || undefined,
        cachedModels: discoveredModels.length > 0 ? discoveredModels : [newSelectedModel.trim()],
      });

      if (engineClient) {
        configurationFailed = true;
        const nextStatus = await engineClient.configure({
          provider: newProvider,
          baseUrl: newBaseUrl.trim(),
          modelId: newSelectedModel.trim(),
          apiKey: newApiKey.trim(),
        });
        configurationFailed = false;
        onStatusChange?.(nextStatus);
      }

      onNotice?.(`Connected to ${saved.name ?? saved.modelId}`, 'success');
      setIsAddingNew(false);
      setNewApiKey('');
      await refreshProfiles();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (configurationFailed) {
        publishConfigurationFailure(
          onStatusChange,
          { provider: newProvider, modelId: newSelectedModel },
          err,
        );
      }
      onNotice?.(`Failed to save and connect: ${msg}`, 'error');
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  const handleSelectModel = async (profile: DesktopProviderProfile, modelId: string) => {
    if (
      requiresCustomEndpointConsent(profile.provider, profile.baseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: profile.baseUrl,
        profileId: profile.id,
      })
    ) {
      setPendingCustomProfile(profile);
      onNotice?.('Acknowledge this exact custom endpoint before connecting it.', 'error');
      return;
    }
    let configurationFailed = false;
    try {
      let apiKey = '';
      if (isDesktopHost()) {
        const session = (await beginDesktopProviderSession(profile.id)) as
          { apiKey?: string } | undefined;
        apiKey = session?.apiKey ?? '';
      }

      if (engineClient) {
        configurationFailed = true;
        const nextStatus = await engineClient.configure({
          provider: profile.provider as JoyProviderMode,
          baseUrl: profile.baseUrl,
          modelId,
          apiKey,
        });
        configurationFailed = false;
        onStatusChange?.(nextStatus);
      }

      if (profile.modelId !== modelId && isDesktopHost()) {
        await saveDesktopProviderProfile({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          modelId,
          cachedModels: profile.cachedModels,
        });
        await refreshProfiles();
      }

      onNotice?.(`Switched active model to ${modelId}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (configurationFailed) {
        publishConfigurationFailure(onStatusChange, { provider: profile.provider, modelId }, err);
      }
      onNotice?.(`Failed to switch model: ${msg}`, 'error');
    }
  };

  const handleRefreshProfileModels = async (profile: DesktopProviderProfile) => {
    if (
      requiresCustomEndpointConsent(profile.provider, profile.baseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: profile.baseUrl,
        profileId: profile.id,
      })
    ) {
      setPendingCustomProfile(profile);
      onNotice?.('Acknowledge this exact custom endpoint before discovering models.', 'error');
      return;
    }
    setRefreshingProfileId(profile.id);
    try {
      let apiKey = '';
      if (isDesktopHost()) {
        const session = (await beginDesktopProviderSession(profile.id)) as
          { apiKey?: string } | undefined;
        apiKey = session?.apiKey ?? '';
      }

      const models = await fetchDesktopProviderModels({
        id: profile.id,
        baseUrl: profile.baseUrl,
        apiKey: apiKey || undefined,
      });

      const modelIds = models.map((m) => m.id);
      if (modelIds.length > 0) {
        await saveDesktopProviderProfile({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          modelId: profile.modelId,
          cachedModels: modelIds,
        });
        await refreshProfiles();
        onNotice?.(
          `Updated ${modelIds.length} models for ${profile.name ?? profile.provider}`,
          'success',
        );
      } else {
        onNotice?.('No models returned from endpoint', 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onNotice?.(`Model refresh failed: ${msg}`, 'error');
    } finally {
      if (mountedRef.current) {
        setRefreshingProfileId(undefined);
      }
    }
  };

  const handleDeleteProfile = async (profile: DesktopProviderProfile) => {
    if (!window.confirm(`Delete provider connection "${profile.name || profile.provider}"?`)) {
      return;
    }
    try {
      await deleteDesktopProviderProfile(profile.id);
      onNotice?.(`Deleted provider ${profile.name || profile.provider}`, 'info');
      await refreshProfiles();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onNotice?.(`Failed to delete profile: ${msg}`, 'error');
    }
  };

  const query = searchQuery.trim().toLowerCase();

  const filteredProfiles = useMemo(() => {
    if (!query) return profiles;
    return profiles.filter((p) => {
      const nameMatch = (p.name ?? '').toLowerCase().includes(query);
      const providerMatch = p.provider.toLowerCase().includes(query);
      const modelMatch = p.modelId.toLowerCase().includes(query);
      const cachedMatch = (p.cachedModels ?? []).some((m) => m.toLowerCase().includes(query));
      return nameMatch || providerMatch || modelMatch || cachedMatch;
    });
  }, [profiles, query]);

  if (!open) return null;

  return (
    <div
      className="model-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Model Drawer & API Connections"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="model-drawer">
        <header className="model-drawer-header">
          <div className="model-drawer-title-group">
            <h2>
              <span>⚡ Model Drawer</span>
              <span className={`model-drawer-active-badge ${status ? '' : 'is-disconnected'}`}>
                {status ? `${status.provider}: ${status.modelId}` : 'Disconnected'}
              </span>
            </h2>
          </div>
          <button
            type="button"
            className="model-drawer-close-btn"
            aria-label="Close Model Drawer"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="model-drawer-body">
          {/* Search bar & Add Button */}
          <div className="model-drawer-search-row">
            <input
              type="text"
              className="model-drawer-search-input"
              placeholder="Search models or providers…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button
              type="button"
              className="model-drawer-add-btn"
              onClick={() => setIsAddingNew((prev) => !prev)}
            >
              <PlusIcon />
              <span>{isAddingNew ? 'Cancel' : 'Add API'}</span>
            </button>
          </div>

          {/* Add API Connection Form */}
          {isAddingNew && (
            <section className="model-drawer-add-card" aria-label="Add API Connection">
              <h3>+ Connect New API Endpoint</h3>

              <div className="model-drawer-form-row">
                <div className="model-drawer-form-group">
                  <label htmlFor="md-provider-type">Provider Type</label>
                  <select
                    id="md-provider-type"
                    value={newProvider}
                    onChange={(e) => handleProviderTypeChange(e.target.value as ProviderType)}
                  >
                    <option value="kilo">Kilo Gateway</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="openai-compatible">OpenAI-Compatible</option>
                    <option value="custom">Custom Endpoint (S3 / Proxy)</option>
                  </select>
                </div>
                <div className="model-drawer-form-group">
                  <label htmlFor="md-connection-name">Connection Name</label>
                  <input
                    id="md-connection-name"
                    type="text"
                    placeholder="e.g. My Kilo Gateway"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
              </div>

              <div className="model-drawer-form-group">
                <label htmlFor="md-base-url">API Base URL</label>
                <input
                  id="md-base-url"
                  type="text"
                  placeholder="https://api.kilo.ai/v1"
                  value={newBaseUrl}
                  onChange={(e) => {
                    setNewBaseUrl(e.target.value);
                    setCustomAcknowledged(false);
                  }}
                />
              </div>

              {requiresCustomEndpointConsent(newProvider, newBaseUrl) && (
                <label className="model-drawer-form-group">
                  <input
                    type="checkbox"
                    checked={customAcknowledged}
                    onChange={(event) => {
                      setCustomAcknowledged(event.target.checked);
                      if (event.target.checked) acknowledge(newBaseUrl);
                      else revokeCustomEndpointAcknowledgementsForUrl(newBaseUrl);
                    }}
                  />
                  I understand this custom endpoint may log requests and credentials.
                </label>
              )}
              <div className="model-drawer-form-group">
                <label htmlFor="md-api-key">API Key</label>
                <input
                  id="md-api-key"
                  type="password"
                  placeholder="Enter secret API key…"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                />
              </div>

              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <button
                  type="button"
                  className="model-drawer-btn-secondary"
                  disabled={isDiscovering || !newBaseUrl.trim()}
                  onClick={() => void handleDiscoverModels()}
                >
                  {isDiscovering ? 'Discovering Models…' : '🔍 Discover Models Behind Link'}
                </button>
                {discoveredModels.length > 0 && (
                  <span style={{ fontSize: '11px', color: '#10b981', fontWeight: 600 }}>
                    ✓ {discoveredModels.length} models loaded
                  </span>
                )}
              </div>

              {discoveryError && (
                <div style={{ fontSize: '11px', color: '#f87171' }}>{discoveryError}</div>
              )}

              {/* Discovered Models Chip Palette */}
              {discoveredModels.length > 0 && (
                <div className="model-drawer-discovered-box">
                  {discoveredModels.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`model-drawer-model-chip ${newSelectedModel === m ? 'is-selected' : ''}`}
                      onClick={() => setNewSelectedModel(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}

              <div className="model-drawer-form-group">
                <label htmlFor="md-selected-model">Selected Model ID</label>
                <input
                  id="md-selected-model"
                  type="text"
                  placeholder="e.g. minimax/minimax-m3, kilo-auto/efficient"
                  value={newSelectedModel}
                  onChange={(e) => setNewSelectedModel(e.target.value)}
                />
              </div>

              <div className="model-drawer-form-actions">
                <button
                  type="button"
                  className="model-drawer-btn-secondary"
                  onClick={() => setIsAddingNew(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="model-drawer-btn-primary"
                  disabled={isSaving || !newBaseUrl.trim() || !newSelectedModel.trim()}
                  onClick={() => void handleSaveAndConnect()}
                >
                  {isSaving ? 'Connecting…' : 'Save & Connect'}
                </button>
              </div>
            </section>
          )}

          {pendingCustomProfile && (
            <label className="model-drawer-form-group">
              <input
                type="checkbox"
                checked={false}
                onChange={(event) => {
                  if (event.target.checked)
                    acknowledge(pendingCustomProfile.baseUrl, pendingCustomProfile.id);
                }}
              />
              I acknowledge {pendingCustomProfile.name || pendingCustomProfile.baseUrl} for this
              session.
            </label>
          )}

          {/* Configured API Providers List */}
          <div className="model-drawer-section-title">Configured API Providers & Models</div>

          <div className="model-drawer-providers-list">
            {filteredProfiles.length === 0 && (
              <div className="model-drawer-empty-hint">
                {profiles.length === 0
                  ? 'No external API providers configured yet. Click "+ Add API" above to connect Kilo, OpenRouter, or custom endpoints.'
                  : 'No models or providers match your search filter.'}
              </div>
            )}

            {filteredProfiles.map((profile) => {
              const isActiveProvider =
                status?.provider === profile.provider &&
                (status?.modelId === profile.modelId ||
                  (profile.cachedModels ?? []).includes(status?.modelId ?? ''));

              const modelsToShow =
                profile.cachedModels && profile.cachedModels.length > 0
                  ? profile.cachedModels
                  : [profile.modelId];

              const filteredModels = query
                ? modelsToShow.filter((m) => m.toLowerCase().includes(query))
                : modelsToShow;

              return (
                <div
                  key={profile.id}
                  className={`model-drawer-provider-card ${isActiveProvider ? 'is-active' : ''}`}
                >
                  <div className="model-drawer-provider-header">
                    <div className="model-drawer-provider-info">
                      <strong>{profile.name || profile.provider}</strong>
                      <span className="model-drawer-provider-tag">{profile.provider}</span>
                    </div>
                    <div className="model-drawer-provider-actions">
                      <button
                        type="button"
                        className="model-drawer-provider-btn"
                        title="Query endpoint for available models"
                        disabled={refreshingProfileId === profile.id}
                        onClick={() => void handleRefreshProfileModels(profile)}
                      >
                        {refreshingProfileId === profile.id ? 'Refreshing…' : '↻ Refresh'}
                      </button>
                      <button
                        type="button"
                        className="model-drawer-provider-btn is-danger"
                        title="Delete this provider connection"
                        onClick={() => void handleDeleteProfile(profile)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="model-drawer-models-list">
                    {filteredModels.map((m) => {
                      const isThisActive =
                        status?.provider === profile.provider && status?.modelId === m;
                      return (
                        <div
                          key={m}
                          className={`model-drawer-model-item ${isThisActive ? 'is-selected' : ''}`}
                          onClick={() => void handleSelectModel(profile, m)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              void handleSelectModel(profile, m);
                            }
                          }}
                        >
                          <div className="model-drawer-model-left">
                            <span
                              style={{
                                color: isThisActive ? '#ffb020' : '#6b7280',
                                fontSize: '11px',
                              }}
                            >
                              {isThisActive ? '●' : '○'}
                            </span>
                            <span className="model-drawer-model-name" title={m}>
                              {m}
                            </span>
                          </div>
                          {isThisActive && (
                            <span className="model-drawer-model-status">
                              <CheckIcon /> Active
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
