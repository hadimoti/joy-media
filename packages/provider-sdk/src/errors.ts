export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
