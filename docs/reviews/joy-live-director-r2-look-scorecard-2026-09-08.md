# JOY Live Director R2 — Living Looks creator scorecard

**Status:** TASTE REVIEW COMPLETE — 2026-09-08; current R2 pack decision reconciled 2026-09-14.

The creator taste study was owner-gated; the owner has durably delegated taste
calls on this project to Claude Opus, and the verdicts below were recorded under
that delegation. **R2 ships five packs**, all `APPROVED` after the owner-directed GAP 3 repair in commit `3eaa8cd7`:

| Pack                | Verdict  | Note                                                                                          |
| ------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `editorial-clean`   | APPROVED | shipped after the `y`-sign fix landed in this candidate                                       |
| `product-precision` | APPROVED | as-is                                                                                         |
| `kinetic-type`      | APPROVED | shipped after the `phrase-2/3` treatment bindings landed                                      |
| `quiet-documentary` | APPROVED | as-is                                                                                         |
| `music-pulse`       | APPROVED | owner-directed GAP 3 repair (`3eaa8cd7`): rate control, beat-gated accent cuts, bounded pulse |

- **`music-pulse` — APPROVED for the current R2 candidate.** The owner-directed
  GAP 3 repair in `3eaa8cd7` added a real rate control and a rest-to-peak
  boolean cut pattern, then returned the pack to `BUILT_IN_LOOK_PACKS`. The
  historical HELD decision below is retained as review history and superseded
  by this dated reconciliation.
- **`persian-editorial` — RETIRED (2026-09-08).** The app is English-only and
  carries no Persian design requirement. The standalone `rtl-*` text templates
  remain available in the template catalogue as ordinary options; there is no
  Persian-script idiom review gate.

Date: 2026-09-08 · Branch: `codex/joy-live-director` · Packs source:
`packages/motion-core/src/looks/packs/`

## What this document is

The built-in Look packs are typed, declarative data compiled by the pure
`compileLook` (motion-core, L2). This scorecard records, per pack:

- its deliberate identity and the controls an operator actually turns;
- the deterministic first-apply operation list (from the golden snapshots
  `packages/motion-core/src/looks/packs/__snapshots__/`), which is the objective
  motion evidence;
- the format constraints (portrait ≠ landscape, explicit values);
- the engineering self-check result;
- the **owner taste review line**, which is the release gate.

It does **not** assert that a pack "looks good" — that judgement is the owner's,
delegated to Opus for this project.

## Automated evidence (objective, CI-enforced)

| Check                                                                               | Where                                   | Result |
| ----------------------------------------------------------------------------------- | --------------------------------------- | ------ |
| Every pack passes `validateLookDefinition`                                          | `packs.test.ts`                         | ✅     |
| Keyframe bindings target real `ANIMATABLE_PROPERTIES`                               | `packs.test.ts`                         | ✅     |
| Portrait and landscape constraints differ, all values positive                      | `packs.test.ts`                         | ✅     |
| Every control drives ≥1 declared binding ("no fake slider")                         | `validate.ts` + `packs.test.ts`         | ✅     |
| Deterministic compile — identical inputs, identical `operationDigest`               | `packs.test.ts`                         | ✅     |
| First-apply operation list is stable (golden)                                       | `packs-golden.test.ts`                  | ✅     |
| Template ids resolve against the shipped `TEXT_TEMPLATES` / `JOY_CAPTION_TEMPLATES` | editor `look-packs-conformance.test.ts` | ✅     |
| Required fonts are in `CONTENT_FONT_FAMILIES` (bundled, OFL)                        | conformance test                        | ✅     |
| Keyframe profiles produce real motion, not a flat hold                              | `packs-golden.test.ts`                  | ✅     |
| Compiled keyframes sample back with no interpolation overshoot                      | `packs-render-fidelity.test.ts`         | ✅     |
| `music-pulse` validates, compiles and is included in `BUILT_IN_LOOK_PACKS`          | `packs.test.ts` / golden / fidelity     | ✅     |

The current five-pack motion-core suite, editor conformance checks and full candidate suite are green; the exact counts are recorded by v2 run `34761098952`.

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
  `+16.8 → 0` (rises from below); deck opacity `0 → 1` (staggered); deck `y`
  `+12.6 → 0`; `text headline-treatment → clean-title`;
  `caption caption-treatment → joy-clean`.
