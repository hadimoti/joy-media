# Next agent: creative HTML scene effects (image + multi-part text)

**Date:** 2026-07-28  
**Goal:** Author modern, creative first-party **HTML scene** overlays that place an **image beside 2–3 text parts** (headline / subhead / meta), animate on `ctx.progress`, and ship in the Motion panel **Scenes** catalog.

This brief is for the next coding agent. Read it end-to-end before editing.

---

## 1. Repo & runtime locations

| What | Path |
|------|------|
| Working checkout (VPS) | `/opt/joy-media/repo` |
| Bare git remote | `/opt/joy-media.git` (`origin`) |
| Public editor | https://media.joyteam.ir |
| Live web symlink | `/opt/joy-media/web` → `/opt/joy-media/web-releases/<sha>-<label>` |
| Editor app package | `apps/editor-web` (`@joy-media/editor-web`) |

**Do not** restore from backups/tarballs into live paths. Forward-only edits on the current tree.

---

## 2. What the user pointed at vs what to build

### 2.1 DOM they selected (Motion library — *not* HTML scenes)

```text
article.joy-panel-root.motion-panel
  → div.motion-library → div.motion-library-scroll
    → section.motion-library-section   ← "BUILT-IN"
```

That section lists **built-in keyframe motion presets** (Fade In / Fade Out / Pop In / Slide Up). Those are **not** HTML/React overlays.

| Role | Path |
|------|------|
| UI (library grid) | `apps/editor-web/src/MotionPanel.tsx` (`.motion-library-section`, Built-in) |
| Preset builders | `packages/motion-core/src/presets.ts` (`JOY_MOTION_PRESETS`) |
| Registry wrappers | `packages/motion-core/src/builtins.ts` (`registerBuiltinMotions`) |
| Poster PNGs | `apps/editor-web/public/assets/motion-previews/` |

**Out of scope for this brief** unless the user explicitly asks to expand Fade/Pop/Slide presets.

### 2.2 What to build: HTML scene packages

Creative “HTML effects” live as **first-party scene packages**, shown under Motion panel → **Scenes** subtab (`LibrarySubtab === 'html-scenes'`).

| Role | Path |
|------|------|
| **Author here (primary)** | `packages/html-scene-runtime/src/first-party.ts` |
| Catalog export | `FIRST_PARTY_SCENES`, `FirstPartySceneId`, `findFirstPartyScene` |
| Pinned golden hashes | `packages/html-scene-runtime/src/first-party.test.ts` (`REFERENCE_FRAME_SHA256`) |
| How-to runbook | `plan/P16-oss-transitions-html-scenes.md` § “How to add one more HTML scene” |
| Determinism contract | `docs/adr/0006-html-scene-sandbox-and-deterministic-clock.md` |
| Package README | `packages/html-scene-runtime/README.md` |
| Variable types | `packages/html-scene-runtime/src/variables.ts` (`string` \| `number` \| `boolean` \| `color` \| `enum`) |
| Scene context API | `packages/html-scene-runtime/src/runtime.ts` (`JoySceneContext`) |
| Live thumbs / add UI | `apps/editor-web/src/MotionPanel.tsx` (Scenes section; maps `FIRST_PARTY_SCENES`) |
| Thumb helpers | `apps/editor-web/src/html-scene-thumbs.ts` |
| Place on timeline | `apps/editor-web/src/App.tsx` → `addHtmlSceneToSelectedClip` / `htmlScene.create` |
| Prior OSS pack notes | `plan/P16-oss-transitions-html-scenes.md` |

New scenes appear automatically in the Scenes picker once they are on `FIRST_PARTY_SCENES` — no separate registry file.

---

## 3. Creative brief (product ask)

Design **new first-party HTML scenes** that feel modern and editorial — CapCut / broadcast / social polish — with this layout DNA:

1. **Visual anchor:** an image (or strong image-like block: photo frame, product still, poster crop). Prefer left or right of copy, not a floating card collage unless the template is clearly a card.
2. **2–3 text parts beside the image**, staggered in time:
   - Part A — primary title / name  
   - Part B — secondary line (role, product, location)  
   - Part C — optional tertiary (tag, handle, timestamp, CTA chip)
3. **Motion:** entrance/exit driven only by `ctx.progress` / `ctx.timeUs` / `ctx.random()` (seeded). Stagger text parts (e.g. 0.00 / 0.08 / 0.16 progress offsets). Prefer intentional motion (slide + fade, wipe reveal, scale settle) — not noisy glow spam.
4. **Variables:** expose editable strings/colors via `variableSchema` so editors can localize without code changes.
5. **Viewport:** existing packages use `1080×1920` (9:16) transparent overlays. Keep that unless you intentionally add aspect variants.
6. **Quantity suggestion:** ship **3–5** distinct templates (not one), e.g.:
   - Image left + title / subtitle / meta (interview lower-third family)
   - Image right + kicker / headline / body (story beat)
   - Circular avatar + name / role / handle (social intro)
   - Full-bleed image with text stack on a gradient veil (chapter / product reveal)
   - Split diagonal: image + three stacked lines with accent bar

