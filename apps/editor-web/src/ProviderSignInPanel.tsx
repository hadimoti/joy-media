import { useRef, useState } from 'react';
import {
  findRegistryProvider,
  signInProviders,
  type ProviderRegion,
  type ProviderRegionId,
  type RegistryProvider,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import {
  isDesktopHost,
  saveDesktopProviderProfile,
  signInDesktopProviderProfile,
  type DesktopProviderProfile,
} from './desktop-client.js';

/** Owner-approved wording for every OAuth route. Source: D22 step 2 brief (2026-10-30). */
const OAUTH_RISK_NOTICE =
  'Signing in uses a third-party public app and may stop working or be deactivated by the provider at any time. An API key is the dependable way to connect.';

/** D23 sign-in provider order follows the existing settings panel order. */
const ORDER: readonly RegistryProviderId[] = ['chatgpt', 'kimi', 'xai'];

const LABELS: Partial<Record<RegistryProviderId, string>> = {
  chatgpt: 'ChatGPT',
  kimi: 'Kimi',
  xai: 'xAI',
};

function rank(provider: RegistryProviderId): number {
  const index = ORDER.indexOf(provider);
  return index === -1 ? ORDER.length : index;
}

/**
 * The API-key route uses registry regions except OAuth-only or sign-in-only entries.
 * Source: D22 step 2 brief (2026-10-30).
 */
function apiKeyRegions(provider: RegistryProvider): readonly ProviderRegion[] {
  if (provider.signInOnly === true || !provider.auth.methods.includes('api-key')) return [];
  return provider.regions.filter((region) => region.route !== 'oauth');
}

/** The short D22 provider names used by the sign-in actions. Source: D22 step 2 brief (2026-10-30). */
function providerLabel(provider: RegistryProviderId): string {
  return LABELS[provider] ?? findRegistryProvider(provider)?.label ?? provider;
}

/**
 * Offers the three D23 sign-in provider accordions. API-key routes use the desktop profile broker; OAuth actions use
 * the desktop's provider-specific sign-in flow.
 */
export function ProviderSignInPanel({
  onSignedIn,
  onSaved,
}: {
  readonly onSignedIn: (profile: DesktopProviderProfile) => void;
  readonly onSaved?: (profile: DesktopProviderProfile) => void;
}) {
  const [busy, setBusy] = useState<RegistryProviderId | undefined>(undefined);
  const [signInStatus, setSignInStatus] = useState<
    { readonly provider: RegistryProviderId; readonly message: string } | undefined
  >(undefined);
  const providers = [...signInProviders()]
    .sort((first, second) => rank(first) - rank(second))
    .map((provider) => findRegistryProvider(provider))
    .filter((provider): provider is RegistryProvider => provider !== undefined);

  if (!isDesktopHost()) return null;

  const signIn = async (target: RegistryProviderId): Promise<void> => {
    setBusy(target);
    setSignInStatus(undefined);
    try {
      const profile = await signInDesktopProviderProfile({ provider: target });
      onSignedIn(profile);
      setSignInStatus({ provider: target, message: 'Signed in to ' + providerLabel(target) + '.' });
    } catch (error) {
      setSignInStatus({
        provider: target,
        message:
          error instanceof Error
            ? error.message
            : 'The ' + providerLabel(target) + ' sign-in did not complete.',
      });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="joy-provider-route-accordions">
      {providers.map((provider) => (
        <ProviderRouteAccordion
          key={provider.id}
          provider={provider}
          signInBusy={busy === provider.id}
          signInDisabled={busy !== undefined}
          signInMessage={signInStatus?.provider === provider.id ? signInStatus.message : undefined}
          onSignIn={() => void signIn(provider.id)}
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}

function ProviderRouteAccordion({
  provider,
  signInBusy,
  signInDisabled,
  signInMessage,
  onSignIn,
  onSaved,
}: {
  readonly provider: RegistryProvider;
  readonly signInBusy: boolean;
  readonly signInDisabled: boolean;
  readonly signInMessage?: string | undefined;
  readonly onSignIn: () => void;
  readonly onSaved?: ((profile: DesktopProviderProfile) => void) | undefined;
}) {
  const label = providerLabel(provider.id);
  const regions = apiKeyRegions(provider);
  const [open, setOpen] = useState(false);
  const [apiKeyRegionId, setApiKeyRegionId] = useState<ProviderRegionId | undefined>(regions[0]?.id);
  const [modelId, setModelId] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState<string | undefined>(undefined);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const selectedRegion = regions.find((region) => region.id === apiKeyRegionId) ?? regions[0];

  const toggle = (): void => {
    if (open && apiKeyRef.current !== null) apiKeyRef.current.value = '';
    setOpen((previous) => !previous);
  };

  const saveApiKey = async (): Promise<void> => {
    setApiKeyMessage(undefined);
    if (selectedRegion === undefined) return;
    const normalizedModelId = modelId.trim();
    if (normalizedModelId === '') {
      setApiKeyMessage('Enter a model ID before saving.');
      return;
    }
    const apiKey = apiKeyRef.current?.value ?? '';
    if (apiKey.length === 0) {
      setApiKeyMessage('Enter an API key before saving.');
      return;
    }

    setSaving(true);
    try {
      const profile = await saveDesktopProviderProfile({
        provider: provider.id,
        baseUrl: selectedRegion.baseUrl,
        modelId: normalizedModelId,
        apiKey,
      });
      if (apiKeyRef.current !== null) apiKeyRef.current.value = '';
      setApiKeyMessage('API key saved in the desktop vault.');
      onSaved?.(profile);
    } catch {
      setApiKeyMessage('API key could not be saved. Check the fields and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={'joy-accordion-item' + (open ? ' is-open' : '')}>
      <button
        type="button"
        className="joy-accordion-trigger"
        aria-label={'Toggle ' + label + ' connection routes'}
        aria-expanded={open}
        aria-controls={'joy-provider-routes-' + provider.id}
        onClick={toggle}
      >
        <span className="joy-accordion-trigger-title">{label}</span>
        <span className="joy-accordion-trigger-meta">
          <span className="joy-accordion-tag">
            {regions.length > 0 ? 'API key + sign-in' : 'Sign-in only'}
          </span>
          <span className="joy-accordion-chevron">▾</span>
        </span>
      </button>

      {open && (
        <div id={'joy-provider-routes-' + provider.id} className="joy-accordion-content">
          <section className="joy-provider-route" aria-label={label + ' API-key route'}>
            <h4 className="joy-provider-route-title">API key route (Primary)</h4>
            {selectedRegion === undefined ? (
              <p>
                No API-key endpoint is registered for this provider. OpenAI API keys remain under the separate OpenAI
                provider.
              </p>
            ) : (
              <div className="joy-settings-form-grid">
                {regions.length > 1 && (
                  <div className="joy-settings-field">
                    <label>
                      <span>{label} API key region</span>
                      <select
                        aria-label={label + ' API key region'}
                        value={selectedRegion.id}
                        onChange={(event) => {
                          const next = regions.find(
                            (region) => region.id === event.currentTarget.value,
                          );
                          if (next === undefined) return;
                          if (apiKeyRef.current !== null) apiKeyRef.current.value = '';
                          setApiKeyRegionId(next.id);
                          setApiKeyMessage(undefined);
                        }}
                      >
                        {regions.map((region) => (
                          <option key={region.id} value={region.id}>
                            {region.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                <div className="joy-settings-field">
                  <label>
                    <span>OpenAI-compatible base URL</span>
                    <input
                      aria-label={label + ' API key base URL'}
                      type="text"
                      value={selectedRegion.baseUrl}
                      readOnly
                    />
                  </label>
                </div>

                <div className="joy-settings-field">
                  <span>API key</span>
                  <a href={selectedRegion.keyUrl} target="_blank" rel="noreferrer">
                    Create API key
                  </a>
                </div>

                <div className="joy-settings-field-full joy-settings-field">
                  <label>
                    <span>API Secret Key</span>
                    <input
                      ref={apiKeyRef}
                      aria-label={label + ' API key'}
                      type="password"
                      defaultValue=""
                      autoComplete="off"
                      spellCheck={false}
                      onChange={() => setApiKeyMessage(undefined)}
                    />
                  </label>
                </div>

                <div className="joy-settings-field-full joy-settings-field">
                  <label>
                    <span>Model ID</span>
                    <input
                      aria-label={label + ' Model ID'}
                      type="text"
                      value={modelId}
                      required
                      onChange={(event) => {
                        setModelId(event.currentTarget.value);
                        setApiKeyMessage(undefined);
                      }}
                    />
                  </label>
                </div>

                <div className="joy-settings-field-full">
                  <button
                    type="button"
                    className="joy-btn-primary joy-btn-sm"
                    disabled={saving}
                    onClick={() => void saveApiKey()}
                  >
                    Save API key
                  </button>
                  {apiKeyMessage !== undefined && <p role="status">{apiKeyMessage}</p>}
                </div>
              </div>
            )}
          </section>

          <section className="joy-provider-route" aria-label={label + ' OAuth route'}>
            <h4 className="joy-provider-route-title">OAuth sign-in route (Secondary)</h4>
            <button
              type="button"
              className="joy-btn-secondary"
              disabled={signInDisabled || saving}
              onClick={onSignIn}
            >
              Sign in with {label}
              {signInBusy ? '…' : ''}
            </button>
            <p className="joy-provider-risk-notice">{OAUTH_RISK_NOTICE}</p>
            {signInMessage !== undefined && <p role="status">{signInMessage}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
