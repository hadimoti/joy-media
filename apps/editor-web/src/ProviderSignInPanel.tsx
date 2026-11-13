import { useEffect, useRef, useState } from 'react';
import {
  findRegistryProvider,
  SIGN_IN_WAIT_MS,
  signInProviders,
  type ProviderRegion,
  type ProviderRegionId,
  type RegistryProvider,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import {
  cancelDesktopSignIn,
  isDesktopHost,
  reopenDesktopSignIn,
  saveDesktopProviderProfile,
  signInDesktopProviderProfile,
  type DesktopProviderProfile,
} from './desktop-client.js';
import { providerLabel } from './provider-labels.js';
import { ChevronDownIcon } from './icons.js';
import { SETTINGS_PROVIDER_SIGN_IN } from './settings-wording.js';

/** Minutes and seconds, such as 4:59. */
export function formatSignInCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Only xAI's sign-in shows the risk notice (owner decision 2026-11-05). ChatGPT and Kimi show none. */
const RISK_NOTICE_PROVIDERS: ReadonlySet<RegistryProviderId> = new Set<RegistryProviderId>(['xai']);

/** D23 sign-in provider order follows the existing settings panel order. */
const ORDER: readonly RegistryProviderId[] = ['chatgpt', 'kimi', 'xai'];

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
  // When the wait for the browser began, and the clock the countdown reads (T-J03).
  const [waitingSince, setWaitingSince] = useState<number | undefined>(undefined);
  const [clock, setClock] = useState(() => Date.now());
  // The provider the person cancelled, so its sign-in reports cancelled rather than a failure.
  const cancelledRef = useRef<RegistryProviderId | undefined>(undefined);
  useEffect(() => {
    if (busy === undefined) return undefined;
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [busy]);
  const providers = [...signInProviders()]
    .sort((first, second) => rank(first) - rank(second))
    .map((provider) => findRegistryProvider(provider))
    .filter((provider): provider is RegistryProvider => provider !== undefined);

  if (!isDesktopHost()) return null;

  const signIn = async (target: RegistryProviderId): Promise<void> => {
    cancelledRef.current = undefined;
    const startedAt = Date.now();
    setBusy(target);
    setWaitingSince(startedAt);
    setClock(startedAt);
    setSignInStatus(undefined);
    try {
      const profile = await signInDesktopProviderProfile({ provider: target });
      onSignedIn(profile);
      setSignInStatus({
        provider: target,
        message: SETTINGS_PROVIDER_SIGN_IN.signedIn.replace('{provider}', () =>
          providerLabel(target),
        ),
      });
    } catch (error) {
      // The main process ends the sign-in no earlier than the same wait after this click, so a failure after the
      // whole wait is the timeout: it gets the start-again message (T-J03).
      const timedOut = Date.now() - startedAt >= SIGN_IN_WAIT_MS;
      setSignInStatus({
        provider: target,
        message:
          cancelledRef.current === target
            ? SETTINGS_PROVIDER_SIGN_IN.signInCancelled
            : timedOut
              ? SETTINGS_PROVIDER_SIGN_IN.signInTimedOut.replace('{provider}', () =>
                  providerLabel(target),
                )
              : error instanceof Error
                ? error.message
                : SETTINGS_PROVIDER_SIGN_IN.signInFailed.replace('{provider}', () =>
                    providerLabel(target),
                  ),
      });
    } finally {
      setBusy(undefined);
      setWaitingSince(undefined);
    }
  };

  const cancelSignIn = (target: RegistryProviderId): void => {
    cancelledRef.current = target;
    void cancelDesktopSignIn(target).catch(() => undefined);
  };

  const reopenSignIn = (target: RegistryProviderId): void => {
    void reopenDesktopSignIn(target).catch(() => undefined);
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
          signInRemainingMs={
            busy === provider.id && waitingSince !== undefined
              ? SIGN_IN_WAIT_MS - (clock - waitingSince)
              : undefined
          }
          onSignIn={() => void signIn(provider.id)}
          onCancelSignIn={() => cancelSignIn(provider.id)}
          onReopenSignIn={() => reopenSignIn(provider.id)}
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
  signInRemainingMs,
  onSignIn,
  onCancelSignIn,
  onReopenSignIn,
  onSaved,
}: {
  readonly provider: RegistryProvider;
  readonly signInBusy: boolean;
  readonly signInDisabled: boolean;
  readonly signInMessage?: string | undefined;
  /** Time left in the wait for the browser, while this provider's sign-in runs. */
  readonly signInRemainingMs?: number | undefined;
  readonly onSignIn: () => void;
  readonly onCancelSignIn: () => void;
  readonly onReopenSignIn: () => void;
  readonly onSaved?: ((profile: DesktopProviderProfile) => void) | undefined;
}) {
  const label = providerLabel(provider.id);
  const regions = apiKeyRegions(provider);
  const [open, setOpen] = useState(false);
  const [apiKeyRegionId, setApiKeyRegionId] = useState<ProviderRegionId | undefined>(
    regions[0]?.id,
  );
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
      setApiKeyMessage(SETTINGS_PROVIDER_SIGN_IN.modelIdRequired);
      return;
    }
    const apiKey = apiKeyRef.current?.value ?? '';
    if (apiKey.length === 0) {
      setApiKeyMessage(SETTINGS_PROVIDER_SIGN_IN.apiKeyRequired);
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
      setApiKeyMessage(SETTINGS_PROVIDER_SIGN_IN.apiKeySaved);
      onSaved?.(profile);
    } catch {
      setApiKeyMessage(SETTINGS_PROVIDER_SIGN_IN.apiKeySaveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={'joy-accordion-item' + (open ? ' is-open' : '')}>
      <button
        type="button"
        className="button-secondary joy-accordion-trigger"
        aria-label={SETTINGS_PROVIDER_SIGN_IN.toggleRoutesLabel.replace('{provider}', () => label)}
        aria-expanded={open}
        aria-controls={'joy-provider-routes-' + provider.id}
        onClick={toggle}
      >
        <span className="joy-accordion-trigger-title">{label}</span>
        <span className="joy-accordion-trigger-meta">
          <span className="joy-accordion-tag">
            {regions.length > 0
              ? SETTINGS_PROVIDER_SIGN_IN.bothRoutesTag
              : SETTINGS_PROVIDER_SIGN_IN.signInOnlyTag}
          </span>
          <span className="joy-accordion-chevron">
            <ChevronDownIcon />
          </span>
        </span>
      </button>

      {open && (
        <div id={'joy-provider-routes-' + provider.id} className="joy-accordion-content">
          <section
            className="joy-provider-route"
            aria-label={SETTINGS_PROVIDER_SIGN_IN.oauthRouteLabel.replace(
              '{provider}',
              () => label,
            )}
          >
            <h4 className="joy-provider-route-title">
              {SETTINGS_PROVIDER_SIGN_IN.oauthRouteTitle}
            </h4>
            <button
              type="button"
              className="button-primary"
              disabled={signInDisabled || saving}
              onClick={onSignIn}
            >
              {(signInBusy
                ? SETTINGS_PROVIDER_SIGN_IN.signInButtonBusy
                : SETTINGS_PROVIDER_SIGN_IN.signInButton
              ).replace('{provider}', () => label)}
            </button>
            {signInBusy && signInRemainingMs !== undefined && (
              <div className="joy-provider-sign-in-waiting">
                <p role="status">
                  {SETTINGS_PROVIDER_SIGN_IN.waitingForBrowser.replace('{time}', () =>
                    formatSignInCountdown(signInRemainingMs),
                  )}
                </p>
                <button type="button" className="button-secondary" onClick={onReopenSignIn}>
                  {SETTINGS_PROVIDER_SIGN_IN.openSignInPageAgain}
                </button>
                <button type="button" className="button-secondary" onClick={onCancelSignIn}>
                  {SETTINGS_PROVIDER_SIGN_IN.cancelSignIn}
                </button>
              </div>
            )}
            {RISK_NOTICE_PROVIDERS.has(provider.id) && (
              <p className="joy-provider-risk-notice">
                {SETTINGS_PROVIDER_SIGN_IN.oauthRiskNotice}
              </p>
            )}
            {signInMessage !== undefined && <p role="status">{signInMessage}</p>}
          </section>

          <section
            className="joy-provider-route"
            aria-label={SETTINGS_PROVIDER_SIGN_IN.apiKeyRouteLabel.replace(
              '{provider}',
              () => label,
            )}
          >
            <h4 className="joy-provider-route-title">
              {SETTINGS_PROVIDER_SIGN_IN.apiKeyRouteTitle}
            </h4>
            {selectedRegion === undefined ? (
              <p>{SETTINGS_PROVIDER_SIGN_IN.noApiKeyEndpoint}</p>
            ) : (
              <div className="joy-settings-form-grid">
                {regions.length > 1 && (
                  <div className="joy-settings-field">
                    <label>
                      <span>
                        {SETTINGS_PROVIDER_SIGN_IN.apiKeyRegionLabel.replace(
                          '{provider}',
                          () => label,
                        )}
                      </span>
                      <select
                        aria-label={SETTINGS_PROVIDER_SIGN_IN.apiKeyRegionLabel.replace(
                          '{provider}',
                          () => label,
                        )}
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
                    <span>{SETTINGS_PROVIDER_SIGN_IN.baseUrlLabel}</span>
                    <input
                      aria-label={SETTINGS_PROVIDER_SIGN_IN.baseUrlAriaLabel.replace(
                        '{provider}',
                        () => label,
                      )}
                      type="text"
                      value={selectedRegion.baseUrl}
                      readOnly
                    />
                  </label>
                </div>

                <div className="joy-settings-field">
                  <span>{SETTINGS_PROVIDER_SIGN_IN.apiKeyLabel}</span>
                  <a href={selectedRegion.keyUrl} target="_blank" rel="noreferrer">
                    {SETTINGS_PROVIDER_SIGN_IN.createApiKey}
                  </a>
                </div>

                <div className="joy-settings-field-full joy-settings-field">
                  <label>
                    <span>{SETTINGS_PROVIDER_SIGN_IN.apiSecretKeyLabel}</span>
                    <input
                      ref={apiKeyRef}
                      aria-label={SETTINGS_PROVIDER_SIGN_IN.apiKeyAriaLabel.replace(
                        '{provider}',
                        () => label,
                      )}
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
                    <span>{SETTINGS_PROVIDER_SIGN_IN.modelIdLabel}</span>
                    <input
                      aria-label={SETTINGS_PROVIDER_SIGN_IN.modelIdAriaLabel.replace(
                        '{provider}',
                        () => label,
                      )}
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
                    className="button-primary button-sm"
                    disabled={saving}
                    onClick={() => void saveApiKey()}
                  >
                    {SETTINGS_PROVIDER_SIGN_IN.saveApiKey}
                  </button>
                  {apiKeyMessage !== undefined && <p role="status">{apiKeyMessage}</p>}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
