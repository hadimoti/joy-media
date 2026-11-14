# v1.1.1 Colour QA — T-K06

Checks in this card use the existing colour engine and property system. The
app was not launched. “Preview” is verified at the Pixi shader input boundary;
it does not claim a live rendered-frame check. “Export” is verified through
the CPU pixel path used by export.

| Control        | Works in preview                 | Works in export                 | Undo                | Keyframe                       | Saved                  |
| -------------- | -------------------------------- | ------------------------------- | ------------------- | ------------------------------ | ---------------------- |
| Temperature    | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Tint           | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Exposure       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Contrast       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Pivot          | Pass: Pixi uniform               | Pass: patch chart with contrast | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Highlights     | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Shadows        | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Whites         | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Blacks         | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Saturation     | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Vibrance       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |
| Hue            | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Pass: hue, linear; no hold key | Pass: project snapshot |
| None           | Pass: identity filter omitted    | Pass: patch unchanged           | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| Clean Contrast | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| Soft Film      | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| Warm Cinema    | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| Cool Fade      | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| Monochrome     | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | Pass: string hold              | Pass: project snapshot |
| LUT intensity  | Pass: built-in and cube uniforms | Pass: built-in and cube mix     | Pass: grade inverse | Pass: scalar                   | Pass: project snapshot |

The shared `color.setGrade` inverse restores the prior whole grade, for output
and clip grades. The undo and redo tests start from grades that already had
values, undo back to them, and redo to the changed grade. The Saved column is a
desktop project snapshot reopen check.

**Keyframes.** The panel tests click each “Add … keyframe at playhead” control
on the output grade and assert the `propertyAnimation.replace` command and its
value: all twelve Adjust sliders, LUT intensity, and all six looks. Scalar and
hue keys are linear. The string (look) hold is tested in the evaluator: a look
holds until the next key and keeps holding after the last one. Hue keys sample
on the shortest arc. The panel never writes a hold key for Hue, so no hold is
claimed for it.

**Reset.** Each slider's Reset, the LUT intensity Reset and Reset all are tested
per control, with the document checked after each. Looks have no reset of their
own: choosing None or using Reset all returns them to identity.

**Saved.** The persistence tests reopen, through a desktop snapshot file, an
output grade with every Adjust value set, all six built-in looks, a clip grade,
and four saved keyframes (scalar, hue, look, and clip-local scalar).

## Not covered

- **Clip-scope keyframe clicks in the panel.** The click tests use the output
  target. Clip keyframes are covered by the descriptor coverage test and the
  persistence round trip only.
- **Hue hold.** The sampler supports a hold key, but the panel never writes one,
  so there is no hold behaviour to test.
- **Live on-screen preview.** The app was not launched; preview is checked at
  the shader input only.
- **LUT intensity keyframe reopen.** Saved by the same scalar path as the other
  scalar keyframes, but not reopened separately.

## Known issue (not fixed in T-K06)

The look keyframe path in `ColorPanel.tsx` writes an extra `kind` field into
each string key (`keys: [{ kind: 'string', timeUs, value }]`). Validation and
sampling accept it and read only `timeUs` and `value`, so the keyframe works,
but the stored key is not exactly the discrete key shape. The test asserts the
fields that matter and records this quirk. Fixing it is a production change
and was out of scope here.

## Defect: no `.cube` file picker

The Looks panel displays a custom LUT already present in the project, and the
resolver can load and parse its project asset. The editor has no `.cube` import
picker: the asset library picker accepts video, audio, and image files. A user
cannot load a new LUT through the existing UI. No picker feature was added in
this card.

## Evidence

- `packages/renderer-pixi/src/color-grade-engine.test.ts`: Adjust and Look
  direction checks on black, shadow, mid-grey, highlight, white, red, and
  muted-red patches; identity byte-exact; built-in and `.cube` intensity mix.
- `packages/renderer-pixi/src/effects-pixi.test.ts`: all Adjust uniforms,
  built-in Look indices, LUT intensity bindings, and the omitted None filter.
- `apps/editor-web/src/ColorPanel.sections.test.tsx`: Adjust and Look keyframe
  controls render for the supported properties.
- `apps/editor-web/src/ColorPanel.commands.test.tsx`: each Adjust slider drag
  commits one change that reaches the document; per-slider keyframe clicks and
  Reset; LUT intensity; the six looks; Reset all; `AdjustSection` passes drags to
  `onPatch` and Reset section to `onCommit`.
- `packages/evaluator/src/color-grade.test.ts`: look hold between and after keys.
- `packages/property-system/src/property-coverage.test.ts`: descriptor-to-family
  coverage for both scopes and declared animation value kinds.
- `packages/property-system/src/index.test.ts`: full-grade command inverse, and
  undo and redo over existing values for output and clip grades.
- `packages/project-persistence/src/persistence.test.ts`: output-grade snapshot
  reopen (all six looks), clip grade and saved keyframes reopen.
