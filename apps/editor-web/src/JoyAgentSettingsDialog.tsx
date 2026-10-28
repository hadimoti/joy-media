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
import { sessionProviderFor } from './joy-agent/provider-call.js';
import {
  evaluateEndpoint,
  findRegistryProvider,
  PROVIDER_REGISTRY,
  type ProviderRegionId,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import {
  isDesktopHost,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  deleteDesktopProviderProfile,
  fetchDesktopProviderModels,
  type DesktopProviderProfile,
} from './desktop-client.js';
import {
  acknowledgeCustomEndpoint,
  revokeCustomEndpointAcknowledgementsForUrl,
  assertCustomEndpointConsentHolds,
  isCustomEndpointProvider,
  normalizeProviderBaseUrl,
  requiresCustomEndpointConsent,
  requireCustomEndpointAcknowledgement,
} from './custom-endpoint-acknowledgement.js';
import './JoyAgentSettingsDialog.css';

export type JoyAgentSettingsTab =
  'models' | 'execution' | 'experience' | 'permissions' | 'diagnostics';

type AgentSettingsNotice = {
  readonly kind: 'info' | 'success' | 'error';
  readonly message: string;
};

type DesktopProviderProfileState = DesktopProviderProfile & {
  readonly state?: 'active' | 'disabled-legacy' | 'credential-unavailable';
  readonly decision?: 'later';
};

/** A saved profile cannot connect until the local provider broker ships (PLAN-v4 P2). */
/** The provider the dialog can connect: OpenRouter, a registry provider, or a custom endpoint. */
type DialogProvider = 'openrouter' | 'openai-compatible' | RegistryProviderId;

/** The engine runs every registry provider on the chat transport, so its status names that transport. */
function statusProviderFor(provider: DialogProvider): 'openrouter' | 'openai-compatible' {
  return provider === 'openrouter' ? 'openrouter' : 'openai-compatible';
}

/** A local endpoint with no key: the one case in which a profile is saved without a key (PLAN-v4 D8). */
function isKeylessLocalEndpoint(baseUrl: string): boolean {
  const verdict = evaluateEndpoint('openai-compatible', baseUrl);
  return verdict.allowed && verdict.kind === 'loopback';
}

/** The dialog provider a saved profile is listed under. A custom endpoint is the openai-compatible choice. */
function dialogProviderFor(profileProvider: string): DialogProvider | undefined {
  if (isCustomEndpointProvider(profileProvider)) return 'openai-compatible';
  if (profileProvider === 'openrouter') return 'openrouter';
  return findRegistryProvider(profileProvider) === undefined
    ? undefined
    : (profileProvider as RegistryProviderId);
}

/** A saved profile that is the connection the form describes: the same provider and endpoint. */
function profileDescribesForm(
  profile: DesktopProviderProfileState,
  provider: DialogProvider,
  normalizedBaseUrl: string,
): boolean {
  if (profile.state === 'disabled-legacy' || !profile.id) return false;
  const sameProvider =
    provider === 'openai-compatible'
      ? isCustomEndpointProvider(profile.provider)
      : profile.provider === provider;
  return sameProvider && normalizeProviderBaseUrl(profile.baseUrl) === normalizedBaseUrl;
}

/** A key belongs to one provider and endpoint. A key typed for another one is never sent there. */
function keyScopeFor(provider: DialogProvider, baseUrl: string): string {
  return `${provider}|${normalizeProviderBaseUrl(baseUrl)}`;
}

/** A saved profile's stored key may be used as it is: the key is confirmed for its endpoint and readable. */
function canUseStoredKey(profile: DesktopProviderProfileState | undefined): boolean {
  return (
    profile !== undefined && profile.bound === true && profile.state !== 'credential-unavailable'
  );
}

const MODES: Readonly<Record<AgentExecutionMode, string>> = {
  'suggest-only': 'Suggest only',
  'preview-and-approve': 'Preview and approve',
  'auto-apply-low-risk': 'Auto-apply low risk',
  'full-auto-limited': 'Full auto within limits',
};

const MODE_DESCRIPTIONS: Readonly<Record<AgentExecutionMode, string>> = {
  'suggest-only':
    'Joy Code suggests creative plans and edits in chat without touching the timeline.',
  'preview-and-approve':
    'Edits are previewed visually in the editor and require explicit approval before applying.',
  'auto-apply-low-risk':
    'Automatically executes non-destructive edits (cuts, trims, labeling) while gating large changes.',
  'full-auto-limited':
    'Autonomous multi-step execution within your configured cost and token budget limits.',
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
    description: 'Tune real-time visual ghost overlays and editor presence during agent runs.',
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
  onOpenModelDrawer,
  onClose,
  initialTab = 'models',
}: {
  readonly policy: AgentPolicyPreferences;
  readonly onPolicyChange: (next: AgentPolicyPreferences) => void;
  readonly engineClient: JoyAgentEngineClient;
  readonly status?: ByokSessionStatus;
  readonly onStatusChange?: (status: ByokSessionStatus | undefined) => void;
  readonly onNotice?: (message: string, kind: AgentSettingsNotice['kind']) => void;
  readonly onOpenModelDrawer?: () => void;
  readonly onClose: () => void;
  readonly initialTab?: JoyAgentSettingsTab;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  // The provider and endpoint in force when the key was typed. A key is never sent to another one.
  const keyScopeRef = useRef<string | undefined>(undefined);
  // The profile the user chose, kept across refreshes of the list.
  const selectedProfileIdRef = useRef<string | undefined>(undefined);
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

  const [provider, setProvider] = useState<DialogProvider>(
    status?.provider === 'openai-compatible' ? 'openai-compatible' : 'openrouter',
  );
  const [baseUrl, setBaseUrl] = useState(
    status?.provider === 'openai-compatible' ? '' : 'https://openrouter.ai/api/v1',
  );
  const [modelId, setModelId] = useState(status?.modelId || 'openrouter/auto');
  const [connectionName, setConnectionName] = useState('');
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();

  // Multi-profile state
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfileState[]>([]);
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfileState | undefined>(
    undefined,
  );
  // The saved profiles for the endpoint the form describes. The profile the user chose among them is the
  // one used. When several share the endpoint and none is chosen, the endpoint is ambiguous: nothing connects.
  const describingProfiles = profiles.filter((p) =>
    profileDescribesForm(p, provider, normalizeProviderBaseUrl(baseUrl)),
  );
  const chosenDescribingProfile = describingProfiles.find((p) => p.id === savedProfile?.id);
  const matchedProfile =
    chosenDescribingProfile ??
    (describingProfiles.length === 1 ? describingProfiles[0] : undefined);
  const endpointAmbiguous = describingProfiles.length > 1 && chosenDescribingProfile === undefined;
  // Whether any saved profile exists that the form does not describe. Named in the messages below.
  const hasOtherSavedProfiles = profiles.some(
    (p) => p.id !== undefined && p.state !== 'disabled-legacy',
  );
  const selectProfile = (profile: DesktopProviderProfileState | undefined) => {
    selectedProfileIdRef.current = profile?.id;
    setSavedProfile(profile);
  };
  const clearTypedKey = () => {
    if (keyRef.current) keyRef.current.value = '';
    keyScopeRef.current = undefined;
  };

  // Dynamic model discovery & Drawer state
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
      const list = (await listDesktopProviderProfiles()) as readonly DesktopProviderProfileState[];
      if (!mountedRef.current) return;
      setProfiles(list);
      // A profile the user chose stays chosen, and is refreshed from the list.
      const chosenId = selectedProfileIdRef.current;
      if (chosenId !== undefined) {
        const chosen = list.find((p) => p.id === chosenId);
        setSavedProfile(chosen);
        if (chosen === undefined) selectedProfileIdRef.current = undefined;
        return;
      }
      // Shown by default only when it is the one OpenRouter profile. With several on the same endpoint, the user
      // chooses one (the form refuses to connect until then), so no profile is picked for them.
      const openRouterProfiles = list.filter(
        (p) => p.provider === 'openrouter' && p.state !== 'disabled-legacy',
      );
      const openRouterProfile = openRouterProfiles.length === 1 ? openRouterProfiles[0] : undefined;
      if (openRouterProfile) {
        // Written out here, not through selectProfile, so this effect depends on stable setters only.
        selectedProfileIdRef.current = openRouterProfile.id;
        setSavedProfile(openRouterProfile);
        setModelId(openRouterProfile.modelId);
        setBaseUrl(openRouterProfile.baseUrl);
        setProvider('openrouter');
        setCustomDisclosure(false);
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

  const [region, setRegion] = useState<ProviderRegionId>('international');
  const handleProviderChange = (next: DialogProvider) => {
    clearTypedKey();
    setProvider(next);
    setRegion('international');
    setCustomDisclosure(false);
    setConnectionNotice(undefined);
    setDiscoveryError(null);
    if (next === 'openrouter') {
      setBaseUrl('https://openrouter.ai/api/v1');
      if (!modelId) setModelId('openrouter/auto');
    } else if (findRegistryProvider(next) !== undefined) {
      setBaseUrl(findRegistryProvider(next)?.regions[0]?.baseUrl ?? '');
    } else {
      setBaseUrl('');
    }
  };

  const discoverModels = async (explicitKey?: string) => {
    // Browser builds must never send the provider key from the page; the key
    // only reaches the provider through the Worker session or the desktop host.
    if (!isDesktopHost()) {
      setDiscoveryError('Live model discovery requires Joy Media Desktop.');
      return;
    }
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (endpointAmbiguous) {
      setDiscoveryError(
        'More than one saved profile uses this endpoint. Choose one in the list first.',
      );
      return;
    }
    const matchingSavedProfile = matchedProfile;
    if (
      requiresCustomEndpointConsent(provider, normalizedBaseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: normalizedBaseUrl,
        profileId: matchingSavedProfile?.id,
      })
    ) {
      setDiscoveryError('Enter the custom-provider acknowledgement before discovering models.');
      return;
    }
    const key = explicitKey ?? keyRef.current?.value ?? '';
    if (!normalizedBaseUrl) {
      setDiscoveryError('Please enter a Base URL before discovering models');
      return;
    }
    if (key && keyScopeRef.current !== keyScopeFor(provider, normalizedBaseUrl)) {
      clearTypedKey();
      setDiscoveryError(
        'The key was entered for a different provider or endpoint. Enter it again.',
      );
      return;
    }
    // Without a typed key, the saved profile for this endpoint lends its stored key, by its id. A profile
    // whose key is not confirmed for this endpoint asks for the key again first.
    if (!key && matchingSavedProfile !== undefined && !canUseStoredKey(matchingSavedProfile)) {
      setDiscoveryError('Enter the API key again to confirm this endpoint.');
      return;
    }
    const storedKeyProfileId =
      !key && canUseStoredKey(matchingSavedProfile) ? matchingSavedProfile?.id : undefined;
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const models = await fetchDesktopProviderModels({
        provider: provider === 'openai-compatible' ? 'custom' : provider,
        baseUrl: normalizedBaseUrl,
        ...(key ? { apiKey: key } : {}),
        ...(storedKeyProfileId === undefined ? {} : { id: storedKeyProfileId }),
      });
      if (!mountedRef.current) return;
      const modelIds = models.map((m) => m.id).filter(Boolean);
      setDiscoveredModels(modelIds);
      if (modelIds.length > 0) {
        // Auto-resolve and reveal the Model Drawer
        setOpenAccordions((prev) => ({ ...prev, 'models-drawer': true }));
        if (!modelIds.includes(modelId)) {
          const prefer =
            modelIds.find((m) => m.includes('auto') || m.includes('claude')) || modelIds[0];
          if (prefer) {
            setModelId(prefer);
          }
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setDiscoveryError(
        redactProviderError(
          err instanceof Error ? err.message : 'Failed to discover models behind endpoint',
          key,
        ),
      );
    } finally {
      if (mountedRef.current) setIsDiscovering(false);
    }
  };

  /** Shows a saved profile in the form: its endpoint, model and name, and the saved profile it stands for. */
  const showProfileInForm = (profile: DesktopProviderProfileState) => {
    const next = dialogProviderFor(profile.provider);
    selectProfile(profile);
    if (next !== undefined) {
      setProvider(next);
      const normalizedUrl = normalizeProviderBaseUrl(profile.baseUrl);
      setRegion(
        findRegistryProvider(next)?.regions.find(
          (item) => normalizeProviderBaseUrl(item.baseUrl) === normalizedUrl,
        )?.id ?? 'international',
      );
    }
    setBaseUrl(profile.baseUrl);
    setModelId(profile.modelId);
    setConnectionName(profile.name ?? '');
    clearTypedKey();
  };

  /** Shows a saved profile whose key must be entered again, so the key typed there confirms it. */
  const selectProfileIntoForm = (profile: DesktopProviderProfileState) => {
    showProfileInForm(profile);
    setCustomDisclosure(false);
    const message = 'Enter the API key again to confirm this endpoint, then connect.';
    setConnectionNotice({ kind: 'error', message });
    onNotice?.(message, 'error');
  };

  /** Connects a saved profile by its id. The key is never read here: the main process holds it. */
  const connectSavedProfile = async (profile: DesktopProviderProfileState) => {
    // A profile whose stored key cannot be used is shown in the form, so its key is entered again.
    if (!canUseStoredKey(profile)) {
      selectProfileIntoForm(profile);
      return;
    }
    if (working || engineClient === undefined || engineClient === null) return;
    const sessionProvider = sessionProviderFor(profile.provider);
    if (sessionProvider === undefined) return;
    // The form and the selection name the profile being connected, so both point at the same profile.
    showProfileInForm(profile);
    if (
      requiresCustomEndpointConsent(profile.provider, profile.baseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: profile.baseUrl,
        profileId: profile.id,
      })
    ) {
      setConnectionNotice({
        kind: 'error',
        message: 'Acknowledge this custom endpoint before connecting.',
      });
      return;
    }
    setWorking(true);
    setConnectionNotice(undefined);
    try {
      assertCustomEndpointConsentHolds(profile.provider, profile.baseUrl, profile.id);
      await engineClient.configure({
        provider: sessionProvider,
        baseUrl: profile.baseUrl,
        modelId: profile.modelId,
        profileId: profile.id,
      });
      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The connection failed.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      setWorking(false);
    }
  };

  const connect = async () => {
    if (working) return;
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (endpointAmbiguous) {
      const message =
        'More than one saved profile uses this endpoint. Choose one in the list first.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    const matchingSavedProfile = matchedProfile;
    if (
      requiresCustomEndpointConsent(provider, normalizedBaseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: normalizedBaseUrl,
        profileId: matchingSavedProfile?.id,
      })
    ) {
      const message = 'Enter the custom-provider acknowledgement before connecting.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    invalidateMediaProbe();
    setWorking(true);
    setConnectionNotice(undefined);
    setDiscoveryError(null);

    const key = keyRef.current?.value.trim() ?? '';
    if (key !== '' && keyScopeRef.current !== keyScopeFor(provider, normalizedBaseUrl)) {
      clearTypedKey();
      setWorking(false);
      const message = 'The key was entered for a different provider or endpoint. Enter it again.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    const keylessLocal = isKeylessLocalEndpoint(normalizedBaseUrl);
    const normalizedModelId = modelId.trim();
    const savedProfileMatches = matchingSavedProfile !== undefined;
    // The profile for this endpoint connects by its id, so its key stays in the main process. That needs
    // the key to be confirmed for this endpoint; otherwise the key is entered again.
    const reuseSavedProfile = !key && canUseStoredKey(matchingSavedProfile);
    // A new local model with no saved profile for this endpoint is saved with no key (PLAN-v4 D8).
    const keylessNew = keylessLocal && !savedProfileMatches;
    let profileId: string | undefined = reuseSavedProfile ? matchingSavedProfile?.id : undefined;

    if (provider === 'openai-compatible') {
      const missing: string[] = [];
      if (!key && !reuseSavedProfile && !keylessNew)
        missing.push(
          savedProfileMatches
            ? 'the API key again to confirm this endpoint'
            : hasOtherSavedProfiles
              ? 'a new API key because the saved key belongs to a different provider or endpoint'
              : 'an API key',
        );
      if (!normalizedModelId) missing.push('a model ID');
      if (!normalizedBaseUrl) missing.push('a base URL');
      if (
        requiresCustomEndpointConsent(provider, normalizedBaseUrl) &&
        !requireCustomEndpointAcknowledgement({
          provider: 'custom',
          baseUrl: normalizedBaseUrl,
          profileId: matchingSavedProfile?.id,
        })
      )
        missing.push('the custom-provider acknowledgement');
      if (missing.length > 0) {
        const message = `Enter ${missing.join(', ')} before connecting.`;
        setConnectionNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        setWorking(false);
        return;
      }
    }

    if (!key && !reuseSavedProfile && !keylessNew) {
      const message = savedProfileMatches
        ? 'Enter the API key again to confirm this endpoint.'
        : hasOtherSavedProfiles
          ? 'The saved API key belongs to a different provider or endpoint. Enter a new API key to connect.'
          : 'API key is required.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      setWorking(false);
      return;
    }

    if (!normalizedModelId) {
      setConnectionNotice({ kind: 'error', message: 'Model ID is required.' });
      onNotice?.('Model ID is required.', 'error');
      setWorking(false);
      return;
    }

    if (!normalizedBaseUrl) {
      setConnectionNotice({ kind: 'error', message: 'Base URL is required.' });
      onNotice?.('Base URL is required.', 'error');
      setWorking(false);
      return;
    }

    try {
      if (isDesktopHost() && (key || keylessNew)) {
        const saved = await saveDesktopProviderProfile({
          // A key typed for the saved endpoint updates that profile in place: one profile per connection.
          ...(key && matchingSavedProfile !== undefined ? { id: matchingSavedProfile.id } : {}),
          provider: provider === 'openai-compatible' ? 'custom' : provider,
          name: connectionName.trim() || undefined,
          baseUrl: normalizedBaseUrl,
          modelId: normalizedModelId,
          apiKey: key,
        });
        if (saved) {
          profileId = saved.id;
          selectProfile(saved);
          await loadProfiles();
        }
      }

      assertCustomEndpointConsentHolds(provider, normalizedBaseUrl, matchingSavedProfile?.id);
      const sessionProvider = sessionProviderFor(
        provider === 'openai-compatible' ? 'custom' : provider,
      );
      if (sessionProvider === undefined || profileId === undefined) {
        throw new Error('This connection could not be saved in the desktop app.');
      }
      await engineClient.configure({
        provider: sessionProvider,
        baseUrl: normalizedBaseUrl,
        modelId: normalizedModelId,
        profileId,
      });

      const next = await engineClient.testConnection();
      const safeStatus =
        next.capability === 'incompatible'
          ? {
              ...next,
              message: redactProviderError(
                next.message ?? 'The provider responded, but JOY could not use its tool loop.',
                key,
              ),
            }
          : next;
      setConnectionStatus(safeStatus);
      onStatusChange?.(safeStatus);

      const message =
        next.capability === 'tool-loop'
          ? 'Connected successfully. JOY is ready to edit in this session.'
          : next.capability === 'plan-only'
            ? 'Connected successfully in plan-only mode. Creative Brief is ready in this session.'
            : `Connection failed: ${safeStatus.message}`;
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to configure connection';
      const safeMessage = redactProviderError(rawMessage, key);
      const message = `Connection failed: ${safeMessage}`;
      setConnectionStatus({
        provider: statusProviderFor(provider),
        modelId: normalizedModelId,
        capability: 'incompatible',
        message: safeMessage,
      });
      onStatusChange?.({
        provider: statusProviderFor(provider),
        modelId: normalizedModelId,
        capability: 'incompatible',
        message: safeMessage,
      });
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      clearTypedKey();
      setWorking(false);
    }
  };

  const deferLegacyProfile = async (prof: DesktopProviderProfileState) => {
    if (!isDesktopHost() || prof.state !== 'disabled-legacy' || prof.decision === 'later') return;
    try {
      await window.joyDesktop?.invoke('desktop.provider-profile.later', { id: prof.id });
      await loadProfiles();
    } catch (error) {
      console.warn('Failed to defer legacy provider profile:', error);
    }
  };

  const removeProfile = async (profId: string) => {
    if (!isDesktopHost()) return;
    try {
      await deleteDesktopProviderProfile(profId);
      await loadProfiles();
      if (savedProfile?.id === profId) selectProfile(undefined);
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
    clearTypedKey();
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
                      : 'Not connected'}
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
                {onOpenModelDrawer && (
                  <button
                    className="joy-btn-secondary"
                    onClick={onOpenModelDrawer}
                    aria-label="Browse models & API connections"
                  >
                    Browse models &amp; API connections
                  </button>
                )}
                {/* Studio Presets Picker */}
                <div className="joy-studio-preset-bar">
                  <button type="button" className="joy-preset-tab is-active">
                    <span className="joy-preset-icon">🛠️</span>
                    <div className="joy-preset-text">
                      <strong>Custom BYOK</strong>
                      <span>One API-key provider (OpenRouter or a custom endpoint)</span>
                    </div>
                  </button>
                </div>

                {/* Active Connection Banner */}
                <div className="joy-settings-active-banner">
                  <div className="joy-settings-active-info">
                    <div className="joy-settings-active-icon">⚡</div>
                    <div className="joy-settings-active-details">
                      <strong>
                        {connectionStatus?.modelId
                          ? `Active: ${connectionStatus.modelId}`
                          : 'No Active Model Connected'}
                      </strong>
                      <span role="status">
                        {connectionStatus?.capability === 'tool-loop'
                          ? 'Tool loop ready · High capabilities'
                          : connectionStatus?.capability === 'plan-only'
                            ? 'Plan-only ready · Creative brief available'
                            : connectionStatus?.capability === 'incompatible'
                              ? 'Connection failed. See the details below.'
                              : 'Configure an API endpoint below to connect JOY Code.'}
                      </span>
                    </div>
                  </div>
                  {connectionStatus?.modelId && (
                    <button type="button" className="joy-btn-secondary joy-btn-sm" onClick={clear}>
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
                      {profiles.map((prof) => {
                        const disabledLegacy = prof.state === 'disabled-legacy';
                        return (
                          <div
                            key={prof.id}
                            data-profile-state={prof.state ?? 'active'}
                            className={`joy-settings-provider-card ${savedProfile?.id === prof.id ? 'is-active' : ''} ${disabledLegacy ? 'is-disabled-legacy' : ''}`}
                          >
                            <div className="joy-settings-provider-meta">
                              <strong>{prof.name || prof.provider}</strong>
                              <span>{displayModelId(prof.modelId)}</span>
                              {disabledLegacy && (
                                <span className="joy-settings-legacy-status">
                                  Disabled legacy profile
                                </span>
                              )}
                              {prof.state === 'credential-unavailable' && (
                                <span className="joy-settings-legacy-status">
                                  Saved key could not be read. Enter it again.
                                </span>
                              )}
                              {prof.bound === false &&
                                !disabledLegacy &&
                                prof.state !== 'credential-unavailable' && (
                                  <span className="joy-settings-legacy-status">
                                    Enter the key again to confirm this endpoint.
                                  </span>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              {disabledLegacy ? (
                                <button
                                  type="button"
                                  className="joy-btn-secondary joy-btn-sm"
                                  onClick={() => void deferLegacyProfile(prof)}
                                  disabled={working || prof.decision === 'later'}
                                >
                                  Later
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="joy-btn-secondary joy-btn-sm"
                                    disabled={working}
                                    onClick={() => void connectSavedProfile(prof)}
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
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
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
                        {provider === 'openrouter' ? 'OpenRouter' : 'Custom Endpoint'}
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
                                handleProviderChange(e.target.value as DialogProvider)
                              }
                            >
                              <option value="openrouter">OpenRouter (BYOK)</option>
                              {PROVIDER_REGISTRY.filter((item) => item.id !== 'openrouter').map(
                                (item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.label}
                                  </option>
                                ),
                              )}
                              <option value="openai-compatible">
                                Custom S3 / OpenAI Compatible
                              </option>
                            </select>
                          </label>
                          {(findRegistryProvider(provider)?.regions.length ?? 0) > 1 && (
                            <label>
                              <span>Region</span>
                              <select
                                value={region}
                                onChange={(e) => {
                                  const next = findRegistryProvider(provider)?.regions.find(
                                    (item) => item.id === e.target.value,
                                  );
                                  if (next === undefined) return;
                                  clearTypedKey();
                                  setRegion(next.id);
                                  setBaseUrl(next.baseUrl);
                                }}
                              >
                                {findRegistryProvider(provider)?.regions.map((item) => (
                                  <option key={item.id} value={item.id}>
                                    {item.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          {findRegistryProvider(provider) !== undefined && (
                            <small>
                              Get a key at{' '}
                              {findRegistryProvider(provider)?.regions.find(
                                (item) => item.id === region,
                              )?.keyUrl ?? ''}
                            </small>
                          )}
                        </div>

                        <div className="joy-settings-field">
                          <label>
                            <span>Connection Profile Name (Optional)</span>
                            <input
                              type="text"
                              placeholder="e.g. My OpenRouter, Local Ollama"
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
                              onChange={(e) => {
                                setBaseUrl(e.target.value);
                                setCustomDisclosure(false);
                              }}
                            />
                          </label>
                        </div>

                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <span>API Secret Key</span>
                            <input
                              ref={keyRef}
                              type="password"
                              placeholder={
                                canUseStoredKey(matchedProfile)
                                  ? '•••••••••••••••• (Leave blank to keep saved)'
                                  : 'sk-...'
                              }
                              defaultValue=""
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) => {
                                // The scope is the endpoint in force when the key was started. Later edits keep
                                // it, so an endpoint edited in between cannot take the key over. An empty field
                                // starts afresh.
                                if (event.target.value === '') keyScopeRef.current = undefined;
                                else if (keyScopeRef.current === undefined)
                                  keyScopeRef.current = keyScopeFor(provider, baseUrl);
                              }}
                            />
                          </label>
                          {matchedProfile !== undefined &&
                            matchedProfile.state !== 'credential-unavailable' && (
                              <span
                                style={{ fontSize: '11px', color: '#10b981', marginTop: '2px' }}
                              >
                                (Saved in desktop vault)
                              </span>
                            )}
                          <span style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                            🔒 Keys are encrypted via Windows DPAPI and never logged or proxied.
                          </span>
                        </div>

                        {requiresCustomEndpointConsent(provider, baseUrl) && (
                          <div className="joy-settings-field-full joy-settings-field">
                            <label
                              className="agent-toggle"
                              style={{ fontSize: '12px', color: '#aaa' }}
                            >
                              <input
                                type="checkbox"
                                checked={customDisclosure}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setCustomDisclosure(checked);
                                  if (!checked) {
                                    // Unchecking withdraws consent for this URL, including any
                                    // saved-profile-bound acknowledgement.
                                    revokeCustomEndpointAcknowledgementsForUrl(baseUrl);
                                    // Withdrawn consent must also stop an already configured
                                    // connection from being used.
                                    if (connectionStatus) clear();
                                  }
                                  if (checked) {
                                    const normalized = normalizeProviderBaseUrl(baseUrl);
                                    // The acknowledgement belongs to the saved profile the form chose, not to
                                    // another profile that happens to share this endpoint.
                                    acknowledgeCustomEndpoint({
                                      provider: 'custom',
                                      baseUrl: normalized,
                                      profileId: matchedProfile?.id,
                                    });
                                  }
                                }}
                                disabled={working || mediaProbeWorking}
                              />
                              I understand that custom endpoints may log requests according to their
                              own policy.
                            </label>
                          </div>
                        )}

                        {/* Model ID Text Input with Model Drawer Trigger */}
                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <span>Model ID (User Editable)</span>
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
                            </div>
                            <div className="joy-settings-input-with-action">
                              <input
                                type="text"
                                aria-label="Model ID"
                                placeholder="provider/model"
                                value={modelId}
                                onChange={(e) => setModelId(e.target.value)}
                              />
                              <button
                                type="button"
                                className="joy-btn-secondary"
                                onClick={() => void discoverModels()}
                                disabled={isDiscovering || working}
                                title="Discover models behind API endpoint"
                              >
                                {isDiscovering ? '🔍 Scanning…' : '🔍 Discover Models'}
                              </button>
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
                            role={connectionNotice.kind === 'error' ? 'alert' : 'status'}
                          >
                            {connectionNotice.message}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* ACCORDION 2: Discovered Models Palette / Selection Drawer */}
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
                          Select a discovered model chip to populate the Model ID, or filter by
                          keyword:
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
                        <div
                          className="joy-settings-notice is-error"
                          style={{ marginBottom: '10px' }}
                        >
                          {discoveryError}
                        </div>
                      )}

                      <div className="joy-model-drawer-search">
                        <input
                          type="text"
                          placeholder="Filter models (e.g. free, sonnet, 4o)..."
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
                      <p
                        style={{
                          margin: '0 0 12px',
                          fontSize: '12px',
                          color: '#999',
                          lineHeight: 1.4,
                        }}
                      >
                        Runs three tiny product-owned synthetic samples to verify multimodal image,
                        audio, and video understanding. This check never sends your project, owner,
                        or uploaded media to the provider, but your provider may charge or log these
                        requests under its standard usage terms.
                      </p>

                      <div
                        style={{
                          display: 'flex',
                          gap: '10px',
                          alignItems: 'center',
                          marginBottom: '12px',
                        }}
                      >
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
                          <p
                            style={{
                              margin: '0 0 8px',
                              fontSize: '12px',
                              color: '#ccc',
                              fontWeight: 600,
                            }}
                          >
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
                            <div className="joy-settings-mode-card-desc">
                              {MODE_DESCRIPTIONS[mode]}
                            </div>
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
                      <span className="joy-accordion-tag">
                        Max ${policy.maxCostPerRunUsd.toFixed(2)}/run
                      </span>
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
                          <span>
                            Show real-time previews on the monitor canvas during agent operations
                          </span>
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
                                    : policy.allowedCapabilities.filter(
                                        (c: ToolCapability) => c !== cap,
                                      );
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
                          <span style={{ color: '#ffb020', fontWeight: 600 }}>
                            NVIDIA GeForce RTX 5070 Ti
                          </span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Rendering Backend</span>
                          <span className="joy-settings-diagnostic-status is-supported">
                            ANGLE D3D11
                          </span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Local Asset Library</span>
                          <span style={{ color: '#ccc' }}>See Asset Library settings</span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>Local Worker SEA</span>
                          <span className="joy-settings-diagnostic-status is-supported">
                            joy-worker.exe
                          </span>
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
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '10px',
                        }}
                      >
                        <span style={{ fontSize: '12px', color: '#999' }}>
                          Tests whether the active reasoning model parses image, audio, and video
                          inputs.
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
                          <p
                            style={{
                              margin: '0 0 8px',
                              fontSize: '12px',
                              color: '#ccc',
                              fontWeight: 600,
                            }}
                          >
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
            <span>
              🔒 Policy saved locally in browser. Sensitive keys secured in Windows DPAPI vault.
            </span>
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

function redactProviderError(raw: string, key: string): string {
  const safeMessage = key ? raw.replaceAll(key, '[redacted]') : raw;
  return safeMessage.slice(0, 180);
}
