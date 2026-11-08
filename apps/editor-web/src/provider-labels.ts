import { findRegistryProvider } from '@joy-media/provider-sdk';

/** The plain names the app shows for a provider. A saved profile is shown by one of these, never by its id. */
const LABELS: Readonly<Record<string, string>> = {
  chatgpt: 'ChatGPT',
  kimi: 'Kimi',
  xai: 'xAI',
};

/** The short name of a provider, such as "ChatGPT". */
export function providerLabel(provider: string): string {
  return LABELS[provider] ?? findRegistryProvider(provider)?.label ?? provider;
}

/** The name a saved profile is shown under: its own name, or the name of its provider. Never its id. */
export function profileLabel(profile: {
  readonly name?: string | undefined;
  readonly provider: string;
}): string {
  const name = profile.name?.trim() ?? '';
  return name === '' ? providerLabel(profile.provider) : name;
}
