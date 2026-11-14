# v1.1.1 Colour QA — T-K06

Checks in this card use the existing colour engine and property system. The
app was not launched. “Preview” is verified at the Pixi shader input boundary;
it does not claim a live rendered-frame check. “Export” is verified through
the CPU pixel path used by export.

| Control        | Works in preview                 | Works in export                 | Undo                | Keyframe    | Saved                  |
| -------------- | -------------------------------- | ------------------------------- | ------------------- | ----------- | ---------------------- |
| Temperature    | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Tint           | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Exposure       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Contrast       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Pivot          | Pass: Pixi uniform               | Pass: patch chart with contrast | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Highlights     | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Shadows        | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Whites         | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Blacks         | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Saturation     | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Vibrance       | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Scalar      | Pass: project snapshot |
| Hue            | Pass: Pixi uniform               | Pass: patch chart               | Pass: grade inverse | Hue         | Pass: project snapshot |
| None           | Identity filter omitted          | Patch remains unchanged         | Pass: grade inverse | String hold | Pass: project snapshot |
| Clean Contrast | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | String hold | Pass: project snapshot |
| Soft Film      | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | String hold | Pass: project snapshot |
| Warm Cinema    | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | String hold | Pass: project snapshot |
| Cool Fade      | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | String hold | Pass: project snapshot |
| Monochrome     | Pass: look index                 | Pass: patch chart               | Pass: grade inverse | String hold | Pass: project snapshot |
| LUT intensity  | Pass: built-in and cube uniforms | Pass: built-in and cube mix     | Pass: grade inverse | Scalar      | Pass: project snapshot |

The shared `color.setGrade` inverse restores the prior whole grade. The saved
column is a desktop project snapshot reopen check. Keyframe descriptors are
covered for both output and clip grades: Adjust sliders use scalar or hue
values, Looks use a held string reference, and LUT intensity uses a smooth
scalar. The property coverage test also checks wheel colour/master values,
whole-curve snapshots, and all eight HSL bands and their value kinds.

## Defect: no `.cube` file picker

The Looks panel displays a custom LUT already present in the project, and the
resolver can load and parse its project asset. The editor has no `.cube` import
picker: the asset library picker accepts video, audio, and image files. A user
cannot load a new LUT through the existing UI. No picker feature was added in
this card.

## Evidence

- `packages/renderer-pixi/src/color-grade-engine.test.ts`: Adjust and Look
  direction checks on black, shadow, mid-grey, highlight, white, red, and
  muted-red patches; built-in and `.cube` intensity mix.
- `packages/renderer-pixi/src/effects-pixi.test.ts`: all Adjust uniforms,
  built-in Look indices, and LUT intensity bindings.
- `apps/editor-web/src/ColorPanel.sections.test.tsx`: Adjust and Look
  keyframe controls render for the supported properties.
- `packages/property-system/src/property-coverage.test.ts`: descriptor-to-family
  coverage for both scopes and declared animation value kinds.
- `packages/property-system/src/index.test.ts`: full-grade command inverse.
- `packages/project-persistence/src/persistence.test.ts`: output-grade snapshot
  reopen.
