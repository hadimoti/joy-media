import type { ProviderApprovalPreflight } from '@joy-media/provider-sdk';

export class BrowserControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly preflight?: ProviderApprovalPreflight,
  ) {
    super(message);
    this.name = 'BrowserControlPlaneError';
  }
}
