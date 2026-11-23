/**
 * TL-03 Inspector numeric inventory.
 *
 * One case per numeric Inspector field, as data only. A live driver reads these
 * cases and runs the shared NUMERIC_ACTION_CHECKLIST against each one. Nothing
 * here launches the app or touches a page.
 *
 * Each case carries:
 *  - section and control (key = `${section}/${control}` is unique),
 *  - the exact input identity (DOM id or container + label text) and the source
 *    file and marker that define it, so a test can catch drift,
 *  - min/max/step/defaultValue in the units the input shows,
 *  - animation flags (animatable = keyframe button, expressionable = ƒx button).
 *
 * Non-numeric controls (scale-link checkbox, expression text box, speed preset
 * buttons, ramp buttons, decontaminate and invert checkboxes, the masking model
 * select) are deliberately not cases.
 */

export const INSPECTOR_NUMERIC_SECTIONS = Object.freeze([
  'Transform',
  'Adjust',
  'Crop',
  'Audio',
  'Speed',
  'Mask',
]);

const INSPECTOR_SOURCE = 'apps/editor-web/src/InspectorPanel.tsx';
const MASK_SOURCE = 'apps/editor-web/src/MaskInspector.tsx';
const EFFECTS_SOURCE = 'packages/visual-effects/src/builtin/registerBuiltins.ts';

/**
 * The shared action checklist. Every numeric case runs these items. The keyframe
 * item applies only where the case is animatable.
 */
export const NUMERIC_ACTION_CHECKLIST = Object.freeze([
  Object.freeze({ id: 'typing', label: 'Type a value and commit with Enter or blur' }),
  Object.freeze({ id: 'arrows', label: 'Arrow Up and Down step by the control step' }),
  Object.freeze({ id: 'spinner', label: 'Native spinner buttons step by the control step' }),
  Object.freeze({ id: 'wheel', label: 'Mouse wheel over the focused field' }),
  Object.freeze({ id: 'bounds', label: 'Entries beyond min or max are clamped or refused' }),
  Object.freeze({ id: 'drag-right', label: 'Drag the value right to increase it' }),
  Object.freeze({ id: 'drag-left', label: 'Drag the value left to decrease it' }),
  Object.freeze({ id: 'cancel', label: 'Escape or a cancelled drag restores the committed value' }),
  Object.freeze({
    id: 'keyframe',
    label: 'Add and remove a keyframe on the value',
    requiresAnimatable: true,
  }),
  Object.freeze({ id: 'undo-redo', label: 'One Undo and one Redo restore value and keyframes' }),
]);

/**
 * The five Adjust-layer numeric parameters, copied from the built-in descriptors
 * the Adjust layer applies (adjustment-layer.ts). registerBuiltins.test checks
 * the copy against the source file.
 */
export const ADJUST_LAYER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'brightness-contrast',
    params: Object.freeze([
      Object.freeze({
        key: 'brightness',
        label: 'Brightness',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        unit: '',
        animatable: true,
      }),
      Object.freeze({
        key: 'contrast',
        label: 'Contrast',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        unit: '',
        animatable: true,
      }),
    ]),
  }),
  Object.freeze({
    id: 'hue-saturation',
    params: Object.freeze([
      Object.freeze({
        key: 'hue',
        label: 'Hue',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        unit: 'turn',
        animatable: true,
      }),
      Object.freeze({
        key: 'saturation',
        label: 'Saturation',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        animatable: true,
      }),
    ]),
  }),
  Object.freeze({
    id: 'vibrance',
    params: Object.freeze([
      Object.freeze({
        key: 'amount',
        label: 'Amount',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        animatable: true,
      }),
    ]),
  }),
]);

/**
 * Expands effect descriptors into one case per numeric param. Non-number params
 * (boolean, vector2, and anything else) are skipped. A descriptor with no
 * numeric params yields nothing.
 *
 * @param {ReadonlyArray<{id: string, params?: ReadonlyArray<object>}>} descriptors
 * @param {{section?: string}} [options]
 */
