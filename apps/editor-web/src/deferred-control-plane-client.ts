import type { BrowserControlPlaneClient } from './control-plane-client.js';

/** Keeps the authenticated remote client out of the local editor shell bundle. */
export function createDeferredControlPlaneClient(): BrowserControlPlaneClient {
  const clientPromise = import('./control-plane-client.js').then(
    ({ BrowserControlPlaneClient: Client }) => new Client(),
  );
  return new Proxy({} as BrowserControlPlaneClient, {
    get:
      (_target, property: string) =>
      (...args: readonly unknown[]) =>
        clientPromise.then((client) => {
          const method = Reflect.get(client, property);
          if (typeof method !== 'function') return method;
          return Reflect.apply(method, client, args);
        }),
  });
}
