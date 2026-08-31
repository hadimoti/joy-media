export type DerivativeKind = 'thumbnail' | 'proxy';
export interface OpaqueFileRef {
  readonly kind: 'local-file';
  readonly id: string;
  readonly displayName: string;
}
export interface FileBoundary {
  registerSelection(path: string, displayName?: string): OpaqueFileRef;
  revoke(ref: OpaqueFileRef): void;
  requestDerivative(
    ref: OpaqueFileRef,
    kind: DerivativeKind,
  ): { refId: string; kind: DerivativeKind };
}
export function createFileBoundary(
  tokenFactory: () => string = () => crypto.randomUUID(),
): FileBoundary {
  const approved = new Set<string>();
  return {
    registerSelection(path, displayName = basename(path)) {
      if (!isAbsolutePath(path) || path.includes('\0'))
        throw new Error('Selection must be an absolute local path');
      const id = tokenFactory();
      approved.add(id);
      return { kind: 'local-file', id, displayName: basename(displayName).slice(0, 255) };
    },
    revoke(ref) {
      approved.delete(ref.id);
    },
    requestDerivative(ref, kind) {
      if (ref.kind !== 'local-file' || !approved.has(ref.id))
        throw new Error('Unknown or revoked local file reference');
      return { refId: ref.id, kind };
    },
  };
}
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}
function basename(value: string): string {
  return value.split(/[\\/]/).pop() || 'selected-file';
}
