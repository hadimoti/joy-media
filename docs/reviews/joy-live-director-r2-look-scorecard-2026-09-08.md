# JOY Live Director R2 — Living Looks creator scorecard

**Status:** TASTE REVIEW COMPLETE — 2026-09-08.
The creator taste study and the Persian-script idiom review were owner-gated;
the owner has durably delegated taste calls on this project to Opus, and the
verdicts below were recorded under that delegation. Every pack now carries a
verdict: 2 `APPROVED`, 4 `CHANGES_REQUESTED`, 0 `REJECTED`. See
"Taste review — 2026-09-08" before the table for the ship decision (five packs
ship, `music-pulse` holds for R2.1).

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
- **`OWNER_TASTE_REVIEW: CHANGES_REQUESTED`** — 2026-09-08 (Opus, owner-delegated).
  Identity is coherent, restrained, and clearly distinct; the template-led
  hierarchy is the right call. But the `y` sign is inverted against the stated
  intent: `+y` is down (`joy-slide-up` in `packages/motion-core/src/presets.ts`
  starts at `base.y + 80` to rise from below), so `max: -48 / -36` starts the
  headline **above** its resting line and **drops** it into place. The pack
  docstring says "fade-up", the inline comment says "start lifted below the
  resting line", and this scorecard says "rise" — all three describe the opposite
  of what compiles, and turning Energy up gives the operator _more drop_, which
  reads as a heavy title card rather than the restrained editorial lift promised.
  **Change:** flip to `max: 48` (headline-y) and `max: 36` (deck-y). Nothing else
  changes; approve on that one fix.

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
  gives a crisp cut-on that suits "precision" rather than fighting it. Noted,
  not blocking: "Emphasis" drives both the late CTA pulse and the callout's
  entrance `x` nudge — two ideas on one slider — but that is a better trade than
  a fifth control.

### 3. Kinetic Type (`kinetic-type`)

- **Identity:** phrase-led typography with a distinct staggered entrance, hold,
  and exit. **Phrase-object-scoped, not per-word** — `motion.setKeyframe` binds a
  whole visual object.
- **Slots:** phrase-1 (required), phrase-2, phrase-3 (optional).
- **Controls:** Energy (scalar → per-phrase `scaleX/scaleY` 1→0.55 spring-in +
  `y` drop), Entrance (enum snap/soft/hold → per-phrase opacity), Phrase
  treatment (color → `outline-impact` / `bold-stack`).
- **Golden motion:** each bound phrase, staggered `0 → 0.12 → 0.24`: opacity
  `0 → 1` entrance, hold, then an eased exit back to the per-option rest
  (`snap` clears fully, `soft` to 0.3, `hold` stays up); scale `0.73 → 1`;
  `y` `38.4 → 0`. Entrance / hold / exit as the identity claims.
- **Constraints:** portrait `88 / 22 / 450_000`; landscape `60 / 34 / 450_000`.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`. **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; every phrase hold spans ≥
  `minHoldUs`; first phrase present after apply.
- **Scoped follow-up:** per-word animation + `text.insertTemplate` object
  creation are a compiler follow-up.
- **`OWNER_TASTE_REVIEW: CHANGES_REQUESTED`** — 2026-09-08 (Opus, owner-delegated).
  The best motion in the set: a real entrance → hold → exit on a single opacity
  curve, staggered `0 / 0.12 / 0.24`, a `0.73 → 1` spring, and a `y` rise from
  _below_ (`+38.4 → 0`, the correct direction — this scorecard's "y drop"
  wording above is what is wrong, not the pack). The defect is typographic, and
  typography is this pack's whole identity: only `phrase-1` has a text-template
  binding, so a three-phrase sequence renders phrase 1 in `outline-impact` and
  phrases 2–3 in whatever template they happened to carry — the signature look
  reaches a third of its own content. **Change:** add `phrase-2-treatment` and
  `phrase-3-treatment` text-template bindings and drive all three from the
  existing `treatment` control. No new control, no new operation kind.

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
2_500_000` — the longest `minHoldUs` of the six, deliberately.
- **Required ops:** `motion.setKeyframe`, `text.setTemplate`, `caption.setTemplate`.
  **Fonts:** none.
- **Engineering self-check:** ✅ deterministic; opacity is the only animated
  channel; holds respect the 2.5s minimum.
