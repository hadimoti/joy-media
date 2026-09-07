import { describe, expect, it } from 'vitest';
import { BUILT_IN_LOOK_PACKS } from '@joy-media/motion-core';
import { JOY_CAPTION_TEMPLATES } from '@joy-media/captions-core';
import { CONTENT_FONT_FAMILIES } from '@joy-media/project-schema';
import { JOY_CODE_OPERATION_KINDS } from '@joy-media/agent-tools';
import { TEXT_TEMPLATES } from '../text-template-catalog.js';
import { catalog, prepareLookPlan } from './look-operations.js';
import type { LookCompileInput, LookControl } from '@joy-media/motion-core';

const TEXT_IDS = new Set(TEXT_TEMPLATES.map((t) => t.id));
const CAPTION_IDS = new Set(JOY_CAPTION_TEMPLATES.map((t) => t.id));

function templateDrivesOf(control: LookControl) {
  if (control.kind === 'color' || control.kind === 'font') return control.drives;
  if (control.kind === 'enum') return control.templateDrives ?? [];
  return [];
}

describe('built-in Look packs — host conformance', () => {
  it('every pack template id resolves against the real text / caption catalogues', () => {
    for (const pack of BUILT_IN_LOOK_PACKS) {
      for (const control of pack.controls) {
        for (const drive of templateDrivesOf(control)) {
          const known = drive.target === 'text' ? TEXT_IDS : CAPTION_IDS;
          for (const templateId of Object.values(drive.templateByOption)) {
            expect(known.has(templateId), `${pack.id}/${control.id} -> ${templateId}`).toBe(true);
          }
        }
      }
    }
  });

  it('every pack required font is in the bundled OFL content-font catalogue', () => {
    for (const pack of BUILT_IN_LOOK_PACKS) {
      for (const family of pack.requiredFonts) {
        expect(CONTENT_FONT_FAMILIES as readonly string[]).toContain(family);
      }
    }
  });

  it('the catalog() availability check marks every built-in pack available in the shipped editor', () => {
    const entries = catalog(BUILT_IN_LOOK_PACKS, {
      availableOperationKinds: JOY_CODE_OPERATION_KINDS,
      availableFonts: CONTENT_FONT_FAMILIES as readonly string[],
    });
    for (const entry of entries) {
      expect(entry.definitionDiagnostics, entry.definition.id).toEqual([]);
      expect(entry.missingOperationKinds, entry.definition.id).toEqual([]);
      expect(entry.missingFonts, entry.definition.id).toEqual([]);
      expect(entry.available, entry.definition.id).toBe(true);
    }
  });

  it('every pack produces a canonical plan whose ops are all in the allowlist on a full first apply', () => {
    for (const pack of BUILT_IN_LOOK_PACKS) {
      const input: LookCompileInput = {
        definition: pack,
        definitionVersion: pack.version,
        compositionId: 'root',
        compositionDurationUs: 8_000_000,
        format: 'portrait',
        entityBindings: Object.fromEntries(pack.slots.map((s) => [s.id, `e-${s.id}`])),
        controlValues: {},
        overriddenBindingIds: [],
        resolvedFonts: Object.fromEntries(pack.requiredFonts.map((f) => [f, f])),
      };
      const { ok, plan } = prepareLookPlan(input, `apply ${pack.title}`);
      expect(ok, pack.id).toBe(true);
      for (const op of plan!.operations) {
        expect(JOY_CODE_OPERATION_KINDS as readonly string[]).toContain(op.kind);
      }
    }
  });
});
