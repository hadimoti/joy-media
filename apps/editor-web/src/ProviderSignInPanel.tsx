import { useState } from 'react';
import {
  findRegistryProvider,
  signInProviders,
  type MiniMaxRegion,
  type RegistryProviderId,
} from '@joy-media/provider-sdk';
import {
  isDesktopHost,
  signInDesktopProviderProfile,
  type DesktopProviderProfile,
} from './desktop-client.js';

/** The button text per provider. Which providers are offered comes from the registry (PLAN-v4 §6d-1 rule 5, D20). */
const LABELS: Partial<Record<RegistryProviderId, string>> = { chatgpt: 'ChatGPT', minimax: 'MiniMax' };

/** The providers the panel marks as a preview. */
const PREVIEW: Partial<Record<RegistryProviderId, true>> = { chatgpt: true, minimax: true };

/** The order the sign-in buttons appear in. Any provider not named here comes after them. */
const ORDER: readonly RegistryProviderId[] = ['chatgpt', 'minimax'];

/** The rank of a provider in the button order; a provider not named in the order comes last. */
function rank(provider: RegistryProviderId): number {
  const index = ORDER.indexOf(provider);
  return index === -1 ? ORDER.length : index;
}

/**
 * Signs in to a provider in the desktop app. The list comes from the registry, so only a provider that permits a
 * subscription sign-in is offered: under D20 that is ChatGPT and MiniMax, labelled as previews. A provider that is set
 * up with an API key, such as OpenRouter, is never offered here. The browser opens for the sign-in. The key or token is
 * saved by the desktop and is never shown here.
 */
export function ProviderSignInPanel({
  onSignedIn,
}: {
  readonly onSignedIn: (profile: DesktopProviderProfile) => void;
}) {
  const [busy, setBusy] = useState<RegistryProviderId | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [minimaxRegion, setMiniMaxRegion] = useState<MiniMaxRegion>('global');
  const providers = [...signInProviders()].sort((first, second) => rank(first) - rank(second));

  if (!isDesktopHost()) return null;

  const signIn = async (target: RegistryProviderId): Promise<void> => {
    setBusy(target);
    setMessage(undefined);
    try {
      const profile = await signInDesktopProviderProfile({
        provider: target,
        ...(target === 'minimax' ? { region: minimaxRegion } : {}),
      });
      onSignedIn(profile);
      setMessage(`Signed in to ${providerLabel(target)}.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : `The ${providerLabel(target)} sign-in did not complete.`,
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="joy-provider-signin">
      <div className="joy-provider-signin-actions">
        {providers.map((target) => (
          <button
            key={target}
            type="button"
            disabled={busy !== undefined}
            onClick={() => void signIn(target)}
          >
            {`Sign in with ${providerLabel(target)} `}
            {PREVIEW[target] === true ? (
              <span className="joy-provider-signin-preview">(Preview)</span>
            ) : null}
          </button>
        ))}
      </div>
      {providers.includes('minimax') ? (
        <label htmlFor="joy-provider-signin-minimax-region">
          MiniMax account region
          <select
            id="joy-provider-signin-minimax-region"
            aria-label="MiniMax account region"
            disabled={busy !== undefined}
            value={minimaxRegion}
            onChange={(event) => setMiniMaxRegion(event.currentTarget.value as MiniMaxRegion)}
          >
            <option value="global">Global (International)</option>
            <option value="cn">China</option>
          </select>
        </label>
      ) : null}
      {message !== undefined && <p role="status">{message}</p>}
    </div>
  );
}

/** The name a provider is shown under. */
function providerLabel(target: RegistryProviderId): string {
  return LABELS[target] ?? findRegistryProvider(target)?.label ?? target;
}