Avoid default AI-looking purple gradients and generic Inter/Roboto stacks inside scenes; use system stacks already used in the catalog (Helvetica / Georgia / Tahoma) or inline SVG geometry. Editor UI uses Modam Pro — **scenes must not** load Modam over the network (ADR-0006 / DESIGN.md § fonts).

---

## 4. How a first-party scene is structured

Each entry in `first-party.ts` is a `FirstPartyScenePackage`:

```ts
{
  id: 'joy.firstparty.<slug>',       // extend FirstPartySceneId union
  name: 'Human Label',               // Motion Scenes grid label
  previewFocus: { x, y, w, h },      // 0–1 crop for live thumbs
  manifest: sharedManifest(id),      // joy-html-scene-1, 1080×1920, 5s, no network
  variableSchema: { … },             // typed defaults (string/color/…)
  source: `globalThis.__joyScene = function (ctx) { … };`,
}
```

### 4.1 Runtime contract (mandatory)

Inside `source`, the function receives `ctx` and must return a React element via `React.createElement` (global React in the sandbox):

| Field | Use |
|-------|-----|
| `ctx.progress` | `0…1` over scene duration — **primary animation driver** |
| `ctx.timeUs` / `ctx.durationUs` | absolute timing if needed |
| `ctx.variables` | resolved schema values |
| `ctx.random()` | deterministic random (seeded); **not** `Math.random` |
| `ctx.assets.resolve(id)` | only if resolvers supplied (first-party browser preview often has empty assets — see below) |
| `ctx.fonts.resolve(id)` | same restriction |

**Forbidden (ADR-0006 / P16):**

- Network (`fetch`, remote images, remote webfonts, CDNs)
- Wall clock (`Date.now`, `setTimeout`, `requestAnimationFrame`, CSS animations that depend on real time)
- Host DOM / editor globals
- Undeclared assets that throw at resolve time

### 4.2 Image strategy for “beside text” layouts

Today’s first-party packages are mostly **text-only**. For image + text:

**Preferred for first-party catalog (deterministic, offline):**

1. **Inline SVG** as the “image” (portrait silhouette, product glyph, geometric poster) — always works, no asset pipeline.
2. **`data:image/…;base64,…`** embedded in the `source` string for a tiny placeholder photo (keep small; goldens depend on pixels).
3. **Variable-driven placeholder** — e.g. `imageLabel` string + colored panel mimicking a photo crop until real asset wiring exists.
4. Later / advanced: wire `ctx.assets.resolve('hero')` with a package-local data URL passed through resolvers (see `resolver.ts` / `runtime.test.ts`). Browser live thumbs currently pass empty assets in `browser-preview.ts` — **do not** depend on unresolved assets in default first-party sources or thumbs will break.

Recommend: SVG or colored photo-frame + optional `caption` vars for v1 so Scenes picker works offline without new asset plumbing.

### 4.3 Suggested variable schema (image + 3 texts)

```ts
variableSchema: {
  title:    { type: 'string', label: 'Title', default: 'Alex Morgan' },
  subtitle: { type: 'string', label: 'Subtitle', default: 'Creative Director' },
  meta:     { type: 'string', label: 'Meta', default: '@joymedia' },
  accent:   { type: 'color', label: 'Accent', default: '#e9b949' },
  // optional layout knobs
  imageSide: { type: 'enum', label: 'Image side', default: 'left', options: ['left', 'right'] },
}
```

Stagger with progress gates, e.g. `showA = clamp((p - 0.00) * 4)`, `showB = clamp((p - 0.10) * 4)`, `showC = clamp((p - 0.20) * 4)`.

### 4.4 Checklist to register one scene

1. Add id to `FirstPartySceneId` union in `first-party.ts`.
2. Define package object + push into `FIRST_PARTY_SCENES`.
3. Choose `previewFocus` so the live thumb crops the interesting region (see existing `FOCUS_*` constants).
4. Run tests; update `REFERENCE_FRAME_SHA256` in `first-party.test.ts` with the new `referenceFrameSha256` from compile output (hashes **must** match exactly).
5. Smoke in editor: Motion → **Scenes** → add to a clip → scrub Monitor.
6. Attribute any third-party layout inspiration in `THIRD_PARTY_NOTICES.md` (re-author; do not paste proprietary OBS panels).

---

## 5. Existing catalog (do not break)

