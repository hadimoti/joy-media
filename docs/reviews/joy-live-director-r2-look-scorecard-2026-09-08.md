# JOY Live Director R2 — Living Looks creator scorecard (PROVISIONAL)

**Status:** PROVISIONAL — engineering self-assessment only.
**Not self-certifiable:** the creator taste study and the Persian-script idiom
review are **owner-gated**. Every pack below carries `OWNER_TASTE_REVIEW:
PENDING` and stays ship-blocked on that line until the owner (or an owner-named
reviewer) records a verdict here.

Date: 2026-09-08 · Branch: `codex/joy-live-director` · Packs source:
`packages/motion-core/src/looks/packs/`

## What this document is

The six built-in Look packs are typed, declarative data compiled by the pure
`compileLook` (motion-core, L2). This scorecard records, per pack:

- its deliberate identity and the controls an operator actually turns;
- the deterministic first-apply operation list (from the golden snapshots
  `packages/motion-core/src/looks/packs/__snapshots__/`), which is the objective
  motion evidence;
- the format constraints (portrait ≠ landscape, explicit values);
- the engineering self-check result;
- the **owner taste review line**, which is the release gate.

It does **not** assert that a pack "looks good" — that judgement is the owner's.

## Automated evidence (objective, CI-enforced)

| Check                                                                               | Where                                     | Result   |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | -------- |
| Every pack passes `validateLookDefinition`                                          | `packs.test.ts`                           | ✅ 43/43 |
| Keyframe bindings target real `ANIMATABLE_PROPERTIES`                               | `packs.test.ts`                           | ✅       |
| Portrait and landscape constraints differ, all values positive                      | `packs.test.ts`                           | ✅       |
| Every control drives ≥1 declared binding ("no fake slider")                         | `validate.ts` + `packs.test.ts`           | ✅       |
| Deterministic compile — identical inputs, identical `operationDigest`               | `packs.test.ts`                           | ✅       |
| First-apply operation list is stable (golden)                                       | `packs-golden.test.ts`                    | ✅ 18/18 |
| Template ids resolve against the shipped `TEXT_TEMPLATES` / `JOY_CAPTION_TEMPLATES` | editor `look-packs-conformance.test.ts`   | ✅ 4/4   |
| Required fonts are in `CONTENT_FONT_FAMILIES` (bundled, OFL)                        | conformance test                          | ✅       |
| Keyframe profiles produce real motion, not a flat hold                              | `packs-golden.test.ts` (added `5860f929`) | ✅       |

61 motion-core pack tests + 4 editor conformance tests, all green.

## Per-pack scorecard

### 1. Editorial Clean (`editorial-clean`)

- **Identity:** restrained hierarchy, a clean title/deck rhythm; motion-minimal —
  a low eased fade-up on the headline and deck, no scale bounce. Hierarchy comes
  from the text template, not exaggerated animation.
- **Slots:** headline (required), deck (optional), captions (optional).
- **Controls:** Energy (scalar → headline/deck `y` rise-and-settle),
  Entrance (enum fade/quick/hold → headline/deck opacity), Headline treatment
  (color → `clean-title` / `bold-stack` / `gradient-headline`), Caption style
  (enum → `joy-clean` / `joy-karaoke-pop`).
- **Golden motion (portrait & landscape identical, format only changes
  constraints):** headline opacity `0 → 1` over the first 16%; headline `y`
  `−16.8 → 0`; deck opacity `0 → 1` (staggered); deck `y` `−12.6 → 0`;
  `text headline-treatment → clean-title`; `caption caption-treatment → joy-clean`.
