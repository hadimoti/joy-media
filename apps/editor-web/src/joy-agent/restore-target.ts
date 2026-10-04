import type { DesktopProviderProfile } from '../desktop-client.js';

export type JoyAgentRestoreTarget =
  | { readonly kind: 'joy-hosted'; readonly token: string }
  | { readonly kind: 'wait-for-sign-in' }
  | { readonly kind: 'profile'; readonly profile: DesktopProviderProfile }
  | { readonly kind: 'none' };

export function chooseJoyAgentRestoreTarget(input: {
  readonly profiles: readonly DesktopProviderProfile[];
  readonly token?: string;
  readonly lastPreset?: 'dual-brain' | 'joy-hosted' | 'custom';
}): JoyAgentRestoreTarget {
  if (
    (input.lastPreset === 'joy-hosted' || input.lastPreset === undefined) &&
    input.token !== undefined
  ) {
    return { kind: 'joy-hosted', token: input.token };
  }
  if (input.lastPreset === 'joy-hosted') return { kind: 'wait-for-sign-in' };
  const profile =
    input.profiles.find((item) => item.provider === 'openrouter') ?? input.profiles[0];
  return profile === undefined ? { kind: 'none' } : { kind: 'profile', profile };
}