export function expandEffectNumberCases(descriptors, { section = 'Adjust' } = {}) {
  const cases = [];
  for (const descriptor of descriptors) {
    for (const param of descriptor.params ?? []) {
      if (param.type !== 'number') continue;
      const control = `${descriptor.id}.${param.key}`;
      cases.push(
        buildCase({
          section,
          control,
          label: param.label,
          input: {
            id: null,
            ariaLabel: `${param.label} value`,
            idPattern: `effect-<instanceId>-${param.key}`,
            source: INSPECTOR_SOURCE,
            marker: 'effect-${effect.id}-${param.key}',
          },
          min: param.min ?? null,
          max: param.max ?? null,
          step: param.step ?? null,
          defaultValue: param.defaultValue,
          unit: param.unit ?? '',
          animatable: param.animatable === true,
          expressionable: false,
          descriptorId: descriptor.id,
          paramKey: param.key,
        }),
      );
    }
  }
  return cases;
}

function buildCase({
  section,
  control,
  label,
  input,
  min,
  max,
  step,
  defaultValue,
  unit = '',
  animatable,
  expressionable,
  ...extra
}) {
  return Object.freeze({
    key: `${section}/${control}`,
    section,
    control,
    label,
    type: 'number',
    input: Object.freeze({ ...input }),
    min,
    max,
    step,
    defaultValue,
    unit,
    animatable,
    expressionable,
    actions: NUMERIC_ACTION_CHECKLIST,
    ...extra,
  });
}

const TRANSFORM_CASES = [
  transform('x', 'Position X', null, null, 0),
  transform('y', 'Position Y', null, null, 0),
  transform('scaleX', 'Scale X', 0.001, null, 1),
  transform('scaleY', 'Scale Y', 0.001, null, 1),
  transform('rotationDeg', 'Rotation', null, null, 0),
];

function transform(key, label, min, max, defaultValue) {
  return buildCase({
    section: 'Transform',
    control: key,
    label,
    input: {
      id: `insp-${key}`,
      ariaLabel: label,
      source: INSPECTOR_SOURCE,
      marker: 'id={`insp-${property.key}`}',
    },
    min,
    max,
    step: 1,
    defaultValue,
    unit: '',
    animatable: true,
    expressionable: true,
  });
}

const OPACITY_CASE = buildCase({
  section: 'Transform',
  control: 'opacity',
  label: 'Opacity',
  input: {
    id: 'insp-opacity',
    ariaLabel: 'Opacity',
    source: INSPECTOR_SOURCE,
    marker: 'id={`insp-${property.key}`}',
  },
  // The field shows percent; the stored value is 0..1.
  min: 0,
  max: 100,
  step: 1,
  defaultValue: 100,
  unit: '%',
  animatable: true,
  expressionable: true,
  stored: Object.freeze({ min: 0, max: 1, defaultValue: 1, displayScale: 100 }),
});

const CROP_CASES = ['left', 'top', 'right', 'bottom'].map((edge) =>
  buildCase({
    section: 'Crop',
    control: edge,
    label: edge,
    input: {
      id: `crop-${edge}`,
      ariaLabel: null,
      source: INSPECTOR_SOURCE,
      marker: 'id={`crop-${edge}`}',
    },
    min: 0,
    max: 0.49,
    step: 0.01,
    defaultValue: 0,
    unit: '',
    animatable: false,
    expressionable: false,
  }),
);

const AUDIO_CASES = [
  buildCase({
    section: 'Audio',
    control: 'volume',
    label: 'Volume',
    input: { id: 'insp-gain', ariaLabel: null, source: INSPECTOR_SOURCE, marker: 'id="insp-gain"' },
    min: 0,
    max: 2,
    step: 0.01,
    defaultValue: 1,
    unit: '',
    animatable: true,
    expressionable: false,
  }),
  buildCase({
    section: 'Audio',
    control: 'pan',
    label: 'Pan',
    input: { id: 'insp-pan', ariaLabel: null, source: INSPECTOR_SOURCE, marker: 'id="insp-pan"' },
    min: -1,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    unit: '',
    animatable: true,
    expressionable: false,
  }),
];

