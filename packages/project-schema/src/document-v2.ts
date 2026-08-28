/**
 * The transport document used by the durable project spine.
 *
 * This is intentionally a small envelope around the existing creative
 * schemas.  The editor is still migrating its two local documents into one
 * canonical document, so the named domains are JSON values rather than a
 * second copy of every editor type.  Media bytes and filesystem paths are
 * never part of this contract; assets are represented by opaque references.
 */

import type { ProjectDiagnostic } from './model.js';
import type { JsonValue } from './v1.js';

export interface ProjectDocumentV2 {
  readonly schemaVersion: 2;
  readonly projectId: string;
  readonly title?: string;
  readonly timeline?: JsonValue;
  readonly tracks?: JsonValue;
  readonly clips?: JsonValue;
  readonly assets?: JsonValue;
  readonly captions?: JsonValue;
  readonly audio?: JsonValue;
  readonly color?: JsonValue;
  readonly effects?: JsonValue;
  readonly motion?: JsonValue;
  readonly templates?: JsonValue;
  readonly exportSettings?: JsonValue;
  readonly [domain: string]: JsonValue | undefined;
}

// Reject transport/storage-bearing fields while allowing opaque references
// such as assetRef/mediaRef and ordinary domain keys such as mediaType.
const FORBIDDEN_KEYS =
  /^(?:raw(?:Media|Bytes)?|media|bytes|base64|buffer|blob|path|url|uri|locations|cloudRef|localRef|objectKey|credentials?|secret|clientSecret|apiKey|privateKey|password|authorization|accessToken|refreshToken|sessionToken|bearerToken|pairingCode|.*(?:Path|Url|Uri|Bytes|Base64|Buffer|Blob|MediaData))$/i;
const MAX_DEPTH = 32;
const MAX_NODES = 50_000;
const MAX_STRING_LENGTH = 16_384;

/**
 * Validates the bounded JSON envelope and rejects common accidental media
 * leaks. Numeric byte counts and opaque `ref` fields remain valid metadata.
 */
export function validateProjectDocumentV2(value: unknown): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      { code: 'PROJECT_DOCUMENT_V2_OBJECT', message: 'document must be an object', path: '' },
    ];
  }
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 2)
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_V2_VERSION',
      message: 'document schemaVersion must be 2',
      path: 'schemaVersion',
    });
  if (
    typeof root.projectId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(root.projectId)
  )
    diagnostics.push({
      code: 'PROJECT_DOCUMENT_V2_PROJECT_ID',
      message: 'document projectId must be an opaque project identifier',
      path: 'projectId',
    });

  let nodes = 0;
  const visit = (entry: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES) {
      diagnostics.push({
        code: 'PROJECT_DOCUMENT_V2_NODES',
        message: 'document has too many values',
        path,
      });
      return;
    }
    if (depth > MAX_DEPTH) {
      diagnostics.push({
        code: 'PROJECT_DOCUMENT_V2_DEPTH',
        message: 'document nesting is too deep',
        path,
      });
      return;
    }
    if (typeof entry === 'string') {
      if (entry.length > MAX_STRING_LENGTH)
        diagnostics.push({
          code: 'PROJECT_DOCUMENT_V2_STRING',
          message: 'document string is too long',
          path,
        });
      return;
    }
    if (entry === null || typeof entry !== 'object') return;
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(key)) {
        diagnostics.push({
          code: 'PROJECT_DOCUMENT_V2_MEDIA_BYTES',
          message: `document contains a forbidden media/storage field: ${key}`,
          path: path.length === 0 ? key : `${path}.${key}`,
        });
      }
      visit(child, path.length === 0 ? key : `${path}.${key}`, depth + 1);
    }
  };
  visit(value, '', 0);
  return diagnostics;
}
