/** Stable public API surface frozen for Plugin SDK v1 (§24.6). */

export const PLUGIN_API_VERSION = '1.0.0' as const;

/**
 * Extension capabilities intentionally available in v1. New capabilities must
 * be additive, independently detectable, and accompanied by fixtures.
 */
export const PLUGIN_CAPABILITIES = ['ui.panel', 'caption.pack.data', 'provider.adapter'] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface PluginSdkHost {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly capabilities: ReadonlySet<PluginCapability>;
  supports(capability: PluginCapability): boolean;
  require(capability: PluginCapability): void;
}

/** Returned when a plugin calls an unavailable optional capability. */
export class PluginCapabilityUnavailableError extends Error {
  readonly code = 'plugin/capability-unavailable';

  constructor(readonly capability: PluginCapability) {
    super(`plugin capability "${capability}" is unavailable in this JOY host`);
    this.name = 'PluginCapabilityUnavailableError';
  }
}

/** Creates the minimal, capability-gated host facade exposed to a plugin. */
export function createPluginSdkHost(
  capabilities: Iterable<PluginCapability> = PLUGIN_CAPABILITIES,
): PluginSdkHost {
  const available = new Set<PluginCapability>();
  for (const capability of capabilities) {
    if (!(PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new RangeError(`unknown Plugin SDK capability "${capability}"`);
    }
    available.add(capability);
  }
  return Object.freeze({
    apiVersion: PLUGIN_API_VERSION,
    capabilities: immutableSet(available),
    supports: (capability: PluginCapability): boolean => available.has(capability),
    require: (capability: PluginCapability): void => {
      if (!available.has(capability)) throw new PluginCapabilityUnavailableError(capability);
    },
  });
}

/** Avoids exposing Set#add/delete through a value that plugins can reach. */
function immutableSet<T>(values: ReadonlySet<T>): ReadonlySet<T> {
  const facade: ReadonlySet<T> = Object.freeze({
    get size(): number {
      return values.size;
    },
    has: (value: T): boolean => values.has(value),
    entries: (): SetIterator<[T, T]> => values.entries(),
    keys: (): SetIterator<T> => values.keys(),
    values: (): SetIterator<T> => values.values(),
    forEach: (callback: (value: T, valueAgain: T, set: ReadonlySet<T>) => void): void => {
      values.forEach((value) => callback(value, value, facade));
    },
    [Symbol.iterator]: (): SetIterator<T> => values[Symbol.iterator](),
  });
  return facade;
}