Already in `FIRST_PARTY_SCENES` (as of this brief):

| Id | Name |
|----|------|
| `joy.firstparty.title` | JOY Title |
| `joy.firstparty.product-card` | JOY Product Card |
| `joy.firstparty.lower-third` | JOY Lower Third |
| `joy.firstparty.data-list` | JOY Data List |
| `joy.firstparty.lower-third-bar` | Lower Third Bar |
| `joy.firstparty.lower-third-split` | Lower Third Split |
| `joy.firstparty.title-cinematic` | Title Cinematic |
| `joy.firstparty.countdown` | Countdown |
| `joy.firstparty.caption-card` | Caption Card |
| `joy.firstparty.end-slate` | End Slate |
| `joy.firstparty.super-app-hero` | Super App Hero |
| `joy.firstparty.news-ticker` | News Ticker |
| `joy.firstparty.social-badge` | Social Badge |
| `joy.firstparty.chapter-marker` | Chapter Marker |
| `joy.firstparty.score-bug` | Score Bug |

Use these as style/motion references (`super-app-hero` is the richest progress choreography). New work should **add** image+text templates rather than regress existing goldens.

---

## 6. Verify & deploy

### Tests

```bash
cd /opt/joy-media/repo
# focused goldens (will fail until REFERENCE_FRAME_SHA256 updated)
pnpm --filter @joy-media/html-scene-runtime test -- src/first-party.test.ts

# broader if you touch compile/runtime
pnpm --filter @joy-media/html-scene-runtime test
```

When adding a scene, compile once (or read test failure) to capture the new `referenceFrameSha256` and pin it.

### Editor build + live tip (pattern used on this host)

```bash
cd /opt/joy-media/repo
pnpm --filter @joy-media/editor-web build
# commit on main if requested by user
SHA=$(git rev-parse --short HEAD)
REL="${SHA}-html-scenes-creative"
mkdir -p "/opt/joy-media/web-releases/${REL}"
cp -a apps/editor-web/dist/. "/opt/joy-media/web-releases/${REL}/"
# copy reference media if present
if [ -d apps/editor-web/public/media/reference ]; then
  mkdir -p "/opt/joy-media/web-releases/${REL}/media/reference"
  cp -a apps/editor-web/public/media/reference/. "/opt/joy-media/web-releases/${REL}/media/reference/"
fi
ln -sfn "/opt/joy-media/web-releases/${REL}" /opt/joy-media/web
```

Hard-refresh https://media.joyteam.ir → Motion panel → **Scenes**.

---

## 7. Related-but-different systems (do not confuse)

| System | Location | Notes |
|--------|----------|-------|
| Keyframe motion presets | `motion-core` presets/builtins + Motion **Library** Built-in | Opacity/scale/position curves on selected objects |
| Pixi visual effects | `packages/visual-effects`, `EffectsPanel.tsx` | Blur/color-style effects — not HTML overlays |
| gl-transitions | `packages/transition-shaders` | Clip A↔B blends (P16 A) |
| Motion Studio | `apps/editor-web/src/motion-studio/` | User-authored motion scenes — separate from first-party HTML pack |

---

## 8. Acceptance criteria for the next agent

- [ ] 3+ new `joy.firstparty.*` scenes with **image (or image-like) + 2–3 text parts** beside it  
- [ ] All motion from `ctx.progress` / seeded `ctx.random` only (ADR-0006)  
- [ ] Editable variables for each text part + accent color  
- [ ] Registered on `FirstPartySceneId` + `FIRST_PARTY_SCENES`  
- [ ] `first-party.test.ts` goldens updated and green  
- [ ] Visible in Motion → Scenes; add-to-clip works; Monitor scrub shows staggered text  
- [ ] Deployed web tip under `/opt/joy-media/web-releases/…` if shipping to production  
- [ ] Short note in `STATE.md` / `THIRD_PARTY_NOTICES.md` if layouts were adapted from external references  

---

## 9. Quick open list for the agent

```text
/opt/joy-media/repo/packages/html-scene-runtime/src/first-party.ts          ← EDIT
/opt/joy-media/repo/packages/html-scene-runtime/src/first-party.test.ts     ← PIN HASHES
/opt/joy-media/repo/plan/P16-oss-transitions-html-scenes.md                 ← HOW-TO
/opt/joy-media/repo/docs/adr/0006-html-scene-sandbox-and-deterministic-clock.md
/opt/joy-media/repo/apps/editor-web/src/MotionPanel.tsx                     ← Scenes UI (usually no change)
/opt/joy-media/repo/DESIGN.md                                              ← UI vs scene font rules
```

**User intent in one line:** make the HTML Scenes catalog feel modern and creative — image with 2–3 text lines beside it — not just more plain title cards.
