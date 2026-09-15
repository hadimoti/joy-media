import { describe, expect, it } from 'vitest';
import {
  LEGACY_EDITOR_RETIREMENT_ENV_VAR,
  readLegacyEditorRetired,
} from './legacy-editor-retirement.js';

describe('readLegacyEditorRetired', () => {
  it('defaults to false on an empty environment', () => {
    expect(readLegacyEditorRetired({})).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    expect(readLegacyEditorRetired({ [LEGACY_EDITOR_RETIREMENT_ENV_VAR]: 'true' })).toBe(true);
    expect(readLegacyEditorRetired({ [LEGACY_EDITOR_RETIREMENT_ENV_VAR]: 'TRUE' })).toBe(false);
    expect(readLegacyEditorRetired({ [LEGACY_EDITOR_RETIREMENT_ENV_VAR]: '1' })).toBe(false);
    expect(readLegacyEditorRetired({ [LEGACY_EDITOR_RETIREMENT_ENV_VAR]: undefined })).toBe(false);
  });
});