- **`OWNER_TASTE_REVIEW: APPROVED`** — 2026-09-08 (Opus, owner-delegated). The
  most disciplined pack of the six. Opacity-only is a real constraint honestly
  held — the `no-position-motion` predicate asserts it rather than leaving it to
  authoring care — the 2.5s `minHoldUs` genuinely earns the "listening space"
  claim, and the `0 → 0.55 → 1` eased profile is a slow fade with a shape rather
  than a linear ramp. Distinct from editorial-clean precisely by having no
  translate at all. Noted, not blocking: `Reveal` at 0 drives the _required_
  lower third to full transparency, so the operator can hide the mandatory
  element; the behaviour is monotonic and the default is 1, so it ships as-is —
  if a floor is ever wanted, 0.35 is the number.

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
- **`OWNER_TASTE_REVIEW: CHANGES_REQUESTED`** — 2026-09-08 (Opus, owner-delegated).
  **Hold this pack for R2.1.** Two problems, both in the L3 slider path, which is
  the only path an operator can reach in R2. The deferred audio panel is fine on
  its own; shipping a fallback that cannot produce the thing the pack is named
  after is not.

  1. **"Accent cuts" does not cut.** The compiler's boolean branch calls
     `emitKeyframes(bindingId, value, value, …)`, so rest equals full and the
     declared `profile: [0, 1, 0, 1, 0]` is mathematically inert. Compiled
     directly with `accent: true` on an 8s composition, `accent-opacity` emits
     `1.000` at all five keyframes — the accent mark is simply switched on
     permanently. This slips both guards: it passes "no fake slider" because it
     does drive a binding, and it passes "not a flat hold" because that check
     samples _default_ control values and `accent` defaults to `false`
     (`whenFalse: 'omit'`), so the flat track is never inspected. A control named
     "Accent cuts" that turns a mark permanently on is dishonest naming.
     **Change:** give `LookBooleanDrive` a live rest value so the profile takes
     effect (emit `whenFalse` as rest, `whenTrue` as full), or drop the profile
     and rename the control to what it does.
  2. **The pulse is not musical.** `atFractions` are composition-relative, so the
     pack emits exactly two swells per composition regardless of length — on the
     golden 8s composition that is a 4-second period, roughly 15 BPM — and at the
     0.3 default the excursion is `1.000 → 1.036`, a 3.6% scale change. Two
     near-invisible swells across a whole clip is a slow breath, not a music
     pulse, and no slider setting fixes it because the _rate_ is not a control at
     all; only depth is. **Change:** add a rate control that generates N pulse
     periods (fractions derived from a BPM or cycles-per-composition value)
     instead of a fixed five-key table, and raise the default depth so the
     default state reads as motion.

  Also fold into the same pass: `subject-treatment` applies a **text** template
  (`neon-keyword`) to a slot labelled "Pulsing subject", a generic
  `visual-object`. Bind a logo or product shot there and the pack emits
  `text.setTemplate` against a non-text object. Either name the slot so the text
  expectation is explicit, or gate the control on a text-bearing binding.

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
- **`OWNER_TASTE_REVIEW: CHANGES_REQUESTED`** — 2026-09-08 (Opus, owner-delegated).
  The pack _data_ is right and the RTL mechanics are better than most
  implementations manage. One shipped Persian string is wrong in a way a native
  reader notices immediately, and it is a one-word fix.

  **What is correct.** The `x` direction is idiomatic and deliberate: `+x` is
  right (`joy-slide-in-right` uses `offset: 280`), so the headline starts
  `+16.8px` right of rest and settles leftward — entering from the reading side,
  the proper RTL mirror of an LTR slide-in-from-left. `direction: 'rtl'` with
  `align: 'start'` resolves start to the right edge, and stays correct if a
  template is ever reused LTR. In `rtl-quote-focus` the coloured runs
  (`'ایده‌ها '` / `'دیدنی'` / `' می‌شوند'`) split only at spaces, so no
  Arabic-script joining is broken across run boundaries — a detail frequently
  got wrong, and got right here. `داستان از اینجا شروع می‌شود` and
  `ایده‌ها دیدنی می‌شوند` are both grammatical with correct ZWNJ; `دیدنی` over
  `دیده` is a poetic choice but it scans and suits a media brand. Vazirmatn over
  a commercial foundry is the right call.

  **What must change.** In `apps/editor-web/src/text-template-catalog.ts`, the
  `rtl-name-role` preview reads `هادی متین\nکارگردان خلاق`. `کارگردان` is a
  _film director_ — the person who directs a film — so this reads as "creative
  film-director", which is not a byline role. The Persian industry term for
  Creative Director is **`مدیر خلاق`**. Change the preview to
  `هادی متین\nمدیر خلاق`.

  **Recommended in the same pass.** The slot label `نام و نقش (Name / role)`
  has the same class of error: `نقش` is a role _played_ (a part in a film or
  play), whereas `سمت` is the standard Persian word for a professional position.
  A Persian newsroom would write **`نام و سمت`**. Optional: `عنوان` is fine, but
  `تیتر` is the actual Persian press word for a headline and suits a pack called
  Persian _Editorial_ better. `صفحه‌آرایی`, `زیرنویس` and `انرژی` are all
  idiomatic with correct ZWNJ — no change.

  **Adjacent, non-blocking (does not gate this pack).**
  `packages/captions-core/src/rtl-fixtures.ts` line 27 has `واژه های انگلیسی`,
  missing the ZWNJ on the plural suffix — it should be `واژه‌های انگلیسی`. As
  written, the fixture's `.split(' ')` also tokenises it into two caption words
  (`واژه` + `های`), which is not how Persian ever tokenises. `محدوده امن` should
  carry the ezafe as `محدودهٔ امن`. Worth fixing because this is the string the
  RTL safe-area stress test leans on.