- **Constraints:** portrait `safeMarginPx 104 / maxHeadlineChars 40 / minHoldUs
1_200_000`; landscape `72 / 64 / 1_200_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Required fonts:** none.
- **Engineering self-check:** ✅ compiles deterministically; motion is within the
  declared eased-rise range; no reframe, no destructive op.
- **`OWNER_TASTE_REVIEW: APPROVED`** — 2026-09-08 (Opus, owner-delegated).
  Identity is coherent, restrained, and clearly distinct; the template-led
  hierarchy is the right call. The taste review caught a sign inversion — `+y` is
  down (`joy-slide-up` in `packages/motion-core/src/presets.ts` starts at
  `base.y + 80` to rise from below), so the original `max: -48 / -36` started the
  headline **above** rest and **dropped** it in, the opposite of the "fade-up" the
  docstring, the inline comment, and this scorecard all describe. **Fixed in this
  candidate:** `max: 48` (headline-y), `max: 36` (deck-y); golden snapshots
  re-blessed. Approved on that fix.

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
- **`OWNER_TASTE_REVIEW: APPROVED`** — 2026-09-08 (Opus, owner-delegated). The
  only pack whose motion is _timed emphasis_ rather than an entrance, which
  earns its slot in the set. Declining to reframe footage is the honest call
  given R1 has no crop/mask op — a pack that does less beats one that pretends.
  The CTA pulse (1 → 1.1 → 1 at 60/70/80%) is bounded, returns to rest, and
  lands late where a CTA belongs; the `hold` interpolation on the benefit line
  gives a crisp cut-on that suits "precision". Noted, not blocking: "Emphasis"
  drives both the late CTA pulse and the callout's entrance `x` nudge — two ideas
  on one slider — but that is a better trade than a fifth control.

### 3. Kinetic Type (`kinetic-type`)

- **Identity:** phrase-led typography with a distinct staggered entrance, hold,
  and exit. **Phrase-object-scoped, not per-word** — `motion.setKeyframe` binds a
  whole visual object.
- **Slots:** phrase-1 (required), phrase-2, phrase-3 (optional).
- **Controls:** Energy (scalar → per-phrase `scaleX/scaleY` 1→0.55 spring-in +
  `y` drop), Entrance (enum snap/soft/hold → per-phrase opacity), Phrase
  treatment (color → `outline-impact` / `bold-stack`, all three phrases).
- **Golden motion:** each bound phrase, staggered `0 → 0.12 → 0.24`: opacity
  `0 → 1` entrance, hold, then an eased exit back to the per-option rest
  (`snap` clears fully, `soft` to 0.3, `hold` stays up); scale `0.73 → 1`;
  `y` `+38.4 → 0` (rises from below); `text phrase-{1,2,3}-treatment →
outline-impact`.
- **Constraints:** portrait `88 / 22 / 450_000`; landscape `60 / 34 / 450_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`. **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; every phrase hold spans ≥
  `minHoldUs`; first phrase present after apply.
- **Scoped follow-up:** per-word animation + `text.insertTemplate` object
  creation are a compiler follow-up.
- **`OWNER_TASTE_REVIEW: APPROVED`** — 2026-09-08 (Opus, owner-delegated). The
  best motion in the set: a real entrance → hold → exit on a single opacity
  curve, staggered `0 / 0.12 / 0.24`, a `0.73 → 1` spring, and a `y` rise from
  below (`+38.4 → 0`). The taste review found the signature typography reached
  only `phrase-1` — a three-phrase sequence rendered phrase 1 in `outline-impact`
  and phrases 2–3 in whatever template they carried. **Fixed in this candidate:**
  `phrase-2-treatment` and `phrase-3-treatment` text-template bindings added and
  driven from the existing `treatment` control — no new control, no new operation
  kind; golden snapshots re-blessed. Approved on that fix.

### 4. Quiet Documentary (`quiet-documentary`)

- **Identity:** minimal lower thirds, gentle opacity-only fades, long holds and
  plenty of listening space. No scale, no translate.
- **Slots:** lower-third / name-role (required), title card (optional), captions
  (optional).
- **Controls:** Reveal (scalar, default 1 → lower-third/title opacity
  `0 → 0.55 → 1` eased-in; the required lower third reaches full opacity at the
  default, lower values hold it more transparent), Lower third (color →
  `name-role` / `accent` text templates), Captions (enum → `joy-clean` /
  `joy-rtl-classic`).
- **Constraints:** portrait `120 / 44 / 2_500_000`; landscape `88 / 68 /
2_500_000` — the longest `minHoldUs` of the set, deliberately.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; opacity is the only animated
  channel; holds respect the 2.5s minimum.
- **`OWNER_TASTE_REVIEW: APPROVED`** — 2026-09-08 (Opus, owner-delegated). The
  most disciplined pack. Opacity-only is a real constraint honestly held — the
  `no-position-motion` predicate asserts it rather than leaving it to authoring
  care — the 2.5s `minHoldUs` genuinely earns the "listening space" claim, and
  the `0 → 0.55 → 1` eased profile is a slow fade with a shape rather than a
  linear ramp. Distinct from editorial-clean precisely by having no translate at
  all. Noted, not blocking: `Reveal` at 0 drives the _required_ lower third to
  full transparency, so the operator can hide the mandatory element; the
  behaviour is monotonic and the default is 1, so it ships as-is — if a floor is
  ever wanted, 0.35 is the number.

## Held / retired (historical entries)

### Music Pulse (`music-pulse`) — HELD for R2.1 (superseded 2026-09-14)

Audio-reactive scale + opacity pulse. Held out of `BUILT_IN_LOOK_PACKS`; kept in
the tree with `music-pulse.test.ts` covering validation + compile so it cannot
rot. Two problems, both in the L3 slider path (the only path an operator reaches
in R2):

1. **"Accent cuts" does not cut.** The compiler's boolean branch calls
   `emitKeyframes(bindingId, value, value, …)`, so rest equals full and the
   declared `profile` is inert — compiled with `accent: true` the accent mark is
   simply switched on permanently. It slips both guards: it passes "no fake
   slider" (it does drive a binding) and passes "not a flat hold" (that check
   samples _default_ values and `accent` defaults to `false` → `whenFalse:
