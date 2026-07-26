/**
 * Schema validation and migration for MotionSceneDocument.
 */

import type { MotionSceneDocument } from './scene.js';
import { CURRENT_SCENE_SCHEMA_VERSION } from './scene.js';

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

export function validateMotionSceneDocument(
  doc: unknown,
): readonly SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  if (doc === null || typeof doc !== 'object') {
    errors.push({ path: '', message: 'document must be an object' });
    return errors;
  }
  const d = doc as Record<string, unknown>;
  if (typeof d.schemaVersion !== 'number')
    errors.push({ path: 'schemaVersion', message: 'must be a number' });
  if (typeof d.id !== 'string' || d.id.length === 0)
    errors.push({ path: 'id', message: 'must be a non-empty string' });
  if (typeof d.name !== 'string')
    errors.push({ path: 'name', message: 'must be a string' });
  if (typeof d.width !== 'number' || d.width <= 0)
    errors.push({ path: 'width', message: 'must be a positive number' });
  if (typeof d.height !== 'number' || d.height <= 0)
    errors.push({ path: 'height', message: 'must be a positive number' });
  if (typeof d.durationMs !== 'number' || d.durationMs <= 0)
    errors.push({ path: 'durationMs', message: 'must be a positive number' });
  if (!Array.isArray(d.layers))
    errors.push({ path: 'layers', message: 'must be an array' });
  if (!Array.isArray(d.variables))
    errors.push({ path: 'variables', message: 'must be an array' });
  if (!Array.isArray(d.components))
    errors.push({ path: 'components', message: 'must be an array' });
  if (!Array.isArray(d.markers))
    errors.push({ path: 'markers', message: 'must be an array' });
  return errors;
}

export function migrateSceneDocument(
  doc: MotionSceneDocument,
): MotionSceneDocument {
  if (doc.schemaVersion >= CURRENT_SCENE_SCHEMA_VERSION) return doc;
  let migrated = { ...doc };
  if (doc.schemaVersion < 1) {
    migrated = { ...migrated, schemaVersion: 1 };
  }
  return migrated;
}
