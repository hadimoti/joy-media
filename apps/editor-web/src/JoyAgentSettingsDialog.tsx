import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_KILO_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODEL_PRESETS,
  JOY_HOSTED_BASE_URL,
  canonicalKiloBaseUrl,
  defaultModelFor,
  isRetiredModelId,
} from '@joy-media/joy-agent-engine';
import type { AgentExecutionMode, ToolCapability } from '@joy-media/agent-tools';
import { ALL_TOOL_CAPABILITIES } from '@joy-media/agent-tools';
import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type {
  ByokSessionConfig,
  ByokSessionStatus,
  DualBrainConfig,
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
import { getStoredMediaToken, MEDIA_SESSION_CHANGED_EVENT } from './media-session.js';
import {
  fetchJoyHostedDefaultModel,
  fetchJoyHostedSubscriptionState,
  joyHostedGatewayErrorMessage,
  type JoyHostedSubscriptionState,
} from './joy-hosted.js';
import { DesktopAccountModal } from './DesktopAccountModal.js';
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

type StudioPreset = 'dual-brain' | 'joy-hosted' | 'custom';

function readLastStudioPreset(): StudioPreset | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.localStorage.getItem('joy-agent-last-preset');
    return value === 'dual-brain' || value === 'joy-hosted' || value === 'custom'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function persistLastStudioPreset(preset: StudioPreset): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem('joy-agent-last-preset', preset);
  } catch {
    // Preset persistence is a convenience and may be unavailable in private browsing.
  }
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
  const openRouterKeyRef = useRef<HTMLInputElement>(null);
  const kiloKeyRef = useRef<HTMLInputElement>(null);
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

  const [provider, setProvider] = useState<
    'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible'
  >(
    status?.provider === 'joy-hosted' ||
      status?.provider === 'openai-compatible' ||
      status?.provider === 'kilo'
      ? status.provider
      : readLastStudioPreset() === 'joy-hosted'
        ? 'joy-hosted'
        : 'openrouter',
  );
  const [baseUrl, setBaseUrl] = useState(
    status?.provider === 'openai-compatible'
      ? ''
      : status?.provider === 'joy-hosted'
        ? JOY_HOSTED_BASE_URL
        : readLastStudioPreset() === 'joy-hosted'
          ? JOY_HOSTED_BASE_URL
          : status?.provider === 'kilo'
            ? KILO_GATEWAY_BASE_URL
            : 'https://openrouter.ai/api/v1',
  );
  const [modelId, setModelId] = useState(
    status?.modelId && !isRetiredModelId(status.modelId)
      ? status.modelId
      : readLastStudioPreset() === 'joy-hosted'
        ? ''
        : (defaultModelFor(status?.provider ?? 'openrouter') ?? ''),
  );
  const [connectionName, setConnectionName] = useState('');
  const [customDisclosure, setCustomDisclosure] = useState(false);
  const [working, setWorking] = useState(false);
  const [studioPreset, setStudioPreset] = useState<StudioPreset>(
    status?.provider === 'dual-brain'
      ? 'dual-brain'
      : status?.provider === 'joy-hosted'
        ? 'joy-hosted'
        : status?.provider === 'openai-compatible'
          ? 'custom'
          : (readLastStudioPreset() ?? 'dual-brain'),
  );
  const [connectionStatus, setConnectionStatus] = useState(status);
  const [connectionNotice, setConnectionNotice] = useState<AgentSettingsNotice | undefined>();

  // Multi-profile state
  const [profiles, setProfiles] = useState<readonly DesktopProviderProfile[]>([]);
  const [savedProfile, setSavedProfile] = useState<DesktopProviderProfile | undefined>(undefined);
  const [retiredModelNotice, setRetiredModelNotice] = useState(
    status?.modelId && isRetiredModelId(status.modelId)
      ? 'This model is retired. Pick a replacement before connecting.'
      : '',
  );
  const [hasSavedKey, setHasSavedKey] = useState(false);

  // Dynamic model discovery & Drawer state
  const [discoveredModels, setDiscoveredModels] = useState<readonly string[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [joyHostedDefaultModel, setJoyHostedDefaultModel] = useState('');
  const [joyHostedSubscriptionState, setJoyHostedSubscriptionState] =
    useState<JoyHostedSubscriptionState>('signed-out');

  useEffect(() => {
    let current = true;
    void fetchJoyHostedDefaultModel()
      .then((model) => {
        if (current) {
          setJoyHostedDefaultModel(model);
          setModelId((existing) => (provider === 'joy-hosted' && !existing ? model : existing));
        }
      })
      .catch(() => {});
    const refreshSubscription = () => {
      const token =
        typeof window === 'undefined' ? undefined : getStoredMediaToken(window.localStorage);
      setJoyHostedSubscriptionState(token ? 'unavailable' : 'signed-out');
      void fetchJoyHostedSubscriptionState(token).then((state) => {
        if (current) setJoyHostedSubscriptionState(state);
      });
    };
    refreshSubscription();
    if (typeof window !== 'undefined')
      window.addEventListener(MEDIA_SESSION_CHANGED_EVENT, refreshSubscription);
    return () => {
      current = false;
      if (typeof window !== 'undefined')
        window.removeEventListener(MEDIA_SESSION_CHANGED_EVENT, refreshSubscription);
    };
  }, [provider]);

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
      const canonicalProfiles = list.map((profile) => {
        const wasRetired = isRetiredModelId(profile.modelId);
        if (wasRetired) {
          setRetiredModelNotice('This model is retired. Pick a replacement before connecting.');
        }
        const replacement = defaultModelFor(profile.provider) ?? DEFAULT_OPENROUTER_MODEL;
        return {
          ...profile,
          ...(profile.provider === 'kilo'
            ? { baseUrl: canonicalKiloBaseUrl(profile.baseUrl) }
            : {}),
          ...(profile.cachedModels || wasRetired
            ? {
                cachedModels: [
                  ...(profile.cachedModels ?? []).filter((id) => !isRetiredModelId(id)),
                  ...(wasRetired ? [replacement] : []),
                ],
              }
            : {}),
        };
      });
      setProfiles(canonicalProfiles);
      const openRouterProfile = list.find((p) => p.provider === 'openrouter');
      if (openRouterProfile) {
        setSavedProfile(openRouterProfile);
        setHasSavedKey(true);
        const lastPreset = readLastStudioPreset();
        const mediaToken = getStoredMediaToken(window.localStorage);
        if (!lastPreset && !mediaToken) {
          setStudioPreset('custom');
          setModelId(
            isRetiredModelId(openRouterProfile.modelId)
              ? (defaultModelFor(openRouterProfile.provider) ?? DEFAULT_OPENROUTER_MODEL)
              : openRouterProfile.modelId,
          );
          setBaseUrl(openRouterProfile.baseUrl);
          setProvider('openrouter');
          setCustomDisclosure(false);
        } else if (lastPreset === 'custom') {
          setModelId(
            isRetiredModelId(openRouterProfile.modelId)
              ? (defaultModelFor(openRouterProfile.provider) ?? DEFAULT_OPENROUTER_MODEL)
              : openRouterProfile.modelId,
          );
          setBaseUrl(openRouterProfile.baseUrl);
          setProvider('openrouter');
        }
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
    if (next === 'openai-compatible') setStudioPreset('custom');
    setCustomDisclosure(false);
    setConnectionNotice(undefined);
    setDiscoveryError(null);
    if (next === 'openrouter') {
      setBaseUrl('https://openrouter.ai/api/v1');
      if (!modelId || isRetiredModelId(modelId) || modelId === 'openrouter/auto') {
        setModelId(DEFAULT_OPENROUTER_MODEL);
      }
    } else if (next === 'kilo') {
      setBaseUrl(KILO_GATEWAY_BASE_URL);
      if (!KILO_MODEL_PRESETS.some(({ id }) => id === modelId)) {
        setModelId(DEFAULT_KILO_MODEL);
      }
    } else if (next === 'joy-hosted') {
      setBaseUrl(JOY_HOSTED_BASE_URL);
      setModelId(joyHostedDefaultModel);
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
    const matchingSavedProfile =
      savedProfile &&
      savedProfile.provider === (provider === 'openai-compatible' ? 'custom' : provider) &&
      normalizeProviderBaseUrl(savedProfile.baseUrl) === normalizedBaseUrl
        ? savedProfile
        : undefined;
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
          const preferredIds = [
            DEFAULT_KILO_MODEL,
            ...KILO_MODEL_PRESETS.map(({ id }) => id),
            DEFAULT_OPENROUTER_MODEL,
          ];
          const prefer = preferredIds.find((id) => modelIds.includes(id)) || modelIds[0];
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

  const connectDualBrain = async () => {
    if (working) return;
    invalidateMediaProbe();
    setWorking(true);
    setConnectionNotice(undefined);
    setDiscoveryError(null);
    let openRouterKey = '';
    let kiloKey = '';
    try {
      openRouterKey = openRouterKeyRef.current?.value.trim() ?? '';
      kiloKey = kiloKeyRef.current?.value.trim() ?? '';
      const typedOpenRouterKey = openRouterKey;
      const typedKiloKey = kiloKey;

      // Dual-Brain always sends each key to the provider's fixed trusted
      // endpoint, so a saved key may only come from a profile saved for exactly
      // that endpoint; a profile with any other URL is never used here.
      const openRouterProf = profiles.find(
        (p) =>
          p.provider === 'openrouter' && !requiresCustomEndpointConsent('openrouter', p.baseUrl),
      );
      if (!openRouterKey && openRouterProf) {
        try {
          const session = (await beginDesktopProviderSession(openRouterProf.id)) as
            { apiKey?: string } | undefined;
          if (session?.apiKey) openRouterKey = session.apiKey;
        } catch {
          /* ignore */
        }
      }

      const kiloProf = profiles.find(
        (p) => p.provider === 'kilo' && canonicalKiloBaseUrl(p.baseUrl) === KILO_GATEWAY_BASE_URL,
      );
      if (!kiloKey && kiloProf) {
        try {
          const session = (await beginDesktopProviderSession(kiloProf.id)) as
            { apiKey?: string } | undefined;
          if (session?.apiKey) kiloKey = session.apiKey;
        } catch {
          /* ignore */
        }
      }

      if (!openRouterKey && !kiloKey) {
        const message = 'Enter at least one provider key to connect JOY Agent.';
        setConnectionNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        return;
      }

      if (!openRouterKey || !kiloKey) {
        const provider = openRouterKey ? 'openrouter' : 'kilo';
        const other = openRouterKey ? 'Kilo' : 'OpenRouter';
        const key = openRouterKey || kiloKey;
        const singleConfig: ByokSessionConfig =
          provider === 'openrouter'
            ? {
                provider,
                baseUrl: 'https://openrouter.ai/api/v1',
                modelId: DEFAULT_OPENROUTER_MODEL,
                apiKey: key,
              }
            : {
                provider,
                baseUrl: KILO_GATEWAY_BASE_URL,
                modelId:
                  kiloProf && KILO_MODEL_PRESETS.some(({ id }) => id === kiloProf.modelId)
                    ? kiloProf.modelId
                    : DEFAULT_KILO_MODEL,
                apiKey: key,
              };
        await engineClient.configure(singleConfig);
        const tested = await engineClient.testConnection();
        const singleStatus: ByokSessionStatus = {
          ...tested,
          provider,
          modelId: singleConfig.modelId,
        };
        setConnectionStatus(singleStatus);
        onStatusChange?.(singleStatus);
        const message = `Dual-Brain needs both keys; running single-brain on ${provider}. Add a ${other} key to enable Dual-Brain.`;
        setConnectionNotice({
          kind: tested.capability === 'incompatible' ? 'error' : 'success',
          message,
        });
        onNotice?.(message, tested.capability === 'incompatible' ? 'error' : 'success');
        return;
      }

      const dualConfig: DualBrainConfig = {
        mode: 'dual-brain',
        workhorse: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          modelId: DEFAULT_OPENROUTER_MODEL,
          apiKey: openRouterKey,
        },
        creative: {
          provider: 'kilo',
          baseUrl: KILO_GATEWAY_BASE_URL,
          modelId:
            kiloProf && KILO_MODEL_PRESETS.some(({ id }) => id === kiloProf.modelId)
              ? kiloProf.modelId
              : DEFAULT_KILO_MODEL,
          apiKey: kiloKey,
        },
      };

      await engineClient.configure(dualConfig);
      const next = await engineClient.testConnection();
      const redactedStatus = next.dualBrain
        ? {
            ...next,
            dualBrain: {
              workhorse: {
                ...next.dualBrain.workhorse,
                ...(next.dualBrain.workhorse.message
                  ? {
                      message: redactProviderError(next.dualBrain.workhorse.message, openRouterKey),
                    }
                  : {}),
              },
              creative: {
                ...next.dualBrain.creative,
                ...(next.dualBrain.creative.message
                  ? { message: redactProviderError(next.dualBrain.creative.message, kiloKey) }
                  : {}),
              },
            },
          }
        : {
            ...next,
            capability: 'incompatible' as const,
            message: 'Dual-Brain provider status was incomplete.',
          };
      const workhorse = redactedStatus.dualBrain?.workhorse;
      const creative = redactedStatus.dualBrain?.creative;
      const bothUsable =
        workhorse?.capability === 'tool-loop' && creative?.capability === 'tool-loop';
      const bothFailed =
        workhorse?.capability === 'incompatible' && creative?.capability === 'incompatible';
      const noProviderStatuses = !workhorse && !creative;
      let capability: ByokSessionStatus['capability'] = 'untested';
      if (bothUsable) capability = 'tool-loop';
      else if (
        bothFailed ||
        !workhorse ||
        !creative ||
        workhorse.capability === 'incompatible' ||
        creative.capability === 'incompatible'
      ) {
        capability = 'incompatible';
      } else if (workhorse.capability === 'plan-only' && creative.capability === 'plan-only') {
        capability = 'plan-only';
      }
      const safeStatus = { ...redactedStatus, capability };
      setConnectionStatus(safeStatus);
      onStatusChange?.(safeStatus);
      const message = bothUsable
        ? `Dual-Brain Studio connected! Model 1 Workhorse (${dualConfig.workhorse.modelId}) & Model 2 Creative Brain (${dualConfig.creative.modelId}) are live.`
        : bothFailed || noProviderStatuses
          ? `Dual-Brain connection failed. OpenRouter: ${redactProviderError(workhorse?.message ?? 'unavailable', openRouterKey)} Kilo: ${redactProviderError(creative?.message ?? 'unavailable', kiloKey)}`
          : `Dual-Brain partially connected. OpenRouter: ${workhorse?.capability ?? 'unavailable'}${workhorse?.message ? ` (${workhorse.message})` : ''}; Kilo: ${creative?.capability ?? 'unavailable'}${creative?.message ? ` (${creative.message})` : ''}. Tool-loop readiness requires both brains.`;
      const kind = bothUsable ? 'success' : 'error';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);

      if (isDesktopHost() && redactedStatus.dualBrain) {
        const workhorseReady = redactedStatus.dualBrain.workhorse.capability !== 'incompatible';
        const creativeReady = redactedStatus.dualBrain.creative.capability !== 'incompatible';
        if ((typedOpenRouterKey && workhorseReady) || (typedKiloKey && creativeReady)) {
          const savedOpenRouter = profiles.find(
            (profile) =>
              profile.provider === 'openrouter' && profile.baseUrl === dualConfig.workhorse.baseUrl,
          );
          const savedKilo = profiles.find(
            (profile) =>
              profile.provider === 'kilo' &&
              canonicalKiloBaseUrl(profile.baseUrl) === KILO_GATEWAY_BASE_URL,
          );
          if (typedOpenRouterKey && workhorseReady) {
            await saveDesktopProviderProfile({
              ...(savedOpenRouter ? { id: savedOpenRouter.id } : {}),
              name: 'Dual-Brain Workhorse',
              provider: 'openrouter',
              baseUrl: dualConfig.workhorse.baseUrl,
              modelId: dualConfig.workhorse.modelId,
              apiKey: typedOpenRouterKey,
            });
          }
          if (typedKiloKey && creativeReady) {
            await saveDesktopProviderProfile({
              ...(savedKilo ? { id: savedKilo.id } : {}),
              name: 'Dual-Brain Creative',
              provider: 'kilo',
              baseUrl: dualConfig.creative.baseUrl,
              modelId: dualConfig.creative.modelId,
              apiKey: typedKiloKey,
            });
          }
          await loadProfiles();
        }
      }
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : 'Unable to connect Dual-Brain Studio';
      const safeMessage = redactProviderError(
        redactProviderError(rawMessage, openRouterKey),
        kiloKey,
      );
      const failedStatus: ByokSessionStatus = {
        provider: 'dual-brain',
        modelId: `${DEFAULT_OPENROUTER_MODEL} + ${DEFAULT_KILO_MODEL}`,
        capability: 'incompatible',
        message: safeMessage,
      };
      setConnectionStatus(failedStatus);
      onStatusChange?.(failedStatus);
      setConnectionNotice({ kind: 'error', message: safeMessage });
      onNotice?.(safeMessage, 'error');
    } finally {
      if (openRouterKeyRef.current) openRouterKeyRef.current.value = '';
      if (kiloKeyRef.current) kiloKeyRef.current.value = '';
      if (mountedRef.current) setWorking(false);
    }
  };

  const connect = async (override?: {
    readonly provider?: 'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible';
    readonly token?: string;
    readonly baseUrl?: string;
    readonly modelId?: string;
  }) => {
    if (working) return;
    const connectionProvider = override?.provider ?? provider;
    const mediaToken =
      override?.token ??
      (typeof window !== 'undefined' ? getStoredMediaToken(window.localStorage) : undefined);
    if (connectionProvider === 'joy-hosted' && !mediaToken) {
      const message = 'Sign in to your JOY account to use Joy Model.';
      setConnectionNotice({ kind: 'info', message });
      onNotice?.(message, 'info');
      return;
    }
    const connectionBaseUrl = override?.baseUrl ?? baseUrl;
    const normalizedBaseUrl = normalizeProviderBaseUrl(connectionBaseUrl);
    let connectionModelId = override?.modelId ?? modelId;
    if (connectionProvider === 'joy-hosted' && !override?.modelId && !connectionModelId) {
      try {
        connectionModelId = joyHostedDefaultModel || (await fetchJoyHostedDefaultModel());
        setJoyHostedDefaultModel(connectionModelId);
      } catch {
        const message = 'Joy Model catalog is temporarily unavailable. Try again shortly.';
        setConnectionNotice({ kind: 'error', message });
        onNotice?.(message, 'error');
        return;
      }
    }
    const matchingSavedProfile =
      savedProfile &&
      (connectionProvider === 'openai-compatible'
        ? isCustomEndpointProvider(savedProfile.provider)
        : savedProfile.provider === connectionProvider) &&
      normalizeProviderBaseUrl(savedProfile.baseUrl) === normalizedBaseUrl
        ? savedProfile
        : undefined;
    if (
      requiresCustomEndpointConsent(connectionProvider, normalizedBaseUrl) &&
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
    if (!override && studioPreset === 'dual-brain' && connectionProvider !== 'openai-compatible') {
      void connectDualBrain();
      return;
    }
    invalidateMediaProbe();
    setWorking(true);
    setConnectionNotice(undefined);
    setDiscoveryError(null);

    let key = keyRef.current?.value.trim() ?? '';
    const normalizedModelId = connectionModelId.trim();
    const savedProfileMatches = Boolean(
      savedProfile &&
      savedProfile.id &&
      (connectionProvider === 'openai-compatible'
        ? isCustomEndpointProvider(savedProfile.provider)
        : savedProfile.provider === connectionProvider) &&
      normalizeProviderBaseUrl(savedProfile.baseUrl) === normalizedBaseUrl,
    );
    if (
      connectionProvider !== 'joy-hosted' &&
      !key &&
      hasSavedKey &&
      savedProfile?.id &&
      savedProfileMatches
    ) {
      try {
        const session = (await beginDesktopProviderSession(savedProfile.id)) as
          { apiKey?: string; baseUrl?: string; modelId?: string } | undefined;
        if (session?.apiKey) {
          key = session.apiKey;
        }
      } catch {
        /* proceed to validation */
      }
    }

    if (connectionProvider === 'openai-compatible') {
      const missing: string[] = [];
      if (!key)
        missing.push(
          savedProfile?.id && !savedProfileMatches
            ? 'a new API key because the saved key belongs to a different provider or endpoint'
            : 'an API key',
        );
      if (!normalizedModelId) missing.push('a model ID');
      if (!normalizedBaseUrl) missing.push('a base URL');
      if (
        requiresCustomEndpointConsent(connectionProvider, normalizedBaseUrl) &&
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

    if (connectionProvider !== 'joy-hosted' && !key) {
      const message =
        savedProfile?.id && !savedProfileMatches
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
      if (isDesktopHost() && connectionProvider !== 'joy-hosted' && key) {
        const saved = await saveDesktopProviderProfile({
          provider: connectionProvider === 'openai-compatible' ? 'custom' : connectionProvider,
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

      const sessionKey = connectionProvider === 'joy-hosted' ? mediaToken! : key;

      assertCustomEndpointConsentHolds(connectionProvider, normalizedBaseUrl, savedProfile?.id);
      await engineClient.configure({
        provider: connectionProvider,
        baseUrl: normalizedBaseUrl,
        modelId: normalizedModelId,
        apiKey: sessionKey,
      });

      const next = await engineClient.testConnection();
      const mappedGatewayError =
        connectionProvider === 'joy-hosted'
          ? joyHostedGatewayErrorMessage(next.message ?? '')
          : undefined;
      const safeStatus =
        next.capability === 'incompatible'
          ? {
              ...next,
              message:
                mappedGatewayError ??
                redactProviderError(
                  next.message ?? 'The provider responded, but JOY could not use its tool loop.',
                  key,
                ),
            }
          : next;
      setConnectionStatus(safeStatus);
      onStatusChange?.(safeStatus);

      const message = mappedGatewayError
        ? mappedGatewayError
        : next.capability === 'tool-loop'
          ? 'Connected successfully. JOY is ready to edit in this session.'
          : next.capability === 'plan-only'
            ? "Connected in plan-only mode: JOY can propose plans but this model can't call tools."
            : `Connection failed: ${safeStatus.message}`;
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unable to configure connection';
      const safeMessage =
        (connectionProvider === 'joy-hosted'
          ? joyHostedGatewayErrorMessage(rawMessage)
          : undefined) ?? redactProviderError(rawMessage, key);
      const message = `Connection failed: ${safeMessage}`;
      setConnectionStatus({
        provider: connectionProvider,
        modelId: normalizedModelId,
        capability: 'incompatible',
        message: safeMessage,
      });
      onStatusChange?.({
        provider: connectionProvider,
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
    if (
      requiresCustomEndpointConsent(prof.provider, prof.baseUrl) &&
      !requireCustomEndpointAcknowledgement({
        provider: 'custom',
        baseUrl: prof.baseUrl,
        profileId: prof.id,
      })
    ) {
      setProvider(
        isCustomEndpointProvider(prof.provider)
          ? 'openai-compatible'
          : (prof.provider as 'openrouter' | 'kilo' | 'joy-hosted'),
      );
      setStudioPreset('custom');
      setBaseUrl(prof.baseUrl);
      setSavedProfile(prof);
      setModelId(prof.modelId);
      const message = 'Enter the custom-provider acknowledgement before connecting.';
      setConnectionNotice({ kind: 'error', message });
      onNotice?.(message, 'error');
      return;
    }
    setWorking(true);
    let key = '';
    let configurationFailed = false;
    try {
      const session = (await beginDesktopProviderSession(prof.id)) as
        { apiKey?: string; baseUrl?: string; modelId?: string; provider?: string } | undefined;
      key = session?.apiKey || '';
      const resolvedProvider = (
        isCustomEndpointProvider(prof.provider) ? 'openai-compatible' : prof.provider
      ) as 'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible';
      setProvider(resolvedProvider);
      setBaseUrl(prof.baseUrl);
      setModelId(prof.modelId);
      setSavedProfile(prof);
      setHasSavedKey(Boolean(key));

      assertCustomEndpointConsentHolds(prof.provider, prof.baseUrl, prof.id);
      configurationFailed = true;
      await engineClient.configure({
        provider: resolvedProvider,
        baseUrl: prof.baseUrl.replace(/\/$/, ''),
        modelId: prof.modelId,
        apiKey: key,
      });
      // configure() has already replaced the previous client, so a later
      // testConnection() rejection must also publish a failed status.
      const next = await engineClient.testConnection();
      const safeStatus =
        next.capability === 'incompatible'
          ? { ...next, message: redactProviderError(next.message ?? 'Connection failed', key) }
          : next;
      setConnectionStatus(safeStatus);
      onStatusChange?.(safeStatus);
      const kind = next.capability === 'incompatible' ? 'error' : 'success';
      const message =
        next.capability === 'incompatible'
          ? `Connection failed: ${safeStatus.message}`
          : `Connected to ${prof.name || prof.provider}: ${prof.modelId}`;
      setConnectionNotice({ kind, message });
      onNotice?.(message, kind);
    } catch (err) {
      const message = redactProviderError(
        err instanceof Error ? err.message : 'Failed to switch provider',
        key,
      );
      if (configurationFailed) {
        const failedStatus: ByokSessionStatus = {
          provider: prof.provider as ByokSessionStatus['provider'],
          modelId: prof.modelId,
          capability: 'incompatible',
          message,
        };
        setConnectionStatus(failedStatus);
        onStatusChange?.(failedStatus);
      }
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
    if (openRouterKeyRef.current) openRouterKeyRef.current.value = '';
    if (kiloKeyRef.current) kiloKeyRef.current.value = '';
  };

  const filteredDiscoveredModels = discoveredModels.filter((model) => {
    if (modelFilter === 'vision') {
      return KILO_MODEL_PRESETS.some((preset) => preset.vision && preset.id === model);
    }
    if (modelFilter === 'byteplus') return model.startsWith('byteplus-coding/');
    return modelFilter ? model.toLowerCase().includes(modelFilter.toLowerCase()) : true;
  });

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
                  <button
                    type="button"
                    className={`joy-preset-tab ${studioPreset === 'dual-brain' ? 'is-active' : ''}`}
                    onClick={() => {
                      setStudioPreset('dual-brain');
                      persistLastStudioPreset('dual-brain');
                      setProvider('openrouter');
                      setBaseUrl('https://openrouter.ai/api/v1');
                      setModelId(DEFAULT_OPENROUTER_MODEL);
                    }}
                  >
                    <span className="joy-preset-icon">⚡</span>
                    <div className="joy-preset-text">
                      <strong>Dual-Brain Studio</strong>
                      <span>
                        Workhorse (openrouter/free) + Creative (Dola Seed 2.0 Pro, vision)
                      </span>
                    </div>
                    <span className="joy-preset-tag">Recommended</span>
                  </button>
                  <button
                    type="button"
                    className={`joy-preset-tab ${studioPreset === 'joy-hosted' ? 'is-active' : ''}`}
                    onClick={() => {
                      setStudioPreset('joy-hosted');
                      persistLastStudioPreset('joy-hosted');
                      handleProviderChange('joy-hosted');
                    }}
                  >
                    <span className="joy-preset-icon">💎</span>
                    <div className="joy-preset-text">
                      <strong>Joy Hosted Pro Gateway</strong>
                      <span>Hosted model catalog</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className={`joy-preset-tab ${studioPreset === 'custom' ? 'is-active' : ''}`}
                    onClick={() => {
                      setStudioPreset('custom');
                      persistLastStudioPreset('custom');
                    }}
                  >
                    <span className="joy-preset-icon">🛠️</span>
                    <div className="joy-preset-text">
                      <strong>Custom BYOK</strong>
                      <span>Single provider link (OpenRouter, Kilo, OpenAI)</span>
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
                      {connectionStatus?.dualBrain && (
                        <div className="joy-settings-dual-brain-banner">
                          <div className="joy-dual-brain-chip">
                            <span className="joy-chip-label">🧠 Model 1 (Workhorse):</span>
                            <span className="joy-chip-val">
                              {connectionStatus.dualBrain.workhorse.modelId}
                            </span>
                            <span className="joy-chip-badge">
                              {connectionStatus.dualBrain.workhorse.capability}
                            </span>
                          </div>
                          <div className="joy-dual-brain-chip">
                            <span className="joy-chip-label">🎨 Model 2 (Creative Brain):</span>
                            <span className="joy-chip-val">
                              {connectionStatus.dualBrain.creative.modelId}
                            </span>
                            <span className="joy-chip-badge">
                              {connectionStatus.dualBrain.creative.capability}
                            </span>
                          </div>
                        </div>
                      )}
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
                                    'joy-hosted' | 'openrouter' | 'kilo' | 'openai-compatible',
                                )
                              }
                            >
                              <option value="openrouter">OpenRouter (BYOK)</option>
                              <option value="kilo">Kilo Gateway (api.kilo.ai)</option>
                              <option value="openai-compatible">
                                Custom OpenAI-compatible endpoint
                              </option>
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
                              onChange={(e) => {
                                setBaseUrl(e.target.value);
                                setCustomDisclosure(false);
                              }}
                            />
                          </label>
                        </div>

                        {provider === 'joy-hosted' ? (
                          <div className="joy-settings-field-full joy-settings-pro-card">
                            <p style={{ margin: 0, fontSize: '13px', color: '#ffb020' }}>
                              {joyHostedSubscriptionState === 'active'
                                ? 'Active JOY Pro subscription'
                                : joyHostedSubscriptionState === 'not-subscribed'
                                  ? 'Not subscribed — Upgrade or use BYOK'
                                  : joyHostedSubscriptionState === 'signed-out'
                                    ? 'Signed out'
                                    : 'Checking JOY Pro subscription…'}
                            </p>
                            <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: '#888' }}>
                              Joy Model uses your signed-in JOY account and active Pro subscription.
                            </p>
                            {typeof window !== 'undefined' &&
                            !getStoredMediaToken(window.localStorage) ? (
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
                              <p
                                style={{ margin: '6px 0 0', fontSize: '11.5px', color: '#10b981' }}
                              >
                                ✓ JOY Account session linked
                              </p>
                            )}
                          </div>
                        ) : studioPreset === 'dual-brain' && provider !== 'openai-compatible' ? (
                          <div className="joy-settings-field-full joy-settings-field">
                            <label>
                              <span>OpenRouter API key</span>
                              <input
                                ref={openRouterKeyRef}
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </label>
                            <label>
                              <span>Kilo API key</span>
                              <input
                                ref={kiloKeyRef}
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </label>
                            <span style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                              Each key is sent only to its matching provider.
                            </span>
                          </div>
                        ) : (
                          <div className="joy-settings-field-full joy-settings-field">
                            <label>
                              <span>API Secret Key</span>
                              <input
                                ref={keyRef}
                                type="password"
                                placeholder={
                                  hasSavedKey
                                    ? '•••••••••••••••• (Leave blank to keep saved)'
                                    : 'sk-...'
                                }
                                defaultValue=""
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </label>
                            {hasSavedKey && (
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
                        )}

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
                                    const providerProfile = profiles.find(
                                      (profile) =>
                                        profile.provider ===
                                          (provider === 'openai-compatible'
                                            ? 'custom'
                                            : provider) &&
                                        normalizeProviderBaseUrl(profile.baseUrl) === normalized,
                                    );
                                    const exactProfile =
                                      providerProfile ??
                                      (savedProfile &&
                                      savedProfile.provider ===
                                        (provider === 'openai-compatible' ? 'custom' : provider) &&
                                      normalizeProviderBaseUrl(savedProfile.baseUrl) === normalized
                                        ? savedProfile
                                        : undefined);
                                    acknowledgeCustomEndpoint({
                                      provider: 'custom',
                                      baseUrl: normalized,
                                      profileId: exactProfile?.id,
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
                                aria-label="Model ID"
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
                            role={connectionNotice.kind === 'error' ? 'alert' : 'status'}
                          >
                            {connectionNotice.message}
                          </div>
                        )}
                        {retiredModelNotice && (
                          <div className="joy-settings-notice is-info" role="status">
                            {retiredModelNotice}
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
                            placeholder="Filter models (e.g. byteplus, vision, free, sonnet, 4o)..."
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
                            className={`joy-model-tag ${modelFilter === 'byteplus' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('byteplus')}
                          >
                            BytePlus
                          </button>
                          <button
                            type="button"
                            className={`joy-model-tag ${modelFilter === 'vision' ? 'is-active' : ''}`}
                            onClick={() => setModelFilter('vision')}
                          >
                            Vision
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
      <DesktopAccountModal
        isOpen={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        onSuccess={() => {
          setStudioPreset('joy-hosted');
          persistLastStudioPreset('joy-hosted');
          handleProviderChange('joy-hosted');
          const token = getStoredMediaToken(window.localStorage);
          void (async () => {
            try {
              if (engineClient.getStatus()?.provider === 'joy-hosted') return;
              const modelId = joyHostedDefaultModel || (await fetchJoyHostedDefaultModel());
              setJoyHostedDefaultModel(modelId);
              if (token) {
                await connect({
                  provider: 'joy-hosted',
                  token,
                  baseUrl: JOY_HOSTED_BASE_URL,
                  modelId,
                });
              }
            } catch {
              setConnectionNotice({
                kind: 'error',
                message: 'Joy Model catalog is temporarily unavailable. Try again shortly.',
              });
            }
          })();
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

function redactProviderError(raw: string, key: string): string {
  const safeMessage = key ? raw.replaceAll(key, '[redacted]') : raw;
  return safeMessage.slice(0, 180);
}
