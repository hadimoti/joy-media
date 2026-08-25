# Third-party notices

## Fontiran Modam Pro

- Product: [Modam Pro](https://modam.pro/) (Fontiran commercial webfont)
- Use: JOY Media editor UI chrome for English / Persian / Arabic (`Modam Pro` + optional Condensed weights)
- Files: `apps/editor-web/public/assets/fonts/modam-pro/`
- Shared with JOY Agent on this VPS (`/opt/joy-wg-bot/webapp/assets/fonts/modam-pro/`)
- License: Fontiran commercial license held by the JOY deployment — do not redistribute outside this product without confirming the license terms

## Fontiran content-creation font pack (18 families)

- Source: Fontiran bulk font pack, same vendor/collection as Modam Pro above
- Use: JOY Media text-object content fonts, selectable via the Motion Studio
  "Font Family" picker (`apps/editor-web/src/motion-studio/MotionStudioInspector.tsx`)
- Files: `apps/editor-web/public/assets/fonts/{yekanbakh,vazin,tajrid,pulad,damoon,
bon,bonyadekoodak,shoor,aviny,katibeh,tahrir,stencil-898,radio,falsafeh,edameh,
paradox,gramophone,emkan-inline}/`, aggregated by `content-fonts.css`
- Families: YekanBakh, Vazin, Tajrid, Pulad, Damoon Pro, Bon, Bonyade Koodak,
  Shoor Pro, Aviny, Katibeh, Tahrir, 898 Stencil, Radio, Falsafeh, Edameh Pro,
  Paradox, Gramophone, Emkan Inline
- License: same Fontiran commercial pack as Modam Pro — license terms have
  **not** been individually confirmed per family; do not redistribute outside
  this product without confirming terms for each

## gl-transitions

- Project: [gl-transitions/gl-transitions](https://github.com/gl-transitions/gl-transitions)
- License: MIT (see `packages/transition-shaders/GL-TRANSITIONS-LICENSE`)
- Use: curated GLSL transition shaders vendored under `packages/transition-shaders/src/shaders/`
- Authors of included shaders are recorded in `packages/transition-shaders/src/catalog.ts`

## HTML overlay layout inspiration

Lower-third / title layout ideas were **re-authored** into ADR-0006 `joy-html-scene-1` packages (no OBS control panels, no wall-clock CSS, no remote fonts):

- [noeal-dac/Animated-Lower-Thirds](https://github.com/noeal-dac/Animated-Lower-Thirds) (MIT)
- [rse/lowerthird](https://github.com/rse/lowerthird) (MIT)
- Template ideas from [tomastimelock/web-overlay](https://github.com/tomastimelock/web-overlay)