## Owner review section (to be completed by the owner)

For each pack, record: `OWNER_TASTE_REVIEW: APPROVED | CHANGES_REQUESTED | REJECTED`,
a date, and notes. R2 does not ship a pack whose line still reads `PENDING`.

### Taste review — 2026-09-08 (Opus, owner-delegated)

Reviewed under the owner's standing delegation of taste calls on this project.
All six packs read; `compileLook`, `validate.ts` and `types.ts` read; the golden
snapshots checked against the sources; the 120 motion-core Look tests re-run
green; the sign conventions established from `packages/motion-core/src/presets.ts`
(`+y` is down, `+x` is right) rather than assumed.

**Overall read.** The set is genuinely art-directed, not six re-skins of one
curve. Each pack has a defensible reason to exist — template-led hierarchy,
timed emphasis, entrance/hold/exit typography, opacity-only restraint, RTL
editorial — and the declarative discipline is real: no model in the apply path,
bounded amplitudes, verification predicates that assert the identity claims
instead of trusting them. The compiled motion is mostly honest, which is the
hard part.

Three findings the green suite could not catch, because they are disagreements
between what a pack _claims_ and what it _compiles_, not failures:

- **editorial-clean** promises a fade-up in three places and compiles a drop-in.
  The sign is inverted; its own inline comment describes the intended behaviour
  correctly and the number contradicts it.
- **kinetic-type** is a typography pack that applies its signature treatment to
  one of its three phrases.
- **music-pulse** ships a control named "Accent cuts" that compiles to a flat
  permanent on — the boolean branch passes `(value, value)` into
  `emitKeyframes`, so the declared profile is inert — and a "pulse" that is two
  ~3.6% swells per composition at any clip length, because rate is not a control.

The first two are small, mechanical, and worth re-cutting for. The third is
structural.

**Ship decision — R2 ships five, holds one.**

- **Ship (5):** `editorial-clean`, `product-precision`, `kinetic-type`,
  `quiet-documentary`, `persian-editorial`. Two of these are approved as-is
  (`product-precision`, `quiet-documentary`); three ship once their named fix
  lands — a sign flip, two extra bindings, and one Persian word. None touches the
  schema, the operation vocabulary, or the compiler, so the candidate can be
  re-cut cheaply and the goldens re-blessed.
- **Hold for R2.1 (1):** `music-pulse`. Its fixes are a compiler change to
  `LookBooleanDrive` plus a new rate control, which is real design work and
  should not be rushed into this candidate. Deferring the audio panel path was
  never the problem; the slider-only fallback not being able to pulse is. Holding
  it also lets the audio-reactive feel and the fixed slider feel be reviewed
  together, once, instead of twice.

Five packs is a strong, coherent built-in set. Shipping a sixth that cannot do
what its name says would cost more trust than the extra tile buys.

| Pack              | Verdict           | Date       | Notes                                                                                                                                   |
| ----------------- | ----------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| editorial-clean   | CHANGES_REQUESTED | 2026-09-08 | Coherent and restrained, but `y` sign inverted vs. the stated fade-up — it drops in. Flip `max` to `+48` / `+36`. Ships on that fix.    |
| product-precision | APPROVED          | 2026-09-08 | Timed emphasis rather than an entrance; bounded CTA pulse that returns to rest; declining to reframe is the honest call. Ships as-is.   |
| kinetic-type      | CHANGES_REQUESTED | 2026-09-08 | Best motion in the set, but only `phrase-1` gets the text treatment. Add `phrase-2/3-treatment` bindings to the existing control.       |
| quiet-documentary | APPROVED          | 2026-09-08 | Most disciplined pack; opacity-only held by an asserting predicate, longest holds, real eased profile. Ships as-is.                     |
| music-pulse       | CHANGES_REQUESTED | 2026-09-08 | **Hold for R2.1.** "Accent cuts" compiles to a flat permanent on; the pulse is ~2 swells of 3.6% per composition because rate is fixed. |
| persian-editorial | CHANGES_REQUESTED | 2026-09-08 | RTL mechanics and `x` direction idiomatic and correct. `کارگردان خلاق` → `مدیر خلاق` in `rtl-name-role`; `نام و نقش` → `نام و سمت`.     |

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
