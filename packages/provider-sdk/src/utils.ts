import type {
  AnyProvider,
  CapabilityId,
  CapabilityDeclaration,
  Money,
  ProviderV2,
} from './types.js';

export function isV2Provider(provider: AnyProvider): provider is ProviderV2 {
  return 'protocolVersion' in provider.manifest;
}

export function getProviderId(provider: AnyProvider): string {
  return provider.manifest.id;
}

export function getCapabilityIds(provider: AnyProvider): readonly CapabilityId[] {
  if (isV2Provider(provider)) {
    return provider.manifest.capabilities.map((c) => c.id);
  }
  return provider.manifest.capabilities;
}

export function supportsCapability(provider: AnyProvider, capability: CapabilityId): boolean {
  if (isV2Provider(provider)) {
    return provider.manifest.capabilities.some((c) => c.id === capability);
  }
  return (
    capability === 'speech.transcribe' &&
    provider.manifest.capabilities.includes('speech.transcribe')
  );
}

export function getExecution(
  provider: AnyProvider,
): 'worker-local' | 'remote-api' | 'server' | 'browser' {
  if (isV2Provider(provider)) {
    return provider.manifest.execution;
  }
  return 'worker-local';
}

export function getDataLeavesDevice(provider: AnyProvider): boolean | 'depends' {
  if (isV2Provider(provider)) {
    return provider.manifest.privacy.dataLeavesDevice;
  }
  return false;
}

export function getAdapterVersion(provider: AnyProvider): string {
  if (isV2Provider(provider)) {
    return provider.manifest.adapterVersion;
  }
  return '1.0.0';
}

export function getModelVersions(provider: AnyProvider): readonly string[] | undefined {
  if (!isV2Provider(provider)) {
    return undefined;
  }
  const versions: string[] = [];
  for (const cap of provider.manifest.capabilities) {
    if (cap.models) {
      for (const model of cap.models) {
        if (model.version) {
          versions.push(model.version);
        }
      }
    }
  }
  return versions.length > 0 ? versions : undefined;
}

export function getCapabilityDeclaration(
  provider: AnyProvider,
  capability: CapabilityId,
): CapabilityDeclaration | undefined {
  if (!isV2Provider(provider)) {
    return undefined;
  }
  return provider.manifest.capabilities.find((c) => c.id === capability);
}

export function isLocalExecution(exec: string): boolean {
  return exec === 'worker-local' || exec === 'browser';
}

export function isRemoteExecution(exec: string): boolean {
  return exec === 'remote-api' || exec === 'server';
}

export function compareMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) {
    return 0;
  }
  return parseFloat(a.amount) - parseFloat(b.amount);
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add money with different currencies: ${a.currency} vs ${b.currency}`);
  }
  const sum = parseFloat(a.amount) + parseFloat(b.amount);
  return { amount: sum.toFixed(2), currency: a.currency };
}
