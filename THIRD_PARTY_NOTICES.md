# Third-party notices

## Repository code

Unless a file or directory is listed below with its own terms, JOY Media
source code is released under the MIT License in [`LICENSE`](LICENSE).

## JOY Agent Engine dependencies

- `ai` 7.0.92 — Apache-2.0; provider-neutral AI SDK Core used behind the JOY
  Agent Engine package boundary
- `@ai-sdk/openai-compatible` 3.0.43 — Apache-2.0; OpenAI-compatible provider
  adapter used for session-only BYOK transport
- `zod` 4.1.8 — MIT; runtime schema validation for agent boundaries

## Self-hosted editor fonts

The editor ships the following Fontsource packages at pinned versions in
`apps/editor-web/package.json`. Each package is licensed under the SIL Open
Font License 1.1 (OFL-1.1), and the package's `LICENSE` file remains available
in the installed dependency for audit and release attribution:

- `@fontsource-variable/inter` 5.2.6 — Inter Variable, Latin / Greek / Cyrillic
- `@fontsource-variable/vazirmatn` 5.2.6 — Vazirmatn Variable, Persian / Arabic / Latin
- `@fontsource/noto-sans-arabic` 5.2.6 — Noto Sans Arabic, Arabic / Persian / Latin
- `@fontsource/noto-naskh-arabic` 5.2.6 — Noto Naskh Arabic, Arabic / Persian / Latin

The CSS is imported by `apps/editor-web/src/main.tsx`, so font files are
bundled into the application build rather than fetched from a CDN. The
complete license text and release attribution are shipped in
`apps/editor-web/public/licenses/fonts/OFL-1.1.txt` and
`apps/editor-web/public/licenses/fonts/FONT-ATTRIBUTIONS.md`. The catalog
metadata and compatibility aliases are code-owned in
`packages/project-schema/src/content-fonts.ts`.

Projects written before the migration may still contain retired Fontiran
family identifiers. They are treated as compatibility aliases and resolved to
the open local faces at render/export time; no retired font binaries ship in
the editor.

The former `apps/editor-web/public/fonts/` login-gate files were removed. The
login gate now uses the same bundled Fontsource Inter/Vazirmatn stack as the
editor, so there are no separate unverified font binaries in the artifact and
the Fontiran-specific asset redistribution gate is closed. Whole-artifact
owner/legal review remains a separate release decision.

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

## Optional Local Worker masking integrations

These projects are not vendored into the web application or VPS artifact.
Owners may install them on a paired Local Worker through the runner boundary
defined by ADR-0033.

- [facebookresearch/sam3](https://github.com/facebookresearch/sam3) — optional
  SAM 3.1 prompt/tracking adapter; gated checkpoint and custom SAM License.
- [facebookresearch/sam2](https://github.com/facebookresearch/sam2) — optional
  image/video segmentation adapter; Apache-2.0.
- [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2)
  and [GroundingDINO](https://github.com/IDEA-Research/GroundingDINO) — optional
  text grounding for SAM 2; Apache-2.0.
- [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) — optional
  high-resolution matte model; MIT.
- [danielgatis/rembg](https://github.com/danielgatis/rembg) — used by the
  included image runner adapter; MIT. The package/model is installed and
  cached only on the Local Worker.

## Production runtime dependencies (current candidate)

- `mediabunny` 1.55.7 — MPL-2.0; used by the browser editor decoders under
  `apps/editor-web/src/media-observation/`. The full MPL-2.0 license text is
  shipped at `apps/editor-web/public/licenses/third-party/MPL-2.0.txt`. See
  `docs/reviews/joy-observation-decoder-selection.md` for the package-selection
  and source record.
- `nodemailer` 10.0.12 — MIT-0; API production dependency. This package is not
  bundled in the browser application.