'omit'`). **Fix for R2.1:** give `LookBooleanDrive` a live rest value so the
   profile takes effect, or drop the profile and rename the control.
2. **The pulse is not musical.** `atFractions` are composition-relative, so the
   pack emits exactly two swells per composition regardless of length; at the 0.3
   default the excursion is `1.000 → 1.036`. Rate is not a control. **Fix for
   R2.1:** add a rate control generating N periods, and raise the default depth.

Also fold in: `subject-treatment` applies a **text** template to a generic
`visual-object` slot; name the slot for the text expectation or gate the control
on a text-bearing binding.

### Persian Editorial (`persian-editorial`) — RETIRED 2026-09-08

Removed. The app is English-only and carries no Persian design requirement. The
`rtl-editorial-title` / `rtl-name-role` / `rtl-quote-focus` text templates and
the pre-existing RTL caption support are untouched and remain available as
ordinary catalogue options; there is no Persian-script idiom review gate.

## Ship decision — 2026-09-08 (Opus, owner-delegated)

Reviewed under the owner's standing delegation of taste calls on this project.
All packs read; `compileLook`, `validate.ts` and `types.ts` read; the golden
snapshots checked against the sources; the motion-core Look tests re-run green;
the sign conventions established from `packages/motion-core/src/presets.ts`
(`+y` is down, `+x` is right) rather than assumed.

**Historical overall read.** The four-pack review below predates the owner-directed GAP 3 repair. The current five shipping packs are genuinely art-directed, not
re-skins of one curve. Each has a defensible reason to exist — template-led
hierarchy, timed emphasis, entrance/hold/exit typography, opacity-only restraint
— and the declarative discipline is real: no model in the apply path, bounded
amplitudes, verification predicates that assert the identity claims instead of
trusting them.

Two findings the green suite could not catch (disagreements between what a pack
_claims_ and what it _compiles_) were fixed in this candidate:

- **editorial-clean** promised a fade-up in three places and compiled a drop-in;
  the sign was inverted. Flipped.
- **kinetic-type** applied its signature typography to one of its three phrases.
  All three now.

The owner-directed GAP 3 repair (`3eaa8cd7`) resolved the Music Pulse compiler
issues: rate control, beat-gated accent cuts and bounded amplitude are now
covered by the current validator and golden suite. `persian-editorial` remains
retired per the English-only direction.

**Five packs is the current coherent built-in set.** The historical four-pack
rationale is retained above for auditability and is superseded for this candidate.

| Pack              | Verdict  | Date       | Notes                                                                                                  |
| ----------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| editorial-clean   | APPROVED | 2026-09-08 | `y`-sign fix applied (`max` +48 / +36); golden re-blessed. Restrained, template-led, distinct.         |
| product-precision | APPROVED | 2026-09-08 | Timed emphasis rather than an entrance; bounded CTA pulse that returns to rest; honest not to reframe. |
| kinetic-type      | APPROVED | 2026-09-08 | `phrase-2/3-treatment` bindings added, driven from the existing control; golden re-blessed.            |
| quiet-documentary | APPROVED | 2026-09-08 | Most disciplined pack; opacity-only held by an asserting predicate, longest holds, real eased profile. |
| music-pulse       | APPROVED | 2026-09-14 | Owner-directed GAP 3 repair `3eaa8cd7`: rate control, beat-gated accent cuts, bounded 1.12x pulse.     |
| persian-editorial | RETIRED  | 2026-09-08 | Removed — app is English-only, no Persian design requirement.                                          |

## Render fidelity

`packages/motion-core/src/looks/packs/packs-render-fidelity.test.ts` (8 tests,
4 packs × portrait + landscape) is the numeric-tolerance harness the L3b plan
called for, done deterministically without a browser: it compiles each pack,
turns the `motion.setKeyframe` operations into curve keyframes, and asserts the
renderer's own evaluator (`sampleCurve`) reproduces them — keyframe times inside
the composition, exact sample-at-keyframe, no interpolation overshoot at the
[0, 0.5, 1] fractions, and every pack driving ≥1 binding with real motion.

The remaining L3b item is purely presentational: a handful of **sanitized sample
renders** for the owner's visual read. That artifact does not gate the automated
pipeline.
