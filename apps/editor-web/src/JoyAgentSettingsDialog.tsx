import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';
import { ALL_TOOL_CAPABILITIES } from '@joy-media/agent-tools';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type {
  ByokSessionStatus,
  JoyAgentMediaCapabilityReport,
  JoyAgentMediaCapabilityState,
} from './joy-agent/protocol.js';
import {
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CoinIcon,
  EyeIcon,
  FlaskIcon,
  LockIcon,
  PaletteIcon,
  PlugIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  ToolsIcon,
  WrenchIcon,
} from './icons.js';
import { confirmDialog } from './app-dialogs.js';
import { AgentSlotsSection } from './AgentSlotsSection.js';
import type { DesktopAgentSlot } from './desktop-client.js';
import { profileLabel } from './provider-labels.js';
import { sessionProviderFor } from './joy-agent/provider-call.js';
import {
  evaluateEndpoint,
  findRegistryProvider,
  PROVIDER_REGISTRY,
  signInProviders,
  type ProviderRegionId,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import {
  isDesktopHost,
  saveDesktopProviderProfile,
  listDesktopProviderProfiles,
  deleteDesktopProviderProfile,
  signInDesktopProviderProfile,
  signOutDesktopProviderProfile,
  fetchDesktopProviderModels,
  type DesktopProviderProfile,
} from './desktop-client.js';
import {
  acknowledgeCustomEndpoint,
  revokeCustomEndpointAcknowledgementsForUrl,
  assertCustomEndpointConsentHolds,
  isCustomEndpointAcknowledged,
  isCustomEndpointProvider,
  normalizeProviderBaseUrl,
  requiresCustomEndpointConsent,
  requireCustomEndpointAcknowledgement,
} from './custom-endpoint-acknowledgement.js';
import { ProviderSignInPanel } from './ProviderSignInPanel.js';
import {
  allowedToolsTag,
  budgetTag,
  connectionFailedMessage,
  mediaCheckComplete,
  missingItemsMessage,
  modelsReadyTag,
  removeProfileLabel,
  SETTINGS_BUDGET,
  SETTINGS_DIALOG,
  SETTINGS_DIAGNOSTICS,
  SETTINGS_LIVE_PREVIEW,
  SETTINGS_MEDIA_CHECK,
  SETTINGS_MESSAGES,
  SETTINGS_MODELS,
  SETTINGS_MODES,
  SETTINGS_PAGES,
  SETTINGS_STORAGE,
  SETTINGS_TOOLS,
  type SettingsPageId,
} from './settings-wording.js';
import './JoyAgentSettingsDialog.css';

export type JoyAgentSettingsTab = SettingsPageId;

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

const SIGN_IN_PROVIDER_IDS = new Set(signInProviders());

/** The engine runs every registry provider on the chat transport, so its status names that transport. */
function statusProviderFor(provider: DialogProvider): 'openrouter' | 'openai-compatible' {
  return provider === 'openrouter' ? 'openrouter' : 'openai-compatible';
}

/**
 * The provider a connected session keeps in the form. A session runs on OpenRouter or the openai-compatible
 * transport, and a custom endpoint is the openai-compatible choice. Any other status names no provider here,
 * so OpenRouter is never shown for it.
 */
function formProviderForStatus(status: ByokSessionStatus | undefined): DialogProvider | '' {
  if (status?.provider === 'openrouter') return 'openrouter';
  if (status !== undefined && isCustomEndpointProvider(status.provider)) return 'openai-compatible';
  return '';
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
  provider: DialogProvider | '',
  normalizedBaseUrl: string,
): boolean {
  if (profile.state === 'disabled-legacy' || !profile.id) return false;
  // No provider is chosen, so the form describes no saved profile.
  if (provider === '') return false;
  const sameProvider =
    provider === 'openai-compatible'
      ? isCustomEndpointProvider(profile.provider)
      : profile.provider === provider;
  return sameProvider && normalizeProviderBaseUrl(profile.baseUrl) === normalizedBaseUrl;
}

/** A key belongs to one provider and endpoint. A key typed for another one is never sent there. */
function keyScopeFor(provider: DialogProvider | '', baseUrl: string): string {
  return `${provider}|${normalizeProviderBaseUrl(baseUrl)}`;
}

/** How long the saved-profile list may take. A read that is still pending after this is treated as unreadable. */
const PROFILE_LIST_TIMEOUT_MS = 15_000;

/** Rejects when the promise has not settled in time, so a read that never returns cannot leave the dialog waiting. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(SETTINGS_MESSAGES.profilesDidNotLoad)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A saved profile's stored key may be used as it is: the key is confirmed for its endpoint and readable. */
function canUseStoredKey(profile: DesktopProviderProfileState | undefined): boolean {
  return (
    profile !== undefined && profile.bound === true && profile.state !== 'credential-unavailable'
  );
}

const TAB_CONFIG: {
  readonly id: JoyAgentSettingsTab;
  readonly label: string;
  readonly icon: ReactNode;
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    id: 'models',
    label: SETTINGS_PAGES.models.name,
    icon: <BoltIcon />,
    kicker: SETTINGS_PAGES.models.kicker,
    title: SETTINGS_PAGES.models.title,
    description: SETTINGS_PAGES.models.description,
  },
  {
    id: 'execution',
    label: SETTINGS_PAGES.execution.name,
    icon: <ShieldIcon />,
    kicker: SETTINGS_PAGES.execution.kicker,
    title: SETTINGS_PAGES.execution.title,
    description: SETTINGS_PAGES.execution.description,
  },
  {
    id: 'experience',
    label: SETTINGS_PAGES.experience.name,
    icon: <EyeIcon />,
    kicker: SETTINGS_PAGES.experience.kicker,
    title: SETTINGS_PAGES.experience.title,
    description: SETTINGS_PAGES.experience.description,
  },
  {
    id: 'permissions',
    label: SETTINGS_PAGES.permissions.name,
    icon: <WrenchIcon />,
    kicker: SETTINGS_PAGES.permissions.kicker,
    title: SETTINGS_PAGES.permissions.title,
    description: SETTINGS_PAGES.permissions.description,
  },
  {
    id: 'diagnostics',
    label: SETTINGS_PAGES.diagnostics.name,
    icon: <FlaskIcon />,
    kicker: SETTINGS_PAGES.diagnostics.kicker,
    title: SETTINGS_PAGES.diagnostics.title,
    description: SETTINGS_PAGES.diagnostics.description,
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
  // The number of the latest read of the saved profiles. Only that read may change the list, the selection or readiness.
  const profileReadRef = useRef(0);

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

  /** Runs the agent in one slot: the session takes the slot's profile and model, and the slot's instructions. */
  const useAgentSlot = async (
    slot: DesktopAgentSlot,
    profile: DesktopProviderProfile,
  ): Promise<void> => {
    const sessionProvider = sessionProviderFor(profile.provider);
    if (sessionProvider === undefined || slot.model === null) {
      throw new Error(SETTINGS_MESSAGES.slotNotReady);
    }
    assertCustomEndpointConsentHolds(profile.provider, profile.baseUrl, profile.id);
    setWorking(true);
    setConnectionNotice(undefined);
    try {
      await engineClient.configure({
        provider: sessionProvider,
        baseUrl: profile.baseUrl,
        modelId: slot.model,
        profileId: profile.id,
        slot: slot.id,
      });
      const next = await engineClient.testConnection();
      setConnectionStatus(next);
      onStatusChange?.(next);
    } finally {
      setWorking(false);
    }
  };

  const toggleAccordion = (id: string) => {
    setOpenAccordions((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // No provider is preselected, and OpenRouter is never a default (PLAN-v4 §6d-1 rule 3). A new connection
  // starts with nothing chosen. A connected session shows the transport its status names: OpenRouter, or a custom
  // endpoint. A connected registry provider reports the openai-compatible transport, so it shows as a custom endpoint.
  // Any other status shows no provider and no OpenRouter default.
  const connectedProvider = formProviderForStatus(status);
  const [provider, setProvider] = useState<DialogProvider | ''>(connectedProvider);
  const [baseUrl, setBaseUrl] = useState(
    connectedProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : '',
  );
  const [modelId, setModelId] = useState(
    status === undefined
      ? ''
      : status.modelId || (connectedProvider === 'openrouter' ? 'openrouter/auto' : ''),
  );
  const [connectionName, setConnectionName] = useState('');
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [profileActionId, setProfileActionId] = useState<string | undefined>();
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();

  // Multi-profile state
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfileState[]>([]);
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfileState | undefined>(
    undefined,
  );
  // The saved profiles are read when the dialog opens. Until they are read, the form cannot tell which saved
  // profile its endpoint belongs to, so connect and discovery wait for the read, and refuse when it fails.
  const [profilesReady, setProfilesReady] = useState(() => !isDesktopHost());
  const [profilesUnreadable, setProfilesUnreadable] = useState(false);
  // The saved profiles for the endpoint the form describes. The profile the user chose among them is the
  // one used. When several share the endpoint and none is chosen, the endpoint is ambiguous: nothing connects.
  const describingProfiles = profiles.filter((p) =>
    profileDescribesForm(p, provider, normalizeProviderBaseUrl(baseUrl)),
  );
  const chosenDescribingProfile = describingProfiles.find((p) => p.id === savedProfile?.id);
  // Once a profile is chosen, only that profile can match. Editing the endpoint away from it leaves the form
  // matching nothing, so a key typed there saves a new profile rather than updating another saved one.
  const matchedProfile =
    savedProfile === undefined && describingProfiles.length === 1
      ? describingProfiles[0]
      : chosenDescribingProfile;
  const endpointAmbiguous = describingProfiles.length > 1 && chosenDescribingProfile === undefined;
  const profilesNotReadyMessage = profilesUnreadable
    ? SETTINGS_MESSAGES.profilesUnreadable
    : SETTINGS_MESSAGES.profilesLoading;
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

  /**
   * Reads the saved profiles. Resolves to the list when this read is the latest and has succeeded, and to undefined
   * otherwise.
   */
  const loadProfiles = async (): Promise<readonly DesktopProviderProfileState[] | undefined> => {
    if (!isDesktopHost()) return [];
    // A read that started earlier and finishes later must not put back a list that is out of date.
    const read = ++profileReadRef.current;
    // Each read starts from unknown: no saved profile is used until this read has succeeded.
    setProfilesReady(false);
    try {
      const list = (await withTimeout(
        listDesktopProviderProfiles(),
        PROFILE_LIST_TIMEOUT_MS,
      )) as readonly DesktopProviderProfileState[];
      if (!mountedRef.current || read !== profileReadRef.current) return undefined;
      setProfiles(list);
      setProfilesReady(true);
      setProfilesUnreadable(false);
      // A profile the user chose stays chosen, and is refreshed from the list.
      const chosenId = selectedProfileIdRef.current;
      if (chosenId !== undefined) {
        const chosen = list.find((p) => p.id === chosenId);
        setSavedProfile(chosen);
        if (chosen === undefined) {
          // However the chosen profile left the list, the form that described it is cleared too. Only refs and setters
          // are used here, so this function depends on stable values only.
          selectedProfileIdRef.current = undefined;
          if (keyRef.current) keyRef.current.value = '';
          keyScopeRef.current = undefined;
          setBaseUrl('');
          setModelId('');
          setConnectionName('');
        }
        return list;
      }
      // No profile is picked by default, OpenRouter included (PLAN-v4 §6d-1 rule 3). The user chooses one.
      return list;
    } catch {
      // A failed read that is no longer the latest says nothing about the list the user now sees.
      if (read === profileReadRef.current) setProfilesUnreadable(true);
      return undefined;
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
      setDiscoveryError(SETTINGS_MODELS.browserOnly);
      return;
    }
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (!profilesReady) {
      setDiscoveryError(profilesNotReadyMessage);
      return;
    }
    // No provider is preselected, so there is nothing to discover until the owner chooses one.
    if (provider === '') {
      setDiscoveryError(SETTINGS_MESSAGES.chooseProviderBeforeDiscovery);
      return;
    }
    if (endpointAmbiguous) {
      setDiscoveryError(SETTINGS_MESSAGES.ambiguousEndpoint);
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
      setDiscoveryError(SETTINGS_MESSAGES.consentBeforeDiscovery);
      return;
    }
    const key = explicitKey ?? keyRef.current?.value ?? '';
    if (!normalizedBaseUrl) {
      setDiscoveryError(SETTINGS_MESSAGES.baseUrlBeforeDiscovery);
      return;
    }
    if (key && keyScopeRef.current !== keyScopeFor(provider, normalizedBaseUrl)) {
      clearTypedKey();
      setDiscoveryError(SETTINGS_MESSAGES.keyForOtherEndpoint);
      return;
    }
    // Without a typed key, the saved profile for this endpoint lends its stored key, by its id. A profile
    // whose key is not confirmed for this endpoint asks for the key again first.
    if (!key && matchingSavedProfile !== undefined && !canUseStoredKey(matchingSavedProfile)) {
      setDiscoveryError(SETTINGS_MESSAGES.keyAgain);
      return;
    }
    const storedKeyProfileId =
      !key && canUseStoredKey(matchingSavedProfile) ? matchingSavedProfile?.id : undefined;
    setIsDiscovering(true);
    setDiscoveryError(null);
    try {
      const models = await fetchDesktopProviderModels({
        ...(requiresCustomEndpointConsent(provider, normalizedBaseUrl)
          ? {
              acknowledgedPublicEndpoint: isCustomEndpointAcknowledged({
                provider: 'custom',
                baseUrl: normalizedBaseUrl,
                profileId: storedKeyProfileId,
              }),
            }
          : {}),
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
          err instanceof Error ? err.message : SETTINGS_MESSAGES.discoveryFailed,
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
    const message = SETTINGS_MESSAGES.keyAgainThenConnect;
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
    // A saved profile is used only once the saved-profile list is known, as connect and discovery require.
    if (!profilesReady) {
      setConnectionNotice({ kind: 'error', message: profilesNotReadyMessage });
      onNotice?.(profilesNotReadyMessage, 'error');
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
        message: SETTINGS_MESSAGES.acknowledgeEndpoint,
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
      const message = err instanceof Error ? err.message : SETTINGS_MESSAGES.connectionFailed;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      setWorking(false);
    }
  };

  const connect = async () => {
    if (working) return;
    const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl);
    if (!profilesReady) {
      setConnectionNotice({ kind: 'error', message: profilesNotReadyMessage });
      onNotice?.(profilesNotReadyMessage, 'error');
      return;
    }
    if (endpointAmbiguous) {
      const message = SETTINGS_MESSAGES.ambiguousEndpoint;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    // No provider is preselected, so there is nothing to connect until the owner chooses one. This is
    // checked after the saved-profile refusals, so their message is the one the owner sees.
    if (provider === '') {
      const message = SETTINGS_MESSAGES.chooseProviderBeforeConnect;
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
      const message = SETTINGS_MESSAGES.consentBeforeConnect;
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
      const message = SETTINGS_MESSAGES.keyForOtherEndpoint;
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
            ? SETTINGS_MESSAGES.missingKeyAgain
            : hasOtherSavedProfiles
              ? SETTINGS_MESSAGES.missingNewKey
              : SETTINGS_MESSAGES.missingAnyKey,
        );
      if (!normalizedModelId) missing.push(SETTINGS_MESSAGES.missingModelId);
      if (!normalizedBaseUrl) missing.push(SETTINGS_MESSAGES.missingBaseUrl);
      if (
        requiresCustomEndpointConsent(provider, normalizedBaseUrl) &&
        !requireCustomEndpointAcknowledgement({
          provider: 'custom',
          baseUrl: normalizedBaseUrl,
          profileId: matchingSavedProfile?.id,
        })
      )
        missing.push(SETTINGS_MESSAGES.missingConsent);
      if (missing.length > 0) {
        const message = missingItemsMessage(missing.join(', '));
        setConnectionNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        setWorking(false);
        return;
      }
    }

    if (!key && !reuseSavedProfile && !keylessNew) {
      const message = savedProfileMatches
        ? SETTINGS_MESSAGES.keyAgain
        : hasOtherSavedProfiles
          ? SETTINGS_MESSAGES.savedKeyOtherEndpoint
          : SETTINGS_MESSAGES.apiKeyRequired;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      setWorking(false);
      return;
    }

    if (!normalizedModelId) {
      setConnectionNotice({ kind: 'error', message: SETTINGS_MESSAGES.modelIdRequired });
      onNotice?.(SETTINGS_MESSAGES.modelIdRequired, 'error');
      setWorking(false);
      return;
    }

    if (!normalizedBaseUrl) {
      setConnectionNotice({ kind: 'error', message: SETTINGS_MESSAGES.baseUrlRequired });
      onNotice?.(SETTINGS_MESSAGES.baseUrlRequired, 'error');
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
          ...(requiresCustomEndpointConsent(provider, normalizedBaseUrl)
            ? {
                // The owner's acknowledgement of this public custom endpoint (S8).
                acknowledgedPublicEndpoint: isCustomEndpointAcknowledged({
                  provider: 'custom',
                  baseUrl: normalizedBaseUrl,
                  profileId: matchingSavedProfile?.id,
                }),
              }
            : {}),
          apiKey: key,
        });
        if (saved) {
          profileId = saved.id;
          selectProfile(saved);
          // The connection waits for a list that shows the saved profile as it was saved: bound when a key was typed, at
          // the endpoint that was saved. Otherwise nothing connects.
          const readBack = await loadProfiles();
          const listed = readBack?.find((profile) => profile.id === saved.id);
          if (
            listed === undefined ||
            (key !== '' && listed.bound !== true) ||
            normalizeProviderBaseUrl(listed.baseUrl) !== normalizedBaseUrl
          ) {
            throw new Error(SETTINGS_MESSAGES.profileNotReadBack);
          }
        }
      }

      assertCustomEndpointConsentHolds(provider, normalizedBaseUrl, matchingSavedProfile?.id);
      const sessionProvider = sessionProviderFor(
        provider === 'openai-compatible' ? 'custom' : provider,
      );
      if (sessionProvider === undefined || profileId === undefined) {
        throw new Error(SETTINGS_MESSAGES.connectionNotSaved);
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
                next.message ?? SETTINGS_MESSAGES.providerNoToolLoop,
                key,
              ),
            }
          : next;
      setConnectionStatus(safeStatus);
      onStatusChange?.(safeStatus);

      const message =
        next.capability === 'tool-loop'
          ? SETTINGS_MESSAGES.connectedReady
          : next.capability === 'plan-only'
            ? SETTINGS_MESSAGES.connectedBriefOnly
            : connectionFailedMessage(safeStatus.message ?? SETTINGS_MESSAGES.connectionFailed);
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : SETTINGS_MESSAGES.configureFailed;
      const safeMessage = redactProviderError(rawMessage, key);
      const message = connectionFailedMessage(safeMessage);
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

  const removeProfile = async (profile: DesktopProviderProfileState) => {
    if (!isDesktopHost()) return;
    if (profile.provider === 'chatgpt') {
      const confirmed = await confirmDialog({
        message: SETTINGS_MESSAGES.removeChatGptConfirm,
        confirmLabel: SETTINGS_MESSAGES.removeLabel,
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    try {
      await deleteDesktopProviderProfile(profile.id);
      // The read clears a chosen profile that the list no longer shows. A failed read leaves it chosen until the next
      // successful read clears it, and connect waits for a successful read, so nothing is saved beside the stale choice.
      await loadProfiles();
    } catch (err) {
      console.warn('Failed to delete provider profile:', err);
      const message = err instanceof Error ? err.message : SETTINGS_MESSAGES.removeFailed;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    }
  };

  const reauthorizeChatGptProfile = async (profile: DesktopProviderProfileState) => {
    if (!isDesktopHost() || profile.provider !== 'chatgpt' || profileActionId !== undefined) return;
    setProfileActionId(profile.id);
    setConnectionNotice(undefined);
    try {
      await signInDesktopProviderProfile({ provider: 'chatgpt', id: profile.id });
      await loadProfiles();
      const message = SETTINGS_MESSAGES.reauthorized;
      setConnectionNotice({ kind: 'success', message });
      onNotice?.(message, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : SETTINGS_MESSAGES.reauthorizeFailed;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
    } finally {
      setProfileActionId(undefined);
    }
  };

  const signOutChatGptProfile = async (profile: DesktopProviderProfileState) => {
    if (!isDesktopHost() || profile.provider !== 'chatgpt' || profileActionId !== undefined) {
      return;
    }
    const confirmed = await confirmDialog({
      message: SETTINGS_MESSAGES.signOutConfirm,
      confirmLabel: SETTINGS_MESSAGES.signOutLabel,
      tone: 'danger',
    });
    if (!confirmed) return;
    setProfileActionId(profile.id);
    setConnectionNotice(undefined);
    try {
      await signOutDesktopProviderProfile(profile.id);
      await loadProfiles();
      const message = SETTINGS_MESSAGES.revoked;
      setConnectionNotice({ kind: 'success', message });
      onNotice?.(message, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : SETTINGS_MESSAGES.signOutFailed;
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      const removeLocally = await confirmDialog({
        message: `${message}\n\n${SETTINGS_MESSAGES.removeLocallyConfirm}`,
        confirmLabel: SETTINGS_MESSAGES.removeLocallyLabel,
        tone: 'danger',
      });
      if (!removeLocally) return;
      try {
        await deleteDesktopProviderProfile(profile.id);
        await loadProfiles();
        const localMessage = SETTINGS_MESSAGES.removedLocally;
        setConnectionNotice({ kind: 'info', message: localMessage });
        onNotice?.(localMessage, 'info');
      } catch (removeError) {
        const localError =
          removeError instanceof Error
            ? removeError.message
            : SETTINGS_MESSAGES.removeLocallyFailed;
        setConnectionNotice({ kind: 'error', message: localError });
        onNotice?.(localError, 'error');
      }
    } finally {
      setProfileActionId(undefined);
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
        const message = SETTINGS_MEDIA_CHECK.invalidResult;
        setMediaCapabilities(undefined);
        setMediaProbeNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        return;
      }
      setMediaCapabilities(report);
      const message = mediaCheckComplete(displayModelId(report.modelId));
      setMediaProbeNotice({ kind: 'success', message });
      onNotice?.(message, 'success');
    } catch {
      if (!mountedRef.current || probeEpoch !== mediaProbeEpochRef.current) return;
      const message = SETTINGS_MEDIA_CHECK.couldNotComplete;
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
    const message = SETTINGS_MESSAGES.connectionCleared;
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
        className="agent-settings-dialog joy-agent-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="joy-agent-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header — the shared dialog frame: title, one-line description, close. */}
        <header className="agent-settings-header joy-agent-settings-header">
          <div className="joy-agent-settings-header-title">
            <span className="joy-settings-logo-mark">
              <BoltIcon />
            </span>
            <div>
              <h2 id="joy-agent-settings-title">{SETTINGS_DIALOG.title}</h2>
              <span className="agent-settings-hint joy-settings-header-sub">
                {SETTINGS_DIALOG.subtitle}
              </span>
            </div>
          </div>
          <button
            className="joy-agent-settings-close-btn icon-button"
            type="button"
            aria-label={SETTINGS_DIALOG.closeLabel}
            title={SETTINGS_DIALOG.closeLabel}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Two-Pane Body */}
        <div className="agent-settings-body joy-agent-settings-body">
          {/* Left Vertical Sidebar (faq-theme tabs navigation) */}
          <nav
            className="joy-agent-settings-sidebar"
            aria-label={SETTINGS_DIALOG.categoriesNavLabel}
          >
            <div className="joy-settings-sidebar-section-label">
              {SETTINGS_DIALOG.categoriesLabel}
            </div>
            <div className="joy-settings-sidebar-list">
              {TAB_CONFIG.map(({ id, label, icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`button-secondary joy-settings-nav-item ${activeTab === id ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(id)}
                >
                  <span className="joy-settings-nav-icon">{icon}</span>
                  <span className="joy-settings-nav-label">{label}</span>
                </button>
              ))}
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
            {activeTab === 'models' ? (
              <AgentSlotsSection
                profiles={profiles}
                onUseSlot={useAgentSlot}
                onProfilesChanged={() => loadProfiles()}
              />
            ) : null}
            {activeTab === 'models' && (
              <div className="joy-accordion">
                {onOpenModelDrawer && (
                  <button
                    className="button-secondary"
                    onClick={onOpenModelDrawer}
                    aria-label={SETTINGS_MODELS.browseButton}
                  >
                    {SETTINGS_MODELS.browseButton}
                  </button>
                )}
                {/* Studio Presets Picker */}
                <div className="joy-studio-preset-bar">
                  <button type="button" className="button-secondary joy-preset-tab is-active">
                    <span className="joy-preset-icon">
                      <ToolsIcon />
                    </span>
                    <div className="joy-preset-text">
                      <strong>{SETTINGS_MODELS.presetTitle}</strong>
                      <span>{SETTINGS_MODELS.presetHint}</span>
                    </div>
                  </button>
                </div>

                {/* Active Connection Banner */}
                <div className="joy-settings-active-banner">
                  <div className="joy-settings-active-info">
                    <div className="joy-settings-active-icon">
                      <BoltIcon />
                    </div>
                    <div className="joy-settings-active-details">
                      <strong>
                        {connectionStatus?.modelId
                          ? `Active: ${connectionStatus.modelId}`
                          : SETTINGS_MODELS.noModel}
                      </strong>
                      <span role="status">
                        {connectionStatus?.capability === 'tool-loop'
                          ? SETTINGS_MODELS.readyToEdit
                          : connectionStatus?.capability === 'plan-only'
                            ? SETTINGS_MODELS.briefOnly
                            : connectionStatus?.capability === 'incompatible'
                              ? SETTINGS_MODELS.connectionFailed
                              : SETTINGS_MODELS.connectBelow}
                      </span>
                    </div>
                  </div>
                  {connectionStatus?.modelId && (
                    <button type="button" className="button-secondary button-sm" onClick={clear}>
                      {SETTINGS_MODELS.disconnect}
                    </button>
                  )}
                </div>

                {/* Saved Vault Profiles Bar */}
                {profiles.length > 0 && (
                  <div className="joy-settings-vault-profiles">
                    <div className="joy-settings-vault-profiles-header">
                      <span>
                        {SETTINGS_MODELS.savedConnections} ({profiles.length})
                      </span>
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
                              <strong>{profileLabel(prof)}</strong>
                              <span>{displayModelId(prof.modelId)}</span>
                              {disabledLegacy && (
                                <span className="joy-settings-legacy-status">
                                  {SETTINGS_MODELS.legacyProfile}
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
                            <div className="joy-settings-provider-actions">
                              {disabledLegacy ? (
                                <button
                                  type="button"
                                  className="button-secondary button-sm"
                                  onClick={() => void deferLegacyProfile(prof)}
                                  disabled={working || prof.decision === 'later'}
                                >
                                  {SETTINGS_MODELS.laterButton}
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="button-secondary button-sm"
                                    disabled={working || profileActionId !== undefined}
                                    onClick={() => void connectSavedProfile(prof)}
                                  >
                                    {SETTINGS_MODELS.useButton}
                                  </button>
                                  {prof.provider === 'chatgpt' && (
                                    <>
                                      <button
                                        type="button"
                                        className="button-secondary button-sm"
                                        disabled={working || profileActionId !== undefined}
                                        onClick={() => void reauthorizeChatGptProfile(prof)}
                                      >
                                        {profileActionId === prof.id
                                          ? SETTINGS_MODELS.working
                                          : SETTINGS_MODELS.signInAgain}
                                      </button>
                                      <button
                                        type="button"
                                        className="button-danger button-sm"
                                        disabled={working || profileActionId !== undefined}
                                        onClick={() => void signOutChatGptProfile(prof)}
                                      >
                                        {SETTINGS_MODELS.signOutAndRevoke}
                                      </button>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    className="icon-button joy-settings-remove-btn"
                                    disabled={profileActionId !== undefined}
                                    onClick={() => void removeProfile(prof)}
                                    aria-label={
                                      prof.provider === 'chatgpt'
                                        ? SETTINGS_MODELS.removeChatGptLabel
                                        : removeProfileLabel(profileLabel(prof))
                                    }
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
                  className={`agent-settings-section joy-accordion-item ${openAccordions['models-endpoint'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('models-endpoint')}
                    aria-expanded={openAccordions['models-endpoint']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <PlugIcon />
                      </span>
                      <span>{SETTINGS_MODELS.connectionTitle}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {provider === ''
                          ? SETTINGS_MODELS.providerTagNone
                          : provider === 'openrouter'
                            ? SETTINGS_MODELS.providerTagOpenRouter
                            : SETTINGS_MODELS.yourOwnEndpoint}
                      </span>
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['models-endpoint'] && (
                    <div className="joy-accordion-content">
                      <ProviderSignInPanel
                        onSignedIn={() => void loadProfiles()}
                        onSaved={() => void loadProfiles()}
                      />
                      <div className="joy-settings-form-grid">
                        <div className="joy-settings-field">
                          <label>
                            <span>{SETTINGS_MODELS.providerLabel}</span>
                            <select
                              value={provider}
                              onChange={(e) =>
                                handleProviderChange(e.target.value as DialogProvider)
                              }
                            >
                              <option value="" disabled>
                                {SETTINGS_MODELS.chooseProvider}
                              </option>
                              <option value="openrouter">{SETTINGS_MODELS.openRouterOption}</option>
                              {/* The legacy Grok row uses xAI's API route, whose key entry lives in the xAI accordion.
                                  Source: D22 step 2 brief (2026-10-30) and registry rows `grok`/`xai`. */}
                              {PROVIDER_REGISTRY.filter(
                                (item) =>
                                  item.id !== 'openrouter' &&
                                  item.id !== 'grok' &&
                                  !SIGN_IN_PROVIDER_IDS.has(item.id) &&
                                  item.signInOnly !== true,
                              ).map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.label}
                                </option>
                              ))}
                              <option value="openai-compatible">
                                {SETTINGS_MODELS.otherProviderOption}
                              </option>
                            </select>
                          </label>
                          {(findRegistryProvider(provider)?.regions.length ?? 0) > 1 && (
                            <label>
                              <span>{SETTINGS_MODELS.regionLabel}</span>
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
                              {SETTINGS_MODELS.getKeyAt}{' '}
                              {findRegistryProvider(provider)?.regions.find(
                                (item) => item.id === region,
                              )?.keyUrl ?? ''}
                            </small>
                          )}
                        </div>

                        <div className="joy-settings-field">
                          <label>
                            <span>{SETTINGS_MODELS.connectionNameLabel}</span>
                            <input
                              type="text"
                              placeholder={SETTINGS_MODELS.connectionNamePlaceholder}
                              value={connectionName}
                              onChange={(e) => setConnectionName(e.target.value)}
                            />
                          </label>
                        </div>

                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <span>{SETTINGS_MODELS.serviceAddressLabel}</span>
                            <input
                              type="text"
                              placeholder={SETTINGS_MODELS.serviceAddressPlaceholder}
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
                            <span>{SETTINGS_MODELS.keyLabel}</span>
                            <input
                              ref={keyRef}
                              type="password"
                              placeholder={
                                canUseStoredKey(matchedProfile)
                                  ? SETTINGS_MODELS.savedKeyPlaceholder
                                  : SETTINGS_MODELS.keyPlaceholder
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
                              <span className="joy-settings-hint-success">
                                ({SETTINGS_STORAGE.savedNote})
                              </span>
                            )}
                          <span className="joy-settings-hint-muted">
                            <LockIcon /> {SETTINGS_STORAGE.keyNote}
                          </span>
                        </div>

                        {requiresCustomEndpointConsent(provider, baseUrl) && (
                          <div className="joy-settings-field-full joy-settings-field">
                            <label className="agent-toggle joy-settings-hint-muted">
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
                              {SETTINGS_MODELS.customEndpointConsent}
                            </label>
                          </div>
                        )}

                        {/* Model ID Text Input with Model Drawer Trigger */}
                        <div className="joy-settings-field-full joy-settings-field">
                          <label>
                            <div className="joy-settings-field-row">
                              <span>{SETTINGS_MODELS.modelIdLabel}</span>
                              <button
                                type="button"
                                className="button-link joy-settings-text-btn"
                                onClick={() => {
                                  toggleAccordion('models-drawer');
                                  if (discoveredModels.length === 0) {
                                    void discoverModels();
                                  }
                                }}
                              >
                                {openAccordions['models-drawer'] ? (
                                  <>
                                    <ChevronUpIcon /> {SETTINGS_MODELS.hideModelList}
                                  </>
                                ) : (
                                  <>
                                    <BoltIcon /> {SETTINGS_MODELS.showModelList} <ChevronDownIcon />
                                  </>
                                )}
                              </button>
                            </div>
                            <div className="joy-settings-input-with-action">
                              <input
                                type="text"
                                aria-label={SETTINGS_MODELS.modelIdName}
                                placeholder={SETTINGS_MODELS.modelIdPlaceholder}
                                value={modelId}
                                onChange={(e) => setModelId(e.target.value)}
                              />
                              <button
                                type="button"
                                className="button-secondary"
                                onClick={() => void discoverModels()}
                                disabled={isDiscovering || working}
                                title={SETTINGS_MODELS.findModelsTooltip}
                              >
                                <SearchIcon />{' '}
                                {isDiscovering
                                  ? SETTINGS_MODELS.findingModels
                                  : SETTINGS_MODELS.findModels}
                              </button>
                            </div>
                          </label>
                        </div>
                      </div>

                      {/* Connection Actions */}
                      <div className="joy-settings-actions-bar">
                        <div className="joy-settings-actions-row">
                          <button
                            type="button"
                            className="button-primary"
                            onClick={() => void connect()}
                            disabled={working}
                          >
                            {working ? SETTINGS_MODELS.connecting : SETTINGS_MODELS.connect}
                          </button>
                          {connectionStatus?.capability && (
                            <button
                              type="button"
                              className="button-secondary"
                              onClick={clear}
                              disabled={working}
                            >
                              {SETTINGS_MODELS.clearConnection}
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
                  className={`agent-settings-section joy-accordion-item joy-model-drawer-item ${openAccordions['models-drawer'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('models-drawer')}
                    aria-expanded={openAccordions['models-drawer']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <PaletteIcon />
                      </span>
                      <span>{SETTINGS_MODELS.modelsTitle}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      {discoveredModels.length > 0 ? (
                        <span className="joy-accordion-tag is-success">
                          <CheckIcon /> {modelsReadyTag(discoveredModels.length)}
                        </span>
                      ) : (
                        <span className="joy-accordion-tag">{SETTINGS_MODELS.openToFind}</span>
                      )}
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['models-drawer'] && (
                    <div className="joy-accordion-content joy-model-drawer-content">
                      <div className="joy-model-drawer-header">
                        <p className="joy-model-drawer-hint">{SETTINGS_MODELS.modelsHint}</p>
                        <div className="joy-settings-actions-row-tight">
                          <button
                            type="button"
                            className="button-secondary button-sm"
                            onClick={() => void discoverModels()}
                            disabled={isDiscovering || working}
                            aria-label={SETTINGS_MODELS.lookAgainName}
                            title={SETTINGS_MODELS.lookAgainTitle}
                          >
                            <RefreshIcon />{' '}
                            {isDiscovering
                              ? SETTINGS_MODELS.checkingAgain
                              : SETTINGS_MODELS.lookAgain}
                          </button>
                        </div>
                      </div>

                      {discoveryError && (
                        <div className="joy-settings-notice is-error joy-settings-block-gap">
                          {discoveryError}
                        </div>
                      )}

                      <div className="joy-model-drawer-search">
                        <input
                          type="text"
                          placeholder={SETTINGS_MODELS.filterPlaceholder}
                          value={modelFilter}
                          onChange={(e) => setModelFilter(e.target.value)}
                        />
                      </div>

                      {/* Quick Filter Tag Buttons */}
                      <div className="joy-model-drawer-tags">
                        <button
                          type="button"
                          className={`button-secondary joy-model-tag ${modelFilter === '' ? 'is-active' : ''}`}
                          onClick={() => setModelFilter('')}
                        >
                          {SETTINGS_MODELS.filterAll}
                        </button>
                        <button
                          type="button"
                          className={`button-secondary joy-model-tag ${modelFilter === 'free' ? 'is-active' : ''}`}
                          onClick={() => setModelFilter('free')}
                        >
                          {SETTINGS_MODELS.filterFree}
                        </button>
                        <button
                          type="button"
                          className={`button-secondary joy-model-tag ${modelFilter === 'claude' ? 'is-active' : ''}`}
                          onClick={() => setModelFilter('claude')}
                        >
                          {SETTINGS_MODELS.filterClaude}
                        </button>
                        <button
                          type="button"
                          className={`button-secondary joy-model-tag ${modelFilter === 'gpt' ? 'is-active' : ''}`}
                          onClick={() => setModelFilter('gpt')}
                        >
                          {SETTINGS_MODELS.filterGpt}
                        </button>
                      </div>

                      {/* Interactive Model Chips Grid */}
                      <div className="joy-settings-model-chips">
                        {filteredDiscoveredModels.length > 0 ? (
                          filteredDiscoveredModels.slice(0, 80).map((m) => (
                            <button
                              key={m}
                              type="button"
                              className={`button-secondary joy-settings-model-chip ${modelId === m ? 'is-selected' : ''}`}
                              onClick={() => setModelId(m)}
                            >
                              {m}
                            </button>
                          ))
                        ) : (
                          <div className="joy-model-drawer-empty">
                            {isDiscovering
                              ? SETTINGS_MODELS.lookingForModels
                              : discoveredModels.length === 0
                                ? SETTINGS_MODELS.noModelsYet
                                : SETTINGS_MODELS.noModelMatches}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* ACCORDION 3: Synthetic Media Capability Diagnostics */}
                <div
                  className={`agent-settings-section joy-accordion-item ${openAccordions['models-probe'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('models-probe')}
                    aria-expanded={openAccordions['models-probe']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <EyeIcon />
                      </span>
                      <span>{SETTINGS_MEDIA_CHECK.modelsTitle}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      {mediaCapabilities ? (
                        <span className="joy-accordion-tag is-success">
                          {SETTINGS_MEDIA_CHECK.checkedTag}
                        </span>
                      ) : (
                        <span className="joy-accordion-tag">
                          {SETTINGS_MEDIA_CHECK.notCheckedTag}
                        </span>
                      )}
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['models-probe'] && (
                    <div className="joy-accordion-content">
                      <p className="joy-settings-hint-muted joy-settings-hint-block">
                        {SETTINGS_MEDIA_CHECK.modelsHint}
                      </p>

                      <div className="joy-settings-actions-row joy-settings-block-gap">
                        <button
                          type="button"
                          className="button-secondary"
                          onClick={() => void probeMediaCapabilities()}
                          disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                        >
                          {mediaProbeWorking
                            ? SETTINGS_MEDIA_CHECK.checking
                            : SETTINGS_MEDIA_CHECK.check}
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
                          <p className="joy-settings-hint-strong joy-settings-hint-block">
                            {SETTINGS_MEDIA_CHECK.configuredModel} {mediaCapabilities.modelId}
                          </p>
                          <dl className="agent-media-capability-list joy-settings-probe-grid">
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.imageLabel}
                              state={mediaCapabilities.image}
                            />
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.audioLabel}
                              state={mediaCapabilities.audio}
                            />
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.videoLabel}
                              state={mediaCapabilities.video}
                            />
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
                  className={`agent-settings-section joy-accordion-item ${openAccordions['exec-mode'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('exec-mode')}
                    aria-expanded={openAccordions['exec-mode']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <ShieldIcon />
                      </span>
                      <span>{SETTINGS_PAGES.execution.kicker}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {SETTINGS_MODES[policy.executionMode].name}
                      </span>
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['exec-mode'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-mode-grid">
                        {(Object.keys(SETTINGS_MODES) as AgentExecutionMode[]).map((mode) => (
                          <div
                            key={mode}
                            className={`joy-settings-mode-card ${policy.executionMode === mode ? 'is-selected' : ''}`}
                            onClick={() => onPolicyChange({ ...policy, executionMode: mode })}
                          >
                            <div className="joy-settings-mode-card-title">
                              <span>{SETTINGS_MODES[mode].name}</span>
                              <input
                                type="radio"
                                name="executionMode"
                                checked={policy.executionMode === mode}
                                onChange={() => onPolicyChange({ ...policy, executionMode: mode })}
                              />
                            </div>
                            <div className="joy-settings-mode-card-desc">
                              {SETTINGS_MODES[mode].sentence}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className={`agent-settings-section joy-accordion-item ${openAccordions['exec-budget'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('exec-budget')}
                    aria-expanded={openAccordions['exec-budget']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <CoinIcon />
                      </span>
                      <span>{SETTINGS_BUDGET.title}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {budgetTag(policy.maxCostPerRunUsd.toFixed(2))}
                      </span>
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['exec-budget'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-field">
                        <label>
                          <span>{SETTINGS_BUDGET.field}</span>
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
                        <span className="joy-settings-hint-muted">{SETTINGS_BUDGET.hint}</span>
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
                  className={`agent-settings-section joy-accordion-item ${openAccordions['exp-previews'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('exp-previews')}
                    aria-expanded={openAccordions['exp-previews']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <EyeIcon />
                      </span>
                      <span>{SETTINGS_LIVE_PREVIEW.title}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['exp-previews'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-actions-column-wide">
                        <label className="joy-settings-cap-item">
                          <input
                            type="checkbox"
                            checked={policy.livePreview}
                            onChange={(e) =>
                              onPolicyChange({ ...policy, livePreview: e.target.checked })
                            }
                          />
                          <span>{SETTINGS_LIVE_PREVIEW.switchLabel}</span>
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
                  className={`agent-settings-section joy-accordion-item ${openAccordions['perms-timeline'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('perms-timeline')}
                    aria-expanded={openAccordions['perms-timeline']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <WrenchIcon />
                      </span>
                      <span>{SETTINGS_TOOLS.title}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag">
                        {allowedToolsTag(
                          policy.allowedCapabilities.length,
                          ALL_TOOL_CAPABILITIES.length,
                        )}
                      </span>
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
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
                              <span>{SETTINGS_TOOLS.names[cap]}</span>
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
                  className={`agent-settings-section joy-accordion-item ${openAccordions['diag-health'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('diag-health')}
                    aria-expanded={openAccordions['diag-health']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <BoltIcon />
                      </span>
                      <span>{SETTINGS_DIAGNOSTICS.hardwareTitle}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-tag is-success">
                        {SETTINGS_DIAGNOSTICS.accelerationTag}
                      </span>
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['diag-health'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-actions-column">
                        <div className="joy-settings-diagnostic-row">
                          <span>{SETTINGS_DIAGNOSTICS.graphicsCard}</span>
                          <span className="joy-settings-hint-accent">
                            NVIDIA GeForce RTX 5070 Ti
                          </span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>{SETTINGS_DIAGNOSTICS.drawingMethod}</span>
                          <span className="joy-settings-diagnostic-status is-supported">
                            ANGLE D3D11
                          </span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>{SETTINGS_DIAGNOSTICS.mediaFolder}</span>
                          <span className="joy-settings-hint-strong">
                            {SETTINGS_DIAGNOSTICS.mediaFolderHint}
                          </span>
                        </div>
                        <div className="joy-settings-diagnostic-row">
                          <span>{SETTINGS_DIAGNOSTICS.backgroundWorker}</span>
                          <span className="joy-settings-diagnostic-status is-supported">
                            joy-worker.exe
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div
                  className={`agent-settings-section joy-accordion-item ${openAccordions['diag-probe'] ? 'is-open' : ''}`}
                >
                  <button
                    type="button"
                    className="button-secondary joy-accordion-trigger"
                    onClick={() => toggleAccordion('diag-probe')}
                    aria-expanded={openAccordions['diag-probe']}
                  >
                    <div className="joy-accordion-trigger-title">
                      <span className="joy-accordion-icon">
                        <FlaskIcon />
                      </span>
                      <span>{SETTINGS_MEDIA_CHECK.diagnosticsTitle}</span>
                    </div>
                    <div className="joy-accordion-trigger-meta">
                      <span className="joy-accordion-chevron">
                        <ChevronDownIcon />
                      </span>
                    </div>
                  </button>

                  {openAccordions['diag-probe'] && (
                    <div className="joy-accordion-content">
                      <div className="joy-settings-field-row joy-settings-block-gap">
                        <span className="joy-settings-hint-muted">
                          {SETTINGS_MEDIA_CHECK.diagnosticsHint}
                        </span>
                        <button
                          type="button"
                          className="button-secondary button-sm"
                          onClick={() => void probeMediaCapabilities()}
                          disabled={!canProbeMediaCapabilities || working || mediaProbeWorking}
                        >
                          {mediaProbeWorking
                            ? SETTINGS_MEDIA_CHECK.checkingShort
                            : SETTINGS_MEDIA_CHECK.check}
                        </button>
                      </div>

                      {mediaCapabilities !== undefined ? (
                        <div className="agent-media-capability-result joy-settings-media-result">
                          <p className="joy-settings-hint-strong joy-settings-hint-block">
                            {SETTINGS_MEDIA_CHECK.configuredModel} {mediaCapabilities.modelId}
                          </p>
                          <dl className="agent-media-capability-list joy-settings-probe-grid">
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.imageLabel}
                              state={mediaCapabilities.image}
                            />
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.audioLabel}
                              state={mediaCapabilities.audio}
                            />
                            <MediaCapabilityRow
                              label={SETTINGS_MEDIA_CHECK.videoLabel}
                              state={mediaCapabilities.video}
                            />
                          </dl>
                        </div>
                      ) : (
                        <p className="joy-settings-hint-muted">
                          {SETTINGS_MEDIA_CHECK.notCheckedYet}
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
              <LockIcon /> {SETTINGS_STORAGE.footer}
            </span>
          </div>
          <button type="button" className="agent-settings-done button-primary" onClick={close}>
            {SETTINGS_DIALOG.doneLabel}
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
      <dd className={`is-${state}`}>
        {state === 'supported' ? SETTINGS_MEDIA_CHECK.supported : SETTINGS_MEDIA_CHECK.unavailable}
      </dd>
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
