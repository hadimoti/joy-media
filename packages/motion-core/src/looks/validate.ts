/**
 * Living Look definition validation (R2 / L2).
 *
 * A definition is trusted code, but it is still checked at load so a
 * malformed or unsafe pack fails closed rather than reaching the compiler:
 *  - stable, unique slot / binding / control ids;
 *  - finite, ordered scalar ranges and keyframe fractions in `[0,1]`;
 *  - every control drives a declared binding, every binding names a declared
 *    slot, every required operation kind is one the compiler can emit;
 *  - portrait and landscape both carry explicit positive constraint values;
 *  - no URL, path, or executable fragment anywhere in the definition.
 */

import {
  LOOK_DEFINITION_SCHEMA_VERSION,
  LOOK_OPERATION_KINDS,
  type LookControl,
  type LookDefinition,
  type LookTemplateDrive,
} from './types.js';

export interface LookDefinitionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

const FORBIDDEN_TEXT = [
  /[a-z][a-z0-9+.-]*:\/\//iu,
  /\bdata:/iu,
  /\bjavascript:/iu,
  /<\/?script\b/iu,
  /\bon[a-z]+\s*=/iu,
  /[$]\{.*\}/u,
  /=>|\bfunction\s*\(/u,
  /\.\.[/\\]/u,
];

function scanForbidden(value: unknown, path: string, out: LookDefinitionDiagnostic[]): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) {
      out.push({
        code: 'LOOK_DEFINITION_FORBIDDEN_TEXT',
        message: 'definition contains a URL, path, or executable fragment',
        path,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbidden(entry, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) scanForbidden(entry, `${path}.${key}`, out);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fractionsValid(fractions: readonly unknown[]): boolean {
  return (
    fractions.length > 0 &&
    fractions.every((f) => isFiniteNumber(f) && f >= 0 && f <= 1) &&
    fractions.every((f, i) => i === 0 || (f as number) > (fractions[i - 1] as number))
  );
}

/** Returns a diagnostic per problem; an empty array means the definition is safe to compile. */
export function validateLookDefinition(definition: LookDefinition): LookDefinitionDiagnostic[] {
  const diagnostics: LookDefinitionDiagnostic[] = [];
  const push = (code: string, message: string, path: string): void => {
    diagnostics.push({ code, message, path });
  };

  if (definition.schemaVersion !== LOOK_DEFINITION_SCHEMA_VERSION) {
    push('LOOK_DEFINITION_SCHEMA_VERSION', 'schemaVersion must be 1', 'schemaVersion');
  }
  if (!ID_PATTERN.test(definition.id)) {
    push('LOOK_DEFINITION_ID', 'id must be a kebab-case token', 'id');
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    push('LOOK_DEFINITION_VERSION', 'version must be a positive integer', 'version');
  }
  if (definition.title.trim().length === 0) {
    push('LOOK_DEFINITION_TITLE', 'title must be non-empty', 'title');
  }

  const slotIds = new Set<string>();
  definition.slots.forEach((slot, index) => {
    if (!ID_PATTERN.test(slot.id) || slotIds.has(slot.id)) {
      push(
        'LOOK_DEFINITION_SLOT_ID',
        `slot id "${slot.id}" is not unique kebab-case`,
        `slots[${index}].id`,
      );
    }
    slotIds.add(slot.id);
  });

  const bindingIds = new Set<string>();
  definition.bindingTargets.forEach((target, index) => {
    const path = `bindingTargets[${index}]`;
    if (!ID_PATTERN.test(target.bindingId) || bindingIds.has(target.bindingId)) {
      push(
        'LOOK_DEFINITION_BINDING_ID',
        `bindingId "${target.bindingId}" is not unique kebab-case`,
        `${path}.bindingId`,
      );
    }
    bindingIds.add(target.bindingId);
    if (!slotIds.has(target.ownerSlotId)) {
      push(
        'LOOK_DEFINITION_BINDING_SLOT',
        `binding target names unknown slot "${target.ownerSlotId}"`,
        `${path}.ownerSlotId`,
      );
    }
    if (target.propertyId.trim().length === 0) {
      push(
        'LOOK_DEFINITION_BINDING_PROPERTY',
        'binding propertyId must be non-empty',
        `${path}.propertyId`,
      );
    }
  });

  const controlIds = new Set<string>();
  definition.controls.forEach((control, index) => {
    const path = `controls[${index}]`;
    if (!ID_PATTERN.test(control.id) || controlIds.has(control.id)) {
      push(
        'LOOK_DEFINITION_CONTROL_ID',
        `control id "${control.id}" is not unique kebab-case`,
        `${path}.id`,
      );
    }
    controlIds.add(control.id);
    validateControl(control, path, bindingIds, definition, push);
  });

  for (const kind of definition.requiredOperationKinds) {
    if (!(LOOK_OPERATION_KINDS as readonly string[]).includes(kind)) {
      push(
        'LOOK_DEFINITION_OPERATION_KIND',
        `requiredOperationKinds contains "${kind}"`,
        'requiredOperationKinds',
      );
    }
  }

  for (const format of ['portrait', 'landscape'] as const) {
    const c = definition.constraints[format];
    if (!isFiniteNumber(c.safeMarginPx) || c.safeMarginPx < 0) {
      push(
        'LOOK_DEFINITION_CONSTRAINT',
        `${format}.safeMarginPx must be a non-negative number`,
        `constraints.${format}.safeMarginPx`,
      );
    }
    if (!Number.isInteger(c.maxHeadlineChars) || c.maxHeadlineChars < 1) {
      push(
        'LOOK_DEFINITION_CONSTRAINT',
        `${format}.maxHeadlineChars must be a positive integer`,
        `constraints.${format}.maxHeadlineChars`,
      );
    }
    if (!isFiniteNumber(c.minHoldUs) || c.minHoldUs <= 0) {
      push(
        'LOOK_DEFINITION_CONSTRAINT',
        `${format}.minHoldUs must be a positive number`,
        `constraints.${format}.minHoldUs`,
      );
    }
  }

  if (definition.provenance.license.trim().length === 0) {
    push('LOOK_DEFINITION_LICENSE', 'provenance.license must be non-empty', 'provenance.license');
  }

  const verificationIds = new Set<string>();
  definition.verification.forEach((predicate, index) => {
    if (!ID_PATTERN.test(predicate.id) || verificationIds.has(predicate.id)) {
      push(
        'LOOK_DEFINITION_VERIFICATION_ID',
        `verification id "${predicate.id}" is not unique kebab-case`,
        `verification[${index}].id`,
      );
    }
    verificationIds.add(predicate.id);
  });

  scanForbidden(definition, '', diagnostics);
  return diagnostics;
}

function validateControl(
  control: LookControl,
  path: string,
  bindingIds: ReadonlySet<string>,
  definition: LookDefinition,
  push: (code: string, message: string, path: string) => void,
): void {
  const requireBinding = (bindingId: string, subPath: string): void => {
    if (!bindingIds.has(bindingId)) {
      push(
        'LOOK_DEFINITION_CONTROL_BINDING',
        `control drives unknown binding "${bindingId}"`,
        subPath,
      );
    }
  };

  switch (control.kind) {
    case 'scalar': {
      if (!isFiniteNumber(control.default) || control.default < 0 || control.default > 1) {
        push(
          'LOOK_DEFINITION_CONTROL_DEFAULT',
          'scalar default must be in [0,1]',
          `${path}.default`,
        );
      }
      if (control.drives.length === 0) {
        push(
          'LOOK_DEFINITION_CONTROL_DRIVES',
          'a scalar control with no effect is a fake slider — omit it',
          `${path}.drives`,
        );
      }
      control.drives.forEach((drive, i) => {
        const dp = `${path}.drives[${i}]`;
        requireBinding(drive.bindingId, `${dp}.bindingId`);
        if (!isFiniteNumber(drive.min) || !isFiniteNumber(drive.max) || drive.min > drive.max) {
          push(
            'LOOK_DEFINITION_CONTROL_RANGE',
            'scalar drive range must be finite and ordered',
            dp,
          );
        }
        if (!fractionsValid(drive.atFractions)) {
          push(
            'LOOK_DEFINITION_CONTROL_FRACTIONS',
            'atFractions must be strictly increasing values in [0,1]',
            `${dp}.atFractions`,
          );
        }
      });
      break;
    }
    case 'enum': {
      if (control.options.length < 2 || !control.options.includes(control.default)) {
        push(
          'LOOK_DEFINITION_CONTROL_ENUM',
          'enum needs >=2 options and a default among them',
          `${path}.options`,
        );
      }
      control.drives.forEach((drive, i) => {
        const dp = `${path}.drives[${i}]`;
        requireBinding(drive.bindingId, `${dp}.bindingId`);
        for (const option of control.options) {
          if (!isFiniteNumber(drive.byOption[option])) {
            push(
              'LOOK_DEFINITION_CONTROL_ENUM_VALUE',
              `enum drive missing finite value for option "${option}"`,
              dp,
            );
          }
        }
        if (!fractionsValid(drive.atFractions)) {
          push(
            'LOOK_DEFINITION_CONTROL_FRACTIONS',
            'atFractions must be strictly increasing values in [0,1]',
            `${dp}.atFractions`,
          );
        }
      });
      break;
    }
    case 'color': {
      if (
        control.palettePairs.length === 0 ||
        !control.palettePairs.some((p) => p.id === control.default)
      ) {
        push(
          'LOOK_DEFINITION_CONTROL_COLOR',
          'color control needs palette pairs and a default among them',
          `${path}.palettePairs`,
        );
      }
      control.palettePairs.forEach((pair, i) => {
        if (!HEX_COLOR.test(pair.foreground) || !HEX_COLOR.test(pair.background)) {
          push(
            'LOOK_DEFINITION_CONTROL_COLOR_HEX',
            'palette pair colours must be #rgb / #rrggbb',
            `${path}.palettePairs[${i}]`,
          );
        }
      });
      validateTemplateDrives(
        control.drives,
        control.palettePairs.map((p) => p.id),
        `${path}.drives`,
        bindingIds,
        push,
      );
      break;
    }
    case 'font': {
      const catalogue = new Set(definition.requiredFonts);
      if (control.families.length === 0 || !control.families.includes(control.default)) {
        push(
          'LOOK_DEFINITION_CONTROL_FONT',
          'font control needs families and a default among them',
          `${path}.families`,
        );
      }
      for (const family of control.families) {
        if (!catalogue.has(family)) {
          push(
            'LOOK_DEFINITION_CONTROL_FONT_DEP',
            `font "${family}" must also be in requiredFonts`,
            `${path}.families`,
          );
        }
      }
      validateTemplateDrives(control.drives, control.families, `${path}.drives`, bindingIds, push);
      break;
    }
    case 'boolean':
      break;
    default: {
      const exhaustive: never = control;
      void exhaustive;
    }
  }
}

function validateTemplateDrives(
  drives: readonly LookTemplateDrive[] | undefined,
  options: readonly string[],
  path: string,
  bindingIds: ReadonlySet<string>,
  push: (code: string, message: string, path: string) => void,
): void {
  if (drives === undefined) return;
  drives.forEach((drive, i) => {
    const dp = `${path}[${i}]`;
    if (!bindingIds.has(drive.bindingId)) {
      push(
        'LOOK_DEFINITION_CONTROL_BINDING',
        `template drive names unknown binding "${drive.bindingId}"`,
        `${dp}.bindingId`,
      );
    }
    for (const option of options) {
      const templateId = drive.templateByOption[option];
      if (typeof templateId !== 'string' || templateId.trim().length === 0) {
        push(
          'LOOK_DEFINITION_CONTROL_TEMPLATE',
          `template drive missing a template id for option "${option}"`,
          dp,
        );
      }
    }
  });
}