- **Constraints:** portrait `safeMarginPx 104 / maxHeadlineChars 40 / minHoldUs
1_200_000`; landscape `72 / 64 / 1_200_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Required fonts:** none.
- **Engineering self-check:** ✅ compiles deterministically; motion is within the
  declared eased-rise range; no reframe, no destructive op.
- **`OWNER_TASTE_REVIEW: PENDING`**

### 2. Product Precision (`product-precision`)

- **Identity:** timed callout and CTA emphasis held clear of the product by the
  `safeMarginPx` constraint. **Does not reframe footage** — no crop/mask op; it
  animates operator-bound callout/CTA objects only.
- **Slots:** callout (required), benefit line (optional), CTA (optional).
- **Controls:** Emphasis (scalar → CTA `scaleX/scaleY` 1→1.1 pulse, callout `x`
  nudge), Reveal (enum staged/together → benefit opacity), Callout reveal
  (scalar → callout/CTA opacity 0→1), Callout treatment (color → `accent` /
  `stat` text templates).
- **Constraints:** portrait `128 / 30 / 700_000`; landscape `96 / 46 / 700_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`. **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; emphasis pulse returns to rest;
  callout stays outside the safe margin by construction.
- **Scoped follow-up (documented, not a defect):** auto-placed callouts via
  `text.insertTemplate` object creation are a compiler follow-up; today the
  operator binds an existing callout object.
- **`OWNER_TASTE_REVIEW: PENDING`**

### 3. Kinetic Type (`kinetic-type`)

- **Identity:** phrase-led typography with a distinct staggered entrance, hold,
  and exit. **Phrase-object-scoped, not per-word** — `motion.setKeyframe` binds a
  whole visual object.
- **Slots:** phrase-1 (required), phrase-2, phrase-3 (optional).
- **Controls:** Energy (scalar → per-phrase `scaleX/scaleY` 1→0.55 spring-in +
  `y` drop), Entrance (enum snap/soft/hold → per-phrase opacity), Phrase
  treatment (color → `outline-impact` / `bold-stack`).
- **Golden motion:** each bound phrase gets a staggered `0 → 0.12 → 0.24` fraction
  entrance: opacity `0 → 1`, scale `0.73 → 1`, `y` `38.4 → 0`.
- **Constraints:** portrait `88 / 22 / 450_000`; landscape `60 / 34 / 450_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`. **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; every phrase hold spans ≥
  `minHoldUs`; first phrase present after apply.
- **Scoped follow-up:** per-word animation + `text.insertTemplate` object
  creation are a compiler follow-up.
- **`OWNER_TASTE_REVIEW: PENDING`**

### 4. Quiet Documentary (`quiet-documentary`)

- **Identity:** minimal lower thirds, gentle opacity-only fades, long holds and
  plenty of listening space. No scale, no translate.
- **Slots:** lower-third / name-role (required), title card (optional), captions
  (optional).
- **Controls:** Gentleness (scalar → lower-third/title opacity `0 → 0.55 → 1`
  eased-in), Lower third (color → `name-role` / `accent` text templates),
  Captions (enum → `joy-clean` / `joy-rtl-classic`).
- **Constraints:** portrait `120 / 44 / 2_500_000`; landscape `88 / 68 /
2_500_000` — the longest `minHoldUs` of the six, deliberately.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; opacity is the only animated
  channel; holds respect the 2.5s minimum.
- **`OWNER_TASTE_REVIEW: PENDING`**

### 5. Music Pulse (`music-pulse`)

- **Identity:** audio-reactive scale + opacity pulse with a bounded amplitude.
- **Slots:** subject (required), accent mark (optional), captions (optional).
- **Controls:** Pulse depth (scalar → subject `scaleX/scaleY` 1 → 1.12 pulse at
  `[0, 0.25, 0.5, 0.75, 1]`), Accent cuts (boolean → accent opacity on the beat
  fractions), Subject treatment (color → `neon` / `gold`), Captions (enum).
- **Golden motion (slider-driven L3 default):** `subject-scale-x/y`
  `1.000 → 1.036 → 1.000 → 1.036 → 1.000` across the composition.
- **L4 audio path:** the pure core (`audio-reactive.ts`, `bakeAudioReactive`) and
  the host bridge (`look-audio-bridge.ts`, `beatEnvelopeToLookEnvelope` +
  `bakeLookAudio`) are complete and tested; `LookCompileInput.audioBakes` lets a
  baked keyframe track from real beat evidence supersede the `depth` slider on
  its binding. **Not yet wired end-to-end into the panel** (decoded-track →
  `runLook`); that + `tests/e2e/living-looks-audio-motion.spec.ts` are R2
  follow-ups (see the R2 acceptance bundle).
- **Constraints:** portrait `96 / 28 / 300_000`; landscape `64 / 40 / 300_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; pulse amplitude bounded to the
  declared `[1, 1.12]`; smoothing in the baker can never overshoot; silence /
  low-confidence → flat rest line, never an invented downbeat.
- **`OWNER_TASTE_REVIEW: PENDING`** (taste review should cover the audio-reactive
  feel once the panel path lands).

### 6. Persian Editorial (`persian-editorial`)

- **Identity:** right-to-left editorial hierarchy with mixed-script typography on
  Vazirmatn Variable (bundled, OFL). Fontiran gate stays **CLOSED**.
- **Slots:** headline / عنوان (required), byline / نام و نقش (optional), captions
  / زیرنویس (optional).
- **Controls:** انرژی / Energy (scalar → headline `x` `0 → 56` RTL settle),
  ورود / Entrance (enum fade/quick → headline/byline opacity),
  صفحه‌آرایی / Layout (color → `rtl-editorial-title` / `rtl-quote-focus`,
  `rtl-name-role`), زیرنویس / Captions (enum → `joy-rtl-classic` / `joy-clean`).
- **Constraints:** portrait `120 / 36 / 1_400_000`; landscape `88 / 56 / 1_400_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Required fonts:** `Vazirmatn Variable`.
- **Engineering self-check:** ✅ deterministic; RTL templates resolve; motion is
  a single settling `x` translate (RTL-appropriate direction).
- **`OWNER_TASTE_REVIEW: PENDING`** — and additionally a **Persian-script idiom
  review** (are the sample strings, alignment, and script mixing idiomatic?),
  which is owner-gated.

## Owner review section (to be completed by the owner)

For each pack, record: `OWNER_TASTE_REVIEW: APPROVED | CHANGES_REQUESTED | REJECTED`,
a date, and notes. R2 does not ship a pack whose line still reads `PENDING`.

| Pack              | Verdict | Date | Notes |
| ----------------- | ------- | ---- | ----- |
| editorial-clean   | PENDING |      |       |
| product-precision | PENDING |      |       |
| kinetic-type      | PENDING |      |       |
| quiet-documentary | PENDING |      |       |
| music-pulse       | PENDING |      |       |
| persian-editorial | PENDING |      |       |

## Render fidelity

`packages/motion-core/src/looks/packs/packs-render-fidelity.test.ts` (12 tests,
6 packs × portrait + landscape) is the numeric-tolerance harness the L3b plan
called for, done deterministically without a browser: it compiles each pack,
turns the `motion.setKeyframe` operations into curve keyframes, and asserts the
renderer's own evaluator (`sampleCurve`) reproduces them — keyframe times inside
the composition, exact sample-at-keyframe, no interpolation overshoot at the
[0, 0.5, 1] fractions, and every pack driving ≥1 binding with real motion.

The remaining L3b item is purely presentational: a handful of **sanitized sample
renders** attached here for the owner's visual read during the taste review.
That artifact does not gate the automated pipeline.
