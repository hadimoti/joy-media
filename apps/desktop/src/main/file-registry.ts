import { createFileBoundary } from '../file-boundary.js';
import type { DerivativeKind, FileBoundary, OpaqueFileRef } from '../file-boundary.js';

/**
 * Main-process-only wrapper around the shared {@link FileBoundary} policy.
 *
 * `createFileBoundary` deliberately never stores the real path anywhere it
 * returns to the caller: the opaque ref is the only thing that may travel
 * across the preload bridge. This registry keeps the id -> real-path mapping
 * on the trusted (main-process) side so the Worker supervisor and media
 * ingest pipeline can resolve a ref back to a real path. Nothing in this
 * module is reachable from the renderer or preload context.
 */
export interface FileRegistry extends FileBoundary {
  /** Main-process-only. Throws if the ref is unknown or was revoked. */
  resolvePath(ref: OpaqueFileRef): string;
}

export function createFileRegistry(tokenFactory?: () => string): FileRegistry {
  const boundary = createFileBoundary(tokenFactory);
  const paths = new Map<string, string>();

  return {
    registerSelection(path, displayName) {
      const ref = boundary.registerSelection(path, displayName);
      paths.set(ref.id, path);
      return ref;
    },
    revoke(ref) {
      boundary.revoke(ref);
      paths.delete(ref.id);
    },
    requestDerivative(ref: OpaqueFileRef, kind: DerivativeKind) {
      return boundary.requestDerivative(ref, kind);
    },
    resolvePath(ref) {
      const path = paths.get(ref.id);
      if (ref.kind !== 'local-file' || path === undefined) {
        throw new Error('Unknown or revoked local file reference');
      }
      return path;
    },
  };
}
