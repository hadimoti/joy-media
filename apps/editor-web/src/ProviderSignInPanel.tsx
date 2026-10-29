import { useState } from 'react';
import {
  isDesktopHost,
  signInDesktopProviderProfile,
  type DesktopProviderProfile,
} from './desktop-client.js';

type SignInTarget = 'openrouter' | 'chatgpt';

const LABELS: Record<SignInTarget, string> = { openrouter: 'OpenRouter', chatgpt: 'ChatGPT' };

/**
 * Signs in to a provider in the desktop app: OpenRouter, or ChatGPT, which is labelled as a preview (PLAN-v4 §6d). The
 * browser opens for the sign-in. The key or token is saved by the desktop and is never shown here.
 */
export function ProviderSignInPanel({
  onSignedIn,
}: {
  readonly onSignedIn: (profile: DesktopProviderProfile) => void;
}) {
  const [busy, setBusy] = useState<SignInTarget | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);

  if (!isDesktopHost()) return null;

  const signIn = async (target: SignInTarget): Promise<void> => {
    setBusy(target);
    setMessage(undefined);
    try {
      const profile = await signInDesktopProviderProfile({ provider: target });
      onSignedIn(profile);
      setMessage(`Signed in to ${LABELS[target]}.`);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : `The ${LABELS[target]} sign-in did not complete.`,
      );
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="joy-provider-signin">
      <div className="joy-provider-signin-actions">
        <button
          type="button"
          disabled={busy !== undefined}
          onClick={() => void signIn('openrouter')}
        >
          Sign in with OpenRouter
        </button>
        <button type="button" disabled={busy !== undefined} onClick={() => void signIn('chatgpt')}>
          Sign in with ChatGPT <span className="joy-provider-signin-preview">(Preview)</span>
        </button>
      </div>
      {message !== undefined && <p role="status">{message}</p>}
    </div>
  );
}