const SPEED_CASES = [
  buildCase({
    section: 'Speed',
    control: 'rate',
    label: 'Rate',
    input: {
      id: 'insp-speed-rate-<clipId>',
      ariaLabel: null,
      source: INSPECTOR_SOURCE,
      marker: 'insp-speed-rate-',
    },
    min: 0.1,
    max: 8,
    step: 0.05,
    defaultValue: 1,
    unit: '',
    animatable: false,
    expressionable: false,
    // With reverse support the input minimum is -8 (MAX_INSPECTOR_SPEED_RATE).
    reverseMin: -8,
  }),
  buildCase({
    section: 'Speed',
    control: 'remap-start',
    label: 'Start source µs',
    input: {
      id: 'insp-remap-start-<clipId>',
      ariaLabel: null,
      source: INSPECTOR_SOURCE,
      marker: 'insp-remap-start-',
    },
    min: 0,
    max: null,
    step: 1,
    // The default is the clip's source in-point, so it has no fixed value.
    defaultValue: null,
    unit: 'µs',
    animatable: false,
    expressionable: false,
  }),
  buildCase({
    section: 'Speed',
    control: 'remap-end',
    label: 'End source µs',
    input: {
      id: 'insp-remap-end-<clipId>',
      ariaLabel: null,
      source: INSPECTOR_SOURCE,
      marker: 'insp-remap-end-',
    },
    min: 0,
    max: null,
    step: 1,
    defaultValue: null,
    unit: 'µs',
    animatable: false,
    expressionable: false,
  }),
];

const MASK_CASES = [
  maskCoordinate('points', 'x', 'X', 'mask-coordinate-editor', 0.5),
  maskCoordinate('points', 'y', 'Y', 'mask-coordinate-editor', 0.5),
  maskCoordinate('box', 'x', 'X', 'mask-box-grid', 0.2),
  maskCoordinate('box', 'y', 'Y', 'mask-box-grid', 0.2),
  maskCoordinate('box', 'width', 'W', 'mask-box-grid', 0.6),
  maskCoordinate('box', 'height', 'H', 'mask-box-grid', 0.6),
];

function maskCoordinate(mode, field, labelText, container, defaultValue) {
  return buildCase({
    section: 'Mask',
    control: `${mode}.${field}`,
    label: labelText,
    input: {
      id: null,
      ariaLabel: null,
      container,
      labelText,
      selector: `.${container} label.mask-coordinate input`,
      source: MASK_SOURCE,
      marker: 'className="mask-coordinate"',
    },
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue,
    unit: '',
    animatable: false,
    expressionable: false,
    visibleWhen: Object.freeze({ selectionMode: mode === 'points' ? 'points' : 'box' }),
  });
}

const ADJUST_CASES = expandEffectNumberCases(ADJUST_LAYER_DESCRIPTORS, { section: 'Adjust' });

/** Every numeric Inspector field in TL-03 scope, in card order. */
export const inspectorNumericCases = Object.freeze([
  ...TRANSFORM_CASES,
  OPACITY_CASE,
  ...ADJUST_CASES,
  ...CROP_CASES,
  ...AUDIO_CASES,
  ...SPEED_CASES,
  ...MASK_CASES,
]);

/** The checklist items one case runs: keyframe items only where the case is animatable. */
export function actionsFor(numericCase) {
  return numericCase.actions.filter(
    (action) => !action.requiresAnimatable || numericCase.animatable,
  );
}

export { EFFECTS_SOURCE, INSPECTOR_SOURCE, MASK_SOURCE };
