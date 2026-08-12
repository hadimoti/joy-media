# WP-34 — Universal Animation and Editor Information Architecture

**Status:** Planned — implementation has not started  
**Prepared:** 2026-08-13  
**Priority:** P0 foundation, followed by domain slices  
**Prerequisites:** WP-31, WP-32, WP-33  
**Orchestrator:** GPT  
**Primary patch executor:** Mistral Vibe in isolated local worktrees  
**VPS-only executor:** Hermes in `/opt/joy-media/repo`  
**Execution mode:** Vibe-first, lights-out capable, no routine user-input requests  
**Production:** `https://joyst.ir/` through the existing immutable editor-release workflow

## 1. Mission

Reorganize the editor so users see a small number of clear creative surfaces, then make every logically temporal creative adjustment animatable with After Effects-level interaction semantics.

This does **not** mean attaching a diamond to every input. It means:

1. every creative property is registered and explicitly classified as continuously animatable, hold-key animatable, specially animated, or intentionally static;
2. Inspector is the authoritative place to edit selected-object properties;
3. Timeline/Animate is the authoritative place to inspect and shape animation over time;
4. specialized workspaces such as Color and Audio keep their professional controls but use the same animation, command, undo, evaluation, and accessibility primitives;
5. preview, browser export, and future headless rendering consume the same evaluated values;
6. one pointer gesture produces one undo step, and Escape cancels it;
7. old projects retain their appearance and are upgraded lazily only when edited.

The target is a minimal, progressive-disclosure UI: ordinary editing remains simple, while keyframes, interpolation, graphs, expressions, and advanced lanes appear only when the user asks for them.

## 2. Completion definition

WP-34 is complete only when all of the following are true:

- A generated coverage report accounts for every adjustable property in Assets, Inspector, Effects, Transitions, Captions, Audio, Color, Camera, Motion/Animate, and HTML scenes.
- Every registered property has an explicit animation policy and a reason; an omitted policy fails tests.
- A user can animate all eligible visual, effect, color, audio, transition, camera, text, caption-style, and HTML-scene properties from one consistent control pattern.
- Continuous values support Hold, Linear, Eased, and Bezier interpolation where meaningful.
- Boolean, enum, text, preset, and asset-choice properties use hold keys only, and only where a temporal switch is meaningful and safely preloadable.
- Speed/time remapping uses a monotonic source-time curve rather than pretending to be an ordinary scalar property.
- Animated properties appear as expandable Timeline lanes and can be edited in Dope Sheet and Graph views.
- Main Inspector effect keyframes actually affect Program Monitor and browser export; Effect Studio no longer owns a disconnected animation path.
- Clip and Output color animation preserve the WP-33 rendering order.
- Audio automation is sample/block accurate enough for preview and export and does not create zipper noise.
- Every drag, wheel move, curve move, or scrub commits exactly one durable command; Escape commits none.
- Saved workspace layouts migrate without losing the user's custom arrangement.
- Default workspaces no longer present 19 equal-weight tabs or duplicate property controls.
- Legacy project fixtures render unchanged before the first WP-34 edit.
- Full CI, responsive UI checks, browser smoke tests, and an immutable staging deployment pass before production promotion.

## 3. Evidence from the current product and repository

### 3.1 Live UI audit

The live editor currently exposes these top-level surfaces:

- Library group: Assets, Effects, Transitions, Captions, Audio, Color, Plugins.
- Context group: Inspector, Motion, History, Jobs, Diagnostics, Workflows, Camera.
- Separate Joy Code, Timeline, Dual Lens, Program Monitor, and Templates panels.

The current grouping makes unlike concepts appear equivalent:

- catalog browsing, selected-object properties, professional grading, runtime administration, and diagnostics share tab rows;
- Templates occupies monitor space even though it is a library;
- Motion is partly a reusable-motion library and partly an animation editor;
- Audio contains creative controls, enhancement workflows, runtime/backend state, and job controls in one dense panel;
- Inspector Audio and the Audio panel duplicate gain/pan/mute concepts;
- Effects can be adjusted in Inspector and Effect Studio, but the animation path is not unified with the main renderer;
- Camera repeats transform controls instead of allowing Inspector to edit the selected camera;
- Timeline and Dual Lens are parallel panels even though Dual Lens is a timeline view;
- Jobs, Diagnostics, and Plugins consume default creative-tab space.

### 3.2 Existing implementation to preserve and promote

WP-34 must reuse, not replace, these working foundations:

- `AnimationCurveV1`, keyframe interpolation, sampling, copy/paste, and spatial paths in `@joy-media/motion-core`.
- Existing Visual Object transform animation and restricted expressions.
- `EffectParamDescriptor.animatable` and `EffectInstanceV1.animations`.
- The Graph Editor's key selection, Bezier handles, interpolation, and navigation.
- Motion Studio's begin/update/commit/cancel transient transaction pattern.
- The command history's semantic inverse and coalescing support.
- `PanelShell`, panel metadata, workspace presets, and Dockview persistence.
- WP-33's `ColorGradeV2`, Clip/Output target model, CPU/GPU grading path, and renderer ordering.
- Existing caption documents/templates, audio graph, transition shader descriptors, and camera objects.

Known gaps that WP-34 must close:

- Visual-object animation is limited to seven scalar transform channels.
- Effect animation exists in schema and Effect Studio but is ignored by the main visual render normalization path.
- Several sliders dispatch durable commands on every `onChange`.
- The main Graph Editor commits during pointer movement instead of one command on release.
- Color, audio, transition, caption style, camera FOV, and most appearance/typography controls have no shared animation address.
- Motion Studio has a second capability/transaction model that is not shared by the main editor.
- There is no exhaustive property registry that forces an animation decision for every adjustment.

## 4. Non-negotiable product rules

### 4.1 One property, one authoritative editor

- Inspector edits the selected clip/object/effect/camera/caption properties.
- Effects and Transitions panels browse and apply items; they do not duplicate parameter editors.
- Color remains a specialized grading surface because wheels, curves, HSL, scopes, and compare tools need domain UI.
- Audio remains a specialized mixing/enhancement surface, but clip properties shared with Inspector are backed by the same property address and command.
- Animate/Timeline edits timing and interpolation; it does not maintain a second static value.
- Any property shown in more than one surface must resolve to the same descriptor, static value, animation, command, and evaluated value.

### 4.2 Animation eligibility test

A property may be keyframed only if all five answers are yes:

1. Does changing it over time have a clear creative meaning?
2. Can its owner and time domain be identified unambiguously?
3. Can preview and export evaluate it deterministically?
4. Can the value be interpolated or switched without corrupting structure?
5. Can undo, duplication, split, delete, reload, and missing-dependency behavior be defined?

If any answer is no, the property stays static until the missing contract is designed.

### 4.3 Never keyframe these categories

- Workspace layouts, active panel tabs, searches, filters, sorting, zoom, pinned scopes, and other UI preferences.
- Project names, asset ownership, imports/uploads, media hashes, relink operations, cloud/local state, favorites, and library collections.
- Track/clip IDs, parent graph topology, effect order, bus routing, plugin installation, and workflow graph structure.
- Runtime backend/model/device selection, worker capability state, job state, logs, diagnostics, provider credentials, and process controls.
- Export preset, output dimensions/frame rate, codec, destination, and delivery settings.
- Caption cue timing, word timing, transcription provenance, and speaker segmentation; these already represent temporal document structure.
- Transition type and duration; duration is timeline structure and type replacement changes the implementation contract.
- Camera creation/deletion/parenting and active-camera assignment. Camera cuts belong in a dedicated camera-cut track in a later slice, not a generic property curve.
- Track lock, track visibility, solo monitoring, selection, bypass used only for monitoring, false color, scopes, pixel probe, and A/B wipe state.

### 4.4 Interpolation policies

- `continuous`: numeric scalar channels; supports Hold, Linear, Eased, and Bezier.
- `angle`: numeric but unwrapped, allowing multiple rotations; UI may display normalized degrees.
- `hue`: shortest-path interpolation around the hue circle unless a key explicitly requests long-path rotation later.
- `color`: interpolate RGB in linear-sRGB working space and alpha linearly; convert only at UI/render boundaries.
- `vector`: independent component curves with one atomic property command.
- `hold`: boolean, enum, source text, template choice, and safe/preloaded asset choice.
- `curve-snapshot`: canonical bounded samples morphed channel-by-channel; control-point topology is never interpolated directly.
- `time-remap`: monotonic source-time mapping with dedicated constraints and UI.

## 5. Target editor information architecture

Durable panel IDs should remain readable during migration. Renames and merges first use aliases and layout migration; removal occurs only after two successful release cycles.

| Current panel      | Target disposition                                                       | User-facing role                                                                                        |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Assets (`media`)   | Keep; rename surface to **Library** with Assets as its first tab         | Import, search, browse, organize, and add media                                                         |
| Templates          | Move into Library as **Templates**                                       | Browse reusable templates, caption looks, motions, and scenes                                           |
| Effects            | Keep in Library/Enhance as a catalog                                     | Browse, preview, and apply; edit parameters in Inspector                                                |
| Transitions        | Keep in Library/Enhance as a catalog and junction browser                | Apply/replace a transition; selected transition parameters appear in Inspector                          |
| Captions           | Keep as a dedicated transcript/cue workspace                             | Transcribe, import/export, edit language content and cue structure                                      |
| Inspector          | Expand as the canonical property editor                                  | Visual, Appearance, Effects, Audio, Caption, Camera, Speed, and Advanced sections as selection requires |
| Motion             | Rename to **Animate**; move “My Motions” browsing to Library/Templates   | Animated Properties, Dope Sheet, Graph, Paths, Presets                                                  |
| Color              | Keep as a specialized Enhance workspace                                  | Clip/Output grading and monitoring using shared animation primitives                                    |
| Audio              | Keep as a specialized Audio workspace                                    | Mixer, Enhance, Effects, Loudness; no duplicate clip-property implementation                            |
| Camera             | Reduce to **Camera Rig** management                                      | Create/select/manage cameras and active rig; selected camera properties live in Inspector               |
| Timeline           | Keep and add Edit/Keys/Graph view modes                                  | Clip structure plus expandable property lanes                                                           |
| Dual Lens (`flow`) | Merge into Timeline as **Flow** view; preserve an alias during migration | Alternate timeline/workflow view, not a separate default panel                                          |
| Program Monitor    | Keep alone in the monitor dock                                           | Playback, overlays, diagnostics, compare controls                                                       |
| History            | Keep as a secondary context tab                                          | Undo/redo audit and named history entries                                                               |
| Joy Code           | Keep in Automate workspace                                               | Natural-language/project change-set authoring                                                           |
| Workflows          | Keep in Automate workspace                                               | Reusable automation graphs and runs                                                                     |
| Jobs               | Rename **Process Center** and keep in Automate/Window                    | Background work and export/transcription status                                                         |
| Diagnostics        | Move out of default creative docks to Window > System                    | Technical health and troubleshooting                                                                    |
| Plugins            | Move out of default creative docks to Window > System                    | Installation, permissions, and safe mode                                                                |

### 5.1 Default workspaces

#### Edit

- Left: Library — Assets, Templates, Effects, Transitions.
- Center: Program Monitor.
- Right: Inspector, History.
- Bottom: Timeline with Edit/Keys/Graph modes.
- Joy Code is closed by default but one command/menu action away.

#### Enhance

- Left: Effects/Transitions catalog or Color controls, depending on last local preference.
- Center: Program Monitor.
- Right: Inspector and Animate.
- Bottom: Timeline Keys view.
- Color may expand wider while scopes are visible; it must not force a permanently tiny monitor.

#### Audio & Captions

- Left: Captions transcript or Audio Enhance.
- Center: Program Monitor.
- Right: Inspector or Audio Mixer.
- Bottom: Timeline with waveform/automation lanes.

#### Automate

- Left: Workflows and Process Center.
- Center: Joy Code.
- Right: Inspector/Diagnostics when explicitly opened.
- Bottom: Timeline/Flow.

#### Custom

- Preserves the user's Dockview state independently of named presets.
- A v2 migration maps old panel IDs/groups but never overwrites a valid custom layout merely because defaults changed.

### 5.2 Responsive behavior

- Property panels must work at 320, 360, 420, 480, and 560 px widths.
- At narrow widths, a property row becomes two lines: label/actions first, control/value second.
- Advanced sections remain collapsed unless animated or explicitly opened.
- Monitor receives first claim on horizontal growth; utility panels use bounded widths.
- System panels never auto-open over a creative workspace after reload.
- Tab labels remain visible when space permits; icon-only tabs require accessible names and tooltips.

## 6. Keyframe eligibility by creative domain

This matrix is the starting contract. The property registry produced by WP-34 must be more granular and executable.

| Domain             | Continuous / Bezier                                                                                          | Hold-only                                                                   | Special handling                                           | Intentionally static                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Transform          | position X/Y/Z, anchor, scale X/Y, rotation, opacity, skew, crop edges, corner radius                        | visibility if exposed as a creative property                                | spatial position path, motion blur sampling                | parent, object kind, source asset                              |
| Appearance         | fill/stroke color and opacity, stroke width, shadow offset/blur/spread/opacity                               | gradient/pattern preset only after preload support                          | gradient stops require stable stop IDs                     | blend mode, stacking order                                     |
| Visual text        | font size, tracking, line height, paragraph spacing, transform, colors                                       | source text, alignment, font style/family when bundled and preloaded        | text-on-path/path morph is deferred until topology exists  | language metadata and external font installation               |
| Effects            | every descriptor marked `animatable`; numeric/vector/color channels                                          | descriptor-approved boolean and enum; effect enabled                        | effect-specific normalized curves where declared           | effect order, add/remove, incompatible preset replacement      |
| Color Adjust       | temperature, tint, exposure, contrast, pivot, highlights, shadows, whites, blacks, saturation, vibrance, hue | bypass only if it is a creative target property, not monitor bypass         | hue wrap                                                   | target selection and scope layout                              |
| Color Wheels/HSL   | wheel RGB/master, HSL hue/saturation/luminance/range/softness                                                | none by default                                                             | hue wrap; stable semantic HSL band IDs                     | HSL band creation/order in WP-34                               |
| Color Curves/Looks | LUT intensity                                                                                                | built-in look or LUT choice only after dependency preload/export validation | each curve key stores/morphs a canonical 256-sample table  | LUT import/relink/delete, scopes, false color                  |
| Audio clip         | gain, pan, fade level/shape parameters, supported FX params                                                  | mute                                                                        | sample/block evaluation and de-zippering                   | solo, source replacement, routing                              |
| Audio bus          | gain, pan, supported insert/send amounts                                                                     | mute                                                                        | sample/block evaluation                                    | bus inputs/order, solo, device/backend                         |
| Captions           | clip-level position/scale/opacity, font size/tracking/line height, text/plate/highlight colors               | alignment/template choice when preloaded                                    | karaoke progress remains derived from word timing          | cue/word timing, transcription text history, speaker structure |
| Camera             | X/Y/Z, roll, field of view                                                                                   | none                                                                        | spatial path and focus controls if later added             | create/delete, parenting, active camera assignment             |
| Transition         | shader uniforms declared animatable, progress easing controls                                                | descriptor-approved enum/bool                                               | transition-local time from 0 to duration                   | type, duration, left/right clip ownership                      |
| Speed              | none through ordinary scalar curves                                                                          | freeze-frame switch only in time-remap model                                | monotonic source-time curve, reverse segments, speed ramps | source duration and media identity                             |
| HTML scene         | manifest-declared numeric/vector/color inputs                                                                | manifest-declared bool/enum/string                                          | scene-local time and deterministic sandbox evaluation      | undeclared DOM/CSS paths and network/runtime state             |
| Motion Scene       | transform, appearance, typography, mask controls already declared animatable                                 | supported discrete layer properties                                         | path/mask topology and scene-local animation document      | layer identity/order/group topology                            |

## 7. After Effects-level interaction contract

### 7.1 Universal property row

Every animatable row uses the same semantic pieces, even when a specialized visual control renders the value:

```text
[stopwatch] Property label     [previous] [diamond] [next] [reset] [graph]
                              [slider / wheel / input / picker] [numeric value]
```

- Stopwatch off: edits the static/base value.
- Turning the stopwatch on creates the first key at the playhead using the current evaluated value.
- Stopwatch on: editing at the playhead updates that key; editing at another time creates a key there.
- Diamond state distinguishes no key at time, key at time, and keys elsewhere.
- Previous/next navigates this property's keys without changing selection ownership.
- Turning animation off removes the curve and preserves the current evaluated value as the new static value in one undoable command.
- Reset resets the static value or the key at the playhead according to animation state.
- Double-click on the value control performs the same reset.
- Graph opens/focuses the property lane in Animate/Timeline Graph mode.
- A visible expression/binding indicator replaces the editable animation controls when an expression owns evaluation; retained keys remain underneath and reappear when the expression is disabled.
- Value fields show the evaluated value; an optional secondary readout exposes the underlying static value when it differs.

### 7.2 Gesture and undo semantics

All slider, wheel, point, tangent, drag, and scrub controls use:

```text
pointerdown / focus-start
  -> capture durable before-state
pointermove / input
  -> write transient preview overlay only
pointerup / Enter / blur
  -> normalize and dispatch one durable reversible command
Escape / pointercancel
  -> discard transient overlay and restore before-state
```

- No persistence, collaboration event, agent event, or history entry is emitted during transient movement.
- Keyboard auto-repeat coalesces until keyup or 400 ms idle, whichever comes first.
- A compound property such as color or vector commits atomically even if only one channel moved.
- Graph key/tangent drags obey the same rule.
- A drag across many frames must never create one key per pointer event.

### 7.3 Key editing behavior

- Keys snap to frames by default; Alt temporarily disables snapping.
- Shift extends key selection; marquee selection and copy/paste preserve relative time.
- Moving selected keys cannot cross the owner's valid time bounds.
- Duplicate-time keys normalize to one key using the last explicit edit.
- Bezier handles remain finite and bounded; malformed imported handles fall back to linear.
- Hold properties never display Bezier controls.
- Graph Editor supports value graph first; speed graph is added only for properties whose derivative has a useful meaning.
- “Show Animated” reveals all animated properties on selected owners; “Show Modified” also includes non-default static properties.

### 7.4 Multi-selection

- Static multi-edit is allowed only where the descriptor's multi-edit policy permits it.
- Animation controls are enabled for multi-selection only when all selected owners share the descriptor and compatible time domains.
- A multi-owner gesture emits one atomic transaction containing one normalized animation edit per owner.
- Mixed animation state is visibly represented; it is never silently flattened.

## 8. Durable animation architecture

### 8.1 Typed property binding

Do not store arbitrary JSON paths. Add versioned, validated property bindings whose IDs come from registered descriptors.

```ts
type PropertyOwnerV2 =
  | { readonly kind: 'visual-object'; readonly objectId: string }
  | {
      readonly kind: 'effect';
      readonly objectId: string;
      readonly effectInstanceId: string;
    }
  | { readonly kind: 'clip'; readonly clipId: string }
  | { readonly kind: 'transition'; readonly transitionId: string }
  | { readonly kind: 'color-output' }
  | { readonly kind: 'color-clip'; readonly clipId: string }
  | { readonly kind: 'audio-clip'; readonly clipId: string }
  | { readonly kind: 'audio-bus'; readonly busId: string }
  | { readonly kind: 'audio-effect'; readonly effectInstanceId: string }
  | { readonly kind: 'caption-clip'; readonly clipId: string }
  | {
      readonly kind: 'motion-scene-layer';
      readonly sceneId: string;
      readonly layerId: string;
    };

type AnimationTimeDomainV2 =
  | 'composition'
  | 'clip-local'
  | 'transition-local'
  | 'output'
  | 'caption-clip-local'
  | 'scene-local'
  | 'audio-timeline';

interface PropertyBindingV2 {
  readonly version: 2;
  readonly owner: PropertyOwnerV2;
  readonly propertyId: string;
  readonly timeDomain: AnimationTimeDomainV2;
}
```

The binding object is authoritative. A canonical escaped binding key indexes the map and is recomputed/validated on load; callers never concatenate ad hoc paths.

Camera properties use the `visual-object` owner with descriptors such as `camera.fieldOfViewDeg`. Visual text and appearance properties use the same owner. Motion-scene documents reuse the binding/animation types but may store their collection in the scene document rather than the main project.

### 8.2 Value representation

```ts
type AnimationValueKindV2 =
  | 'number'
  | 'angle'
  | 'hue'
  | 'vector2'
  | 'vector3'
  | 'color'
  | 'boolean'
  | 'enum'
  | 'string'
  | 'curve-snapshot';

interface DiscreteKeyframeV2 {
  readonly timeUs: number;
  readonly value: boolean | string;
}

interface PropertyAnimationV2 {
  readonly version: 2;
  readonly binding: PropertyBindingV2;
  readonly valueKind: AnimationValueKindV2;
  readonly channels?: Readonly<Record<string, AnimationCurveV1>>;
  readonly holdKeys?: readonly DiscreteKeyframeV2[];
  readonly curveSnapshots?: readonly {
    readonly timeUs: number;
    readonly samples: readonly number[];
    readonly interpolation: KeyframeInterpolationV1;
  }[];
}
```

Rules:

- Scalar values use channel `value` and the existing `AnimationCurveV1`.
- Vectors use named numeric channels such as `x`, `y`, and `z`.
- Colors use `r`, `g`, `b`, and `a` normalized channels; commands remain atomic at the property level.
- Discrete values use sorted hold keys only.
- Color curves use a fixed-size bounded snapshot table, initially 256 samples per channel.
- Empty/identity animation entries are removed rather than persisted.
- Validators reject unknown channels, NaN/Infinity, duplicate key times after normalization, mismatched binding keys, invalid owners, and invalid time domains.

Add an optional main-project collection:

```ts
interface JoyProjectV1 {
  readonly propertyAnimations?: Readonly<Record<string, PropertyAnimationV2>>;
}
```

This is an optional extension of schema version 1, matching the existing compatibility strategy. Do not rewrite untouched documents merely because they were opened.

### 8.3 Property descriptors

Use `@joy-media/property-system` as the generic contract. Domain packages contribute descriptors; the editor and evaluator compose the same registry.

```ts
interface PropertyDescriptorV2<T = unknown> {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly ownerKinds: readonly PropertyOwnerV2['kind'][];
  readonly valueKind: AnimationValueKindV2;
  readonly defaultValue: T;
  readonly constraints?: {
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly unit?: string;
  };
  readonly animation:
    | { readonly policy: 'continuous' | 'angle' | 'hue' | 'color' | 'vector' }
    | { readonly policy: 'hold' }
    | { readonly policy: 'curve-snapshot' }
    | { readonly policy: 'time-remap' }
    | { readonly policy: 'static'; readonly reason: string };
  readonly expressionCapable: boolean;
  readonly multiEdit: 'none' | 'same-kind' | 'compatible';
  readonly renderImpact: 'layout' | 'paint' | 'effect' | 'audio' | 'structure';
}
```

- Built-in transform/camera/text descriptors live in the pure property/domain package, not React.
- Effect descriptors adapt `EffectParamDescriptor.animatable`; no second list is hand-maintained.
- Color, audio, captions, transitions, and HTML-scene manifests contribute stable descriptors from their domain packages.
- A registry test fails when two descriptors reuse an ID incompatibly.
- UI labels/ranges/defaults and evaluator normalization come from the same descriptor.
- Every user-adjustable control must name a descriptor ID or explicitly declare itself UI-only/structural.

### 8.4 Evaluation order

At a requested time:

1. Resolve owner and convert project time to the binding's explicit time domain.
2. Read the static/base value.
3. If a V2 animation exists, sample and reconstruct its value.
4. Otherwise, sample the compatible legacy visual/effect curve if present.
5. Evaluate a supported expression/binding last; on failure, safely fall back to the animated/static value.
6. Normalize/clamp through the descriptor.
7. Write the result into a frame-local evaluated snapshot.
8. Build Render IR or the audio processing plan using evaluated static values.

Render IR remains frame-oriented and must not become a persistence format for keyframes. Browser preview, browser export, and CPU reference rendering call the same evaluator. Audio receives time-varying automation at sample/block boundaries through a dedicated adapter.

### 8.5 Legacy compatibility

- Existing `VisualObjectV1.animations` and `EffectInstanceV1.animations` remain valid and render unchanged.
- V2 takes precedence for one property only when that exact binding exists.
- First edit of a legacy animated property converts only that property to V2 and removes only its legacy duplicate.
- Opening, viewing, exporting, or saving an untouched legacy project must not eagerly migrate it.
- Expressions retain current precedence over keyframe/static values.
- Golden fixtures compare old and new evaluators at boundaries, midpoints, before-first, and after-last times.

### 8.6 Ownership lifecycle

- Split: copy clip-owned animations to both new clip IDs with time rebasing appropriate to each half.
- Duplicate/copy-paste: deep-copy eligible owner bindings to the new stable IDs.
- Delete: remove orphaned animation entries in the same transaction; undo restores both owner and entries.
- Effect duplicate: allocate a new effect instance ID and copy its animations.
- Effect delete/reorder: delete restores animations on undo; reorder does not change binding identity.
- Caption clip duplicate: copy clip-style animation; the shared caption document remains shared unless content is explicitly duplicated.
- Color clip grade duplicate/split follows the WP-33 clip-ID rules and also copies its color animations.
- Scene layer duplicate/delete follows the same contract inside the motion-scene document.
- A project validator reports orphaned bindings; a safe repair command may remove them only with explicit user action.

### 8.7 Commands and agent interface

Add one reversible normalized command family, not one command per panel:

```ts
type PropertyAnimationCommand =
  | {
      readonly type: 'animation.replace';
      readonly payload: {
        readonly binding: PropertyBindingV2;
        readonly previous?: PropertyAnimationV2;
        readonly next?: PropertyAnimationV2;
      };
    }
  | {
      readonly type: 'animation.setStatic';
      readonly payload: {
        readonly binding: PropertyBindingV2;
        readonly value: unknown;
      };
    };
```

The command applier derives the inverse from validated current state; callers do not get to lie about `previous`. The conceptual shape above may be adjusted to match the existing command envelope, but the normalized binding and one-property atomicity are mandatory.

Extend agent/change-set operations with:

- `listPropertyDescriptors(owner)`;
- `readProperty(binding, timeUs)` returning static, animated, evaluated, and key state;
- `setStaticProperty(binding, value)`;
- `enableAnimation(binding, timeUs)`;
- `setPropertyKey(binding, timeUs, value, interpolation)`;
- `removePropertyKey(binding, timeUs)`;
- `replacePropertyAnimation(binding, animation)`;
- `disableAnimation(binding, preserveTimeUs)`.

Agent operations pass the same validation and command path as UI operations. No agent can mutate raw project JSON or address an unregistered path.

## 9. Domain-specific implementation requirements

### 9.1 Visual transform, appearance, and text

- Use the existing transform curve data as the first reference migration.
- Add stable descriptors for anchor, crop, skew, corner radius, fill/stroke/shadow, and typography only where the durable static model exists.
- Do not create UI-only animation for a property the renderer cannot persist and evaluate.
- Source Text is hold-key animatable for visual text objects; caption transcript text is not.
- Spatial position and scalar X/Y curves must have one clear ownership mode. Switching to a spatial path converts explicitly and is undoable; they never compete silently.
- Rotation remains unwrapped internally so multiple revolutions work.

### 9.2 Effects

- Main Inspector renders parameter controls from effect descriptors and displays animation controls for every eligible parameter type.
- Effect Studio consumes the same property binding/evaluator instead of maintaining an isolated keyframe implementation.
- Main visual normalization samples effect animation before passing resolved params to shaders/CPU effects.
- Boolean/enum effect parameters use hold keys when the descriptor allows them.
- Vector/color effect parameters use compound channels and one transaction.
- Effect bypass/enabled may use hold keys; effect add/remove/order stay structural.
- Preview/export parity fixtures cover every first-party animatable effect class.

### 9.3 Color

- Register separate Clip and Output bindings; the owner determines local/output time.
- Adjust, wheel, HSL, and LUT intensity values use continuous channels.
- HSL bands receive stable semantic IDs; animation never addresses a fragile array index.
- Hue channels use wrap-aware interpolation.
- Color curves serialize canonical sample snapshots for animation; knot count/order may change between keys without topology corruption.
- Built-in look/LUT choice becomes hold-key animatable only after both alternatives are preloaded, hash-validated, and export dependency checks pass.
- Scope, false-color, split-wipe, probe, and target UI state never enter project animation.
- Clip grade still evaluates before effects/transitions; Output grade remains after compositing.

### 9.4 Audio

- Clip gain/pan/mute/fades and bus gain/pan/mute receive stable bindings.
- First-party audio effect descriptors declare animation policies and smoothing requirements.
- Continuous automation is interpolated per audio block with ramps between block endpoints; parameters prone to zipper noise require de-zippering.
- Browser preview and browser export use the same normalized automation curves.
- Solo is monitor state, not project animation.
- Routing, source replacement, enhancement model/device, runtime provider, and job controls remain static/operational.
- Inspector Audio and Audio workspace controls become two views of the same bindings, not duplicated state.

### 9.5 Captions

- Keep transcript/cue structure in Captions.
- Add clip-level caption style overrides keyed by caption clip ID so reused documents can animate independently.
- Inspector Caption exposes position, scale, opacity, typography, plate, and active-word appearance.
- Caption style animation uses caption-clip-local time; karaoke activation remains derived from word timing.
- Template/alignment changes may use hold keys after required template/font assets are available.
- Cue text and word timing remain structural. Users who need hold-key Source Text use a visual text layer, not a transcript cue.

### 9.6 Camera

- Camera Rig keeps creation, selection, parent, and active-camera management.
- Selecting a camera exposes transform and field of view in Inspector.
- X/Y/Z, roll, and field of view use ordinary continuous animation and the existing spatial path where applicable.
- Active camera is not keyframed. A future camera-cut track is the correct model for cuts.

### 9.7 Transitions

- Transition shader descriptors declare which uniform parameters are animatable and their safe ranges/defaults.
- A selected junction exposes these properties in Inspector Transition.
- Keys use transition-local time from zero to the transition duration and rebase predictably when duration changes.
- Transition progress/easing may use a dedicated curve; type, duration, and clip ownership remain structural.
- Both transition inputs retain their independently evaluated clip grades/effects before blending.

### 9.8 Speed and time remapping

Speed is a separate subproject and must not ship as a normal scalar keyframe row.

- Model a monotonic mapping from output-local time to source-local time.
- Represent speed ramps as the derivative of that mapping.
- Validate source bounds, freeze segments, reverse policy, continuity, and audio behavior.
- Provide a dedicated Time Remap lane with source-time and speed views.
- Preserve existing static playback rate until the first time-remap edit.
- Define ripple/trim/split/duplicate/reverse behavior and add fixtures before exposing editing UI.
- If reverse audio/time-stretch parity is unavailable, surface the limitation explicitly instead of silently producing wrong audio.

### 9.9 HTML scenes and Motion Studio

- Scene manifests explicitly mark exposed variables animatable and declare type/range/default/time domain.
- Undeclared DOM paths, CSS selectors, or network state can never be animated through the project.
- Reuse the generic property-row and interaction-session primitives in Motion Studio.
- Reuse the generic animation schema in motion-scene documents while keeping scene ownership inside that document.
- Migrate existing Motion Studio capabilities and keyframes through adapters; do not rewrite all scene data in one change.
- “My Motions” and scene templates move to Library/Templates; Animate focuses on timing, graphs, paths, and presets for current selection.

## 10. GPT/Hermes/Vibe orchestration model

### 10.1 Role separation

| Actor                         | Responsibilities                                                                                                                                                                                  | Must not do                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT orchestrator              | Plan, select packets, prepare prompts, verify prerequisites, review complete diffs/tests, make architecture decisions, dispatch repair/integration packets, update plan/ledger, and approve gates | Edit product source or test files, author implementation patches, resolve a rejected patch by coding, commit implementation, bypass tests, or hotfix live |
| Vibe primary executor         | Implement schema, commands, evaluator, renderer, UI, tests, migrations, performance work, integration commits, local CI, and automated browser tests in isolated worktrees                        | Work on `main`, deploy production, access live secrets, weaken gates, or expand beyond the active packet                                                  |
| Hermes VPS executor           | Read-only VPS evidence, environment-specific verification, immutable staging creation, service/log observation, production promotion, and rollback                                                | Become the normal coding executor while Vibe is available, edit active releases, expose secrets, or make unreviewed live changes                          |
| Nano-GPT helper inside Hermes | Read-only inventory, focused failure triage, dependency/path discovery, and second-pass checklist review                                                                                          | Commit code, choose architecture, access or print credentials, or write overlapping patches                                                               |

GPT's implementation write scope is **zero**. During execution GPT may write only planning/orchestration records under `plan/` or an approved run-state location. Any source, test, migration, configuration, or deployment change is performed by Vibe or Hermes through an explicit packet.

### 10.2 Vibe-first and credit policy

- One orchestrator and one writing executor at a time.
- Read-only audits may run in parallel, but their outputs return to GPT before any patch is authorized.
- Vibe is the default executor for **all local implementation**, including schema, core TypeScript, renderer, UI, tests, and documentation. A packet's executor line may name Hermes only for a VPS-only operation.
- Hermes may replace Vibe for code only when Vibe is unavailable, its authenticated credit is exhausted, or the issue can be reproduced only inside the VPS environment. GPT records the reason automatically and does not ask the user.
- Do not ask Vibe and Hermes to generate competing patches. Hermes/Nano-GPT may diagnose read-only while Vibe owns the patch.
- Use top-tier reasoning only for schema/migration/render-order/time-domain reviews and cross-domain failures.
- Use the least expensive capable model for mechanical tests, inventory generation, and log summarization.
- Do not paste the entire repository or entire plan into every worker prompt. Send the packet, required contract sections, and directly relevant files.
- A rejected patch is repaired by the same executor unless GPT determines the architecture was wrong.
- No “while you are here” scope expansion.
- Reserve **$50** of the available Vibe credit. The lights-out run has a hard Vibe spend ceiling of **$200** unless a later user instruction changes it.
- Default Vibe caps are: simple packet `$2.50 / 18 turns / 100k tokens`; normal packet `$4.50 / 30 turns / 160k tokens`; complex schema, rendering, audio, color, or time-remap packet `$7.50 / 45 turns / 220k tokens`.
- A repair resume may consume at most one additional cap equal to 50% of the original packet cap. GPT tracks cumulative spend from Vibe JSON output and parks remaining work before crossing the global ceiling.

### 10.3 Lights-out autonomy and no-question policy

When the user declares they are unavailable, GPT sets `mode = lights-out` and follows these rules:

- Do not call `request_user_input`, send a blocking clarification, or wait for a routine preference.
- Use this plan, existing ADRs/tests, backward compatibility, and the smallest reversible change as the decision hierarchy.
- If two implementations are valid, choose the one that changes fewer public interfaces and preserves more legacy behavior; record the decision for morning review.
- If a choice is reversible and contained inside the packet, Vibe chooses conservatively and proceeds.
- If a choice would be destructive, irreversible, secret-bearing, externally communicative, billable beyond the declared cap, or production-changing beyond the release ceiling, park that packet without asking and continue any independent safe queue.
- Authentication expiry, missing credentials, dirty canonical checkout, unavailable service, or external rate limit never triggers a user question. Record evidence, park the affected packet, and continue safe work.
- The default lights-out release ceiling is **staging only**. Production promotion requires `WP34_ALLOW_PRODUCTION=1` to have been explicitly authorized before the run; absence of that flag parks WP34-55 without a request.
- The final unattended report contains accepted commits, rejected/parked packets, tests, spend, staging URL/SHA if any, and the exact next action. It does not claim completion when a gate is parked.

The autonomous scheduler uses these dependency queues:

1. Foundation chain: WP34-01 through WP34-13, sequential.
2. Reference UI chain: WP34-14 through WP34-20, sequential.
3. After Phase C, domain queues D (Effects), E (Color), F-Audio, F-Captions, G-Camera, G-Transitions, G-Appearance, G-Time Remap, G-Scenes, and H-Information Architecture may be selected independently, but only one writing executor runs at a time.
4. A parked domain queue does not block other domain queues whose prerequisites passed.
5. WP34-50 through WP34-55 require every mandatory domain/IA gate; they cannot be declared green by skipping a parked prerequisite.

### 10.4 Automatic recovery ladder

No ordinary failure is escalated to the sleeping user. GPT applies this ladder automatically:

1. **Self-repair:** resume the same Vibe session once with the exact failing command, relevant output, and a narrow repair objective.
2. **Fresh diagnosis:** if still failing, ask Nano-GPT/Hermes for a read-only diagnosis limited to the changed files and logs.
3. **Repair packet:** dispatch a fresh Vibe worktree/session with that diagnosis, the original acceptance contract, and no permission to broaden scope.
4. **Clean rebase:** if failure is integration-only, dispatch Vibe to recreate the packet from the latest accepted base rather than force-resetting or hand-merging user work.
5. **Park and continue:** after two failed implementation attempts, mark the packet `PARKED`, preserve branches/logs, and schedule the next dependency-safe queue.
6. **Phase stop:** if the parked packet is a phase-wide prerequisite, stop product writes for that phase, run only safe read-only audits/tests, and produce the unattended report.

The recovery ladder must never delete user data, weaken assertions, update golden output merely to make tests green, force-push, bypass migration rules, expose secrets, directly edit live artifacts, or exceed the credit/release ceiling.

### 10.5 Git and worktree discipline

- GPT verifies `git status`, branch, HEAD, and remote before each packet.
- One packet uses one branch/worktree and produces one reviewable commit.
- Branch naming: `vibe/wp34-<packet>-<slug>`; `hermes/wp34-<packet>-<slug>` is reserved for an explicitly logged VPS-only repair.
- Vibe always works in a dedicated worktree. Hermes works only in the canonical VPS source checkout after verifying it matches the approved base SHA.
- Never edit `/opt/joy-media/web-releases/*`, the active `web` symlink target, or any live artifact directly.
- Never force-push, reset away user work, or stage unrelated files.
- GPT does not cherry-pick implementation itself. After acceptance, GPT dispatches a constrained Vibe integration action to cherry-pick the accepted commit onto `vibe/wp34-integration`, run the packet's smoke test, and report the resulting SHA.
- Deploy only an integration commit that is present on the approved remote and has passed the phase gate.

### 10.6 Packet size and stopping rules

Each implementation packet should normally be:

- one architectural seam or one visible vertical slice;
- at most 8 touched source files;
- at most about 500 non-generated changed lines, or 800 for a schema/validator packet;
- one targeted test family plus typecheck for affected packages;
- one commit with no unrelated formatting churn.

The executor stops the active attempt and returns structured evidence to GPT when:

- a required contract is absent or contradicts this plan;
- the packet needs changes outside its allowed paths;
- a legacy fixture changes appearance;
- a migration cannot be lazy/reversible;
- preview and export need different parameter semantics;
- a secret, live-only file, or dirty canonical checkout is encountered;
- the same test failure survives two focused repair attempts;
- the diff exceeds the packet limit because a larger architecture decision is required.

In lights-out mode, “return to GPT” never means “ask the user.” GPT applies section 10.4.

### 10.7 Unattended Vibe invocation

Vibe is installed at `C:\Users\HadiMoti\.local\bin\vibe.exe` and supports programmatic mode, isolated worktrees, auto-approval, turn/token/price limits, resumable sessions, and JSON output.

GPT materializes the worker packet into a prompt string and invokes the equivalent of:

```powershell
vibe -p $packetPrompt `
  --agent auto-approve `
  --trust `
  --workdir C:\Users\HadiMoti\joy-vps\joy-media-fix `
  --worktree "wp34-XX-slug" `
  --max-turns $packetTurns `
  --max-price $packetPrice `
  --max-tokens $packetTokens `
  --output json
```

Rules for the invocation:

- One fresh session/worktree per packet; resume that session only for the single self-repair attempt.
- The prompt forbids production deployment, secret access, force operations, unrelated edits, and questions to the user.
- JSON output is stored outside the repository in a per-run temporary evidence directory and parsed for session ID, usage, result, tests, and commit SHA.
- A Vibe response without a commit, clean status, and required test evidence is not accepted even if its prose says the task is complete.
- Auto-approval authorizes only the packet inside its isolated worktree. It does not broaden product scope or release authority.

### 10.8 Worker packet template

GPT sends workers only packets shaped like this:

```md
WP-34 packet: <ID and title>
Base SHA: <full SHA>
Executor: Vibe (default) | Hermes (VPS-only exception with recorded reason)
Mode: lights-out; do not ask the user questions

Objective:
<one observable result>

Required reading:

- <specific WP-34 sections>
- <specific files>

Allowed paths:

- <path list>

Forbidden:

- unrelated refactors
- dependency upgrades unless named
- deployment
- raw project JSON mutation

Implementation contract:

1. <small requirement>
2. <small requirement>
3. <small requirement>

Required tests:

- <exact targeted commands>
- pnpm typecheck, or a justified package-scoped equivalent
- git diff --check

Return:

- summary
- files changed
- tests with exit status
- compatibility/migration note
- remaining risk
- commit SHA

Stop conditions:
<packet-specific blockers>
```

### 10.9 GPT acceptance loop

For every packet GPT performs:

1. Confirm previous packet gate and clean base.
2. Issue exactly one worker packet.
3. Inspect the complete diff, not only the worker summary.
4. Check scope, dependency direction, descriptors, undo, persistence, migration, accessibility, and tests.
5. Run or independently verify the most important targeted test.
6. Mark `accepted`, `automatic repair`, `parked`, or `rejected/replace design`.
7. Dispatch Vibe to integrate only accepted commits; GPT never implements or commits the patch itself.
8. Update the packet checklist and record accepted SHA/test evidence.
9. Run the phase gate before entering the next phase.

## 11. Small implementation packets

The order below is intentional. A later packet may start only when all listed prerequisites are accepted. GPT may parallelize **read-only** evidence collection, but code-writing packets remain serialized whenever paths or contracts overlap.

### Phase A — Freeze the contract and baseline

#### WP34-01 — Baseline evidence pack

- **Executor:** Vibe primary, read-only except ignored test artifacts; Hermes supplies only VPS release evidence.
- **Work:** Record HEAD, clean status, package versions, full current test status, legacy animation fixtures, live-release SHA, and existing workspace-layout storage versions.
- **Primary paths:** no source edits; evidence summarized in GPT state.
- **Acceptance:** no unexplained baseline failure; failures are classified as pre-existing with command output.

#### WP34-02 — Animation and property ADR

- **Executor:** Vibe drafts; GPT reviews the architecture and dispatches any revision.
- **Work:** Add an ADR for binding identity, owner/time-domain rules, value types, expression precedence, lazy migration, and Render IR boundary.
- **Primary paths:** `docs/adr/`, this plan only if a clarified decision must be recorded.
- **Tests:** Markdown/link checks if available; `git diff --check`.
- **Acceptance:** no arbitrary JSON paths; every domain in section 6 maps to a defined owner and time domain.

#### WP34-03 — Executable property coverage manifest

- **Executor:** Vibe.
- **Work:** Introduce descriptor types and a registry test that lists every current adjustable control as registered creative, static-with-reason, structural, or UI-only.
- **Primary paths:** `packages/property-system/`, narrow adapters/tests.
- **Acceptance:** unclassified controls fail tests; no React dependency enters a core package.

#### WP34-04 — Golden fixture extension

- **Executor:** Vibe.
- **Work:** Add compact fixtures for legacy transform/effect curves, color Clip/Output, audio clip/bus, caption clip, camera, transition, and HTML scene ownership.
- **Primary paths:** `packages/test-fixtures/`, affected pure-package tests.
- **Acceptance:** fixtures validate and render identically before V2 behavior is enabled.

**Phase A gate:** targeted tests, `pnpm typecheck`, `pnpm lint`, and descriptor coverage report reviewed by GPT.

### Phase B — Universal animation core

#### WP34-05 — Binding and animation schema types

- **Executor:** Vibe.
- **Work:** Add `PropertyOwnerV2`, `PropertyBindingV2`, compound/discrete animation types, and optional `JoyProjectV1.propertyAnimations`.
- **Primary paths:** `packages/project-schema/src/` and tests.
- **Acceptance:** old fixtures parse unchanged; no eager migration; types are renderer/UI neutral.

#### WP34-06 — Binding canonicalization and validation

- **Executor:** Vibe.
- **Work:** Implement canonical binding keys, validation, finite/range checks, channel validation, sorted-key normalization, and orphan diagnostics.
- **Acceptance:** malformed and ambiguous bindings are rejected; canonical round trips are deterministic.

#### WP34-07 — Compound and discrete samplers

- **Executor:** Vibe.
- **Work:** Extend pure motion/evaluation helpers for vector, linear color, hue, angle, hold, and curve-snapshot sampling while reusing scalar curves.
- **Primary paths:** `packages/motion-core/`, tests.
- **Acceptance:** boundary, wraparound, duplicate-time, and malformed-handle fixtures pass deterministically.

#### WP34-08 — Reversible animation command

- **Executor:** Vibe.
- **Work:** Add normalized replace/enable/disable/set-key/remove-key operations with semantic inverses and atomic compound values.
- **Primary paths:** `packages/commands/`, `packages/property-system/`, tests.
- **Acceptance:** one command round-trips exactly through undo/redo; identity entries are removed.

#### WP34-09 — Transient property interaction service

- **Executor:** Vibe; GPT reviews the core/UI boundary without authoring code.
- **Work:** Extract Motion Studio's begin/update/commit/cancel behavior into a shared non-domain-specific controller/hook.
- **Primary paths:** `apps/editor-web/src/` shared interaction module and tests; no panel migration yet.
- **Acceptance:** pointer movement changes preview only; release emits one command; Escape emits none.

#### WP34-10 — Time-domain resolver

- **Executor:** Vibe.
- **Work:** Resolve composition, clip-local, transition-local, output, caption-local, scene-local, and audio timeline time with explicit clamp/rebase behavior.
- **Primary paths:** `packages/evaluator/`, `packages/timeline-engine/`, tests.
- **Acceptance:** split/trim/offset fixtures produce known local times; no Date/ms arithmetic enters media time.

#### WP34-11 — Frame property evaluator

- **Executor:** Vibe.
- **Work:** Evaluate static -> V2/legacy curve -> expression -> normalize and produce a frame-local resolved snapshot.
- **Primary paths:** `packages/evaluator/`, `packages/property-system/`, tests.
- **Acceptance:** V2 precedence is per binding; expression failures safely fall back; evaluator does not mutate project data.

#### WP34-12 — Lazy legacy adapter

- **Executor:** Vibe.
- **Work:** Read legacy visual/effect animations through adapters and migrate one property only on its first V2 edit.
- **Acceptance:** untouched project serialization is byte-stable where persistence permits; legacy golden pixels remain unchanged.

#### WP34-13 — Ownership lifecycle helpers

- **Executor:** Vibe.
- **Work:** Integrate animation clone/rebase/orphan removal with split, duplicate, copy/paste, delete, and undo for clip/object/effect owners.
- **Primary paths:** timeline/property/command packages and tests.
- **Acceptance:** each lifecycle operation preserves correct ownership and has a tested inverse.

**Phase B gate:** `pnpm check`, package builds, schema fixtures, evaluator golden tests, and a GPT architecture review before UI rollout.

### Phase C — Shared keyframe UI and transform reference slice

#### WP34-14 — Universal property row shell

- **Executor:** Vibe.
- **Work:** Build accessible label/value/reset/stopwatch/previous/diamond/next/graph primitives with compact and two-line responsive layouts.
- **Primary paths:** `apps/editor-web/src/components/` or an approved shared UI location, CSS, component tests.
- **Acceptance:** keyboard, ARIA, focus, tooltip, mixed/disabled/error states, and 320–560 px widths pass.

#### WP34-15 — Numeric/vector/color/discrete control adapters

- **Executor:** Vibe.
- **Work:** Connect sliders, numeric inputs, wheels, color pickers, selects, and switches to the shared transient interaction service.
- **Acceptance:** every adapter commits once and cancels with Escape; compound controls remain atomic.

#### WP34-16 — Inspector transform migration

- **Executor:** Vibe.
- **Work:** Replace the hard-coded transform keyframe behavior with registered descriptors and universal rows while retaining current appearance and expression controls.
- **Primary paths:** `InspectorPanel.tsx`, shared components/tests.
- **Acceptance:** existing transform projects behave identically; static and animated edits each produce one undo step.

#### WP34-17 — Transform evaluator/render vertical slice

- **Executor:** Vibe.
- **Work:** Route transform through the universal evaluator into main monitor and browser export, retaining the legacy fallback.
- **Primary paths:** evaluator, visual-object renderer, render tests.
- **Acceptance:** preview/export golden frames match; position spatial paths still work.

#### WP34-18 — Basic Timeline property lanes

- **Executor:** Vibe.
- **Work:** Expand selected objects to animated properties, render frame-snapped keys, add previous/next/add/remove, and “Show Animated.”
- **Primary paths:** `TimelinePanel.tsx`, focused lane components/tests.
- **Acceptance:** keys remain aligned during zoom/scroll; 10,000 offscreen keys do not create 10,000 DOM nodes.

#### WP34-19 — Graph Editor transaction repair

- **Executor:** Vibe.
- **Work:** Migrate key/tangent dragging to the transient interaction service; preserve marquee, interpolation, copy/paste, and keyboard behavior.
- **Acceptance:** a long drag is one undo step; Escape restores exact key/tangent state.

#### WP34-20 — Dope Sheet/Graph focus bridge

- **Executor:** Vibe.
- **Work:** Graph button on any property focuses the correct lane and owner in Timeline/Animate without duplicating values.
- **Acceptance:** navigation preserves selection and playhead; missing/deleted owners fail gracefully.

**Phase C gate:** transform end-to-end browser test, undo-count tests, accessibility scan, compact viewport screenshots, `pnpm check`, and build.

### Phase D — Effects

#### WP34-21 — Effect descriptor bridge

- **Executor:** Vibe.
- **Work:** Adapt every first-party effect descriptor into the universal property registry, including static reasons and hold eligibility.
- **Acceptance:** registry coverage equals the effect catalog; incompatible duplicate IDs fail.

#### WP34-22 — Inspector effect keyframe UI

- **Executor:** Vibe.
- **Work:** Add universal controls to numeric/vector/color/approved bool-enum parameters in Inspector Effects.
- **Acceptance:** no durable command per slider tick; animated/non-animated states match Timeline lanes.

#### WP34-23 — Main effect evaluator and render path

- **Executor:** Vibe.
- **Work:** Sample effect animations in main visual normalization before preview/export shaders and CPU fallbacks.
- **Acceptance:** Effect Studio and Program Monitor show the same frame; CPU/GPU/browser-export fixtures stay within established tolerances.

#### WP34-24 — Effect Studio unification

- **Executor:** Vibe.
- **Work:** Replace isolated keyframe state with universal bindings/evaluator and reuse shared property rows/lanes.
- **Acceptance:** edits made in either surface appear immediately in the other and create one shared history entry.

**Phase D gate:** all first-party effects classified; representative scalar/vector/color/hold tests; full check/build.

### Phase E — Color

#### WP34-25 — Color property descriptors and stable HSL identities

- **Executor:** Vibe.
- **Work:** Register Clip/Output Adjust, Wheels, HSL, curves, and Looks properties; add stable semantic band IDs without changing legacy output.
- **Acceptance:** every WP-33 creative control is classified; diagnostics/UI preferences are excluded.

#### WP34-26 — Color continuous animation evaluation

- **Executor:** Vibe.
- **Work:** Evaluate Adjust/Wheels/HSL/LUT intensity at Clip/Output time and feed existing CPU/GPU grading implementation.
- **Acceptance:** clip grade remains before effects/transitions and output grade after composite; preview/export parity passes.

#### WP34-27 — Color keyframe UI

- **Executor:** Vibe.
- **Work:** Add compact animation controls to sliders/wheels/HSL and property focus links without crowding the scope/utility bar.
- **Acceptance:** wheel drags commit once; narrow dock remains usable; A/B/scopes are not persisted as animation.

#### WP34-28 — Animated color curves

- **Executor:** Vibe for both canonical sampling and interaction; GPT enforces the CPU/GPU contract through review.
- **Work:** Store/morph bounded 256-sample curve snapshots, add key state to curve editor, and keep transient point motion out of history.
- **Acceptance:** different knot counts interpolate safely; monotonic bounds and parity fixtures pass.

#### WP34-29 — Hold-key Looks/LUT dependency gate

- **Executor:** Vibe.
- **Work:** Allow hold changes only when all referenced look/LUT assets preload and pass hash/export dependency validation.
- **Acceptance:** missing LUT cannot silently preview/export the wrong look; failure is visible and reversible.

**Phase E gate:** WP-33 render-order tests plus animated golden frames, undo tests, and live-like WebGL/browser export checks.

### Phase F — Audio and Captions

#### WP34-30 — Audio descriptor and automation model

- **Executor:** Vibe.
- **Work:** Register clip/bus/first-party effect properties, hold mute, static solo/routing, and smoothing metadata.
- **Acceptance:** every Audio and Inspector Audio adjustment is classified once.

#### WP34-31 — Audio automation evaluator

- **Executor:** Vibe.
- **Work:** Convert curves into block ramps/sample-aware plans for preview and browser export, including de-zippering.
- **Acceptance:** known ramp fixtures meet value/timing tolerances and have no discontinuity at block boundaries.

#### WP34-32 — Audio UI consolidation

- **Executor:** Vibe.
- **Work:** Make Inspector Audio the selected-clip view and Audio workspace the mixer/enhance view of the same bindings; move runtime/backend controls into an Advanced/Process section.
- **Acceptance:** no duplicate state; UI is usable at compact widths; creative controls are visually separated from operational status.

#### WP34-33 — Caption clip-style model

- **Executor:** Vibe.
- **Work:** Add clip-owned style overrides and animation bindings while retaining document templates and transcript structure.
- **Acceptance:** two caption clips sharing one document can animate appearance independently; old captions render unchanged.

#### WP34-34 — Inspector Caption and render evaluation

- **Executor:** Vibe; GPT automatically splits evaluator and UI into consecutive Vibe packets if the size limit would be exceeded.
- **Work:** Expose typography/position/plate/highlight controls and apply caption-local animation before Render IR text nodes are emitted.
- **Acceptance:** karaoke timing remains derived; cue text/timing is not keyframed; RTL and safe-area fixtures pass.

**Phase F gate:** audio automation/export tests, caption LTR/RTL/karaoke tests, a11y, full check/build.

### Phase G — Camera, transitions, text/appearance, speed, and scenes

#### WP34-35 — Camera Inspector migration

- **Executor:** Vibe.
- **Work:** Keep rig management in Camera; show selected camera transform/FOV in Inspector using universal rows.
- **Acceptance:** no duplicate camera value editors; camera creation/active assignment remain structural.

#### WP34-36 — Camera FOV evaluation

- **Executor:** Vibe.
- **Work:** Register/sample field of view and verify projection in preview/export.
- **Acceptance:** known depth fixtures animate smoothly with no invalid FOV.

#### WP34-37 — Transition descriptor/evaluator

- **Executor:** Vibe.
- **Work:** Classify shader uniforms, add transition-local bindings, and evaluate before blend.
- **Acceptance:** local-time boundaries and duration rebase fixtures pass; type/duration remain static.

#### WP34-38 — Inspector Transition UI

- **Executor:** Vibe.
- **Work:** Move selected-junction parameter editing to Inspector and keep Transitions as catalog/apply surface.
- **Acceptance:** applying/replacing remains simple; animatable uniforms use universal rows.

#### WP34-39 — Visual appearance and typography slice

- **Executor:** Vibe; GPT automatically splits durable evaluation and Inspector UI into consecutive Vibe packets when needed.
- **Work:** Add only renderer-backed fill/stroke/shadow/crop/corner/typography properties; support hold Source Text for visual text.
- **Acceptance:** no fake controls; color/vector/text hold tests and render golden fixtures pass.

#### WP34-40 — Time-remap ADR and model

- **Executor:** Vibe drafts and implements only after GPT accepts the model.
- **Work:** Define monotonic source-time mapping, split/trim/reverse/freeze/audio policy, schema, and validator tests without UI.
- **Acceptance:** no ordinary scalar-curve shortcut; invalid mappings are rejected deterministically.

#### WP34-41 — Time-remap evaluator and lane

- **Executor:** Vibe; GPT automatically splits evaluator and lane work into consecutive Vibe packets when needed.
- **Work:** Evaluate source time and expose source-time/speed graph views with constrained handles.
- **Acceptance:** static playback rate compatibility, ramps, freeze, trim, split, and export fixtures pass.

#### WP34-42 — HTML-scene manifest animation

- **Executor:** Vibe.
- **Work:** Extend scene input manifests with explicit animation policy and deterministic evaluation.
- **Acceptance:** undeclared values cannot be addressed; sandbox/network behavior remains unchanged.

#### WP34-43 — Motion Studio adapter

- **Executor:** Vibe.
- **Work:** Reuse universal property rows and interaction sessions, adapt scene animation storage, and preserve current scene behavior.
- **Acceptance:** one gesture/one undo; old scene documents load; no second descriptor list is introduced.

**Phase G gate:** domain targeted suites, CPU/GPU/browser parity where applicable, full check/build, and integration review.

### Phase H — Information architecture and advanced animation UX

#### WP34-44 — Workspace layout v2 migration

- **Executor:** Vibe.
- **Work:** Add deterministic migration for old Dockview groups/IDs, preserve Custom layouts, and support temporary aliases for Templates/Flow/Motion/Camera changes.
- **Acceptance:** fixture layouts from WP-31/WP-32 restore without lost panels or duplicate views.

#### WP34-45 — Library and panel responsibility cleanup

- **Executor:** Vibe.
- **Work:** Move Templates/My Motions into Library, remove parameter duplication from Effects/Transitions/Camera, and relocate System panels from defaults.
- **Acceptance:** all functionality remains reachable through View/command palette; default creative tabs are reduced.

#### WP34-46 — Animate and Timeline mode consolidation

- **Executor:** Vibe.
- **Work:** Rename Motion to Animate, make Animated Properties/Dope Sheet/Graph/Paths/Presets its focus, and absorb Dual Lens as Timeline Flow mode.
- **Acceptance:** aliases restore old layouts; no motion library card occupies the animation editor.

#### WP34-47 — Workspace preset redesign

- **Executor:** Vibe.
- **Work:** Implement the layouts in section 5.1 and migrate per-preset local preferences.
- **Acceptance:** Edit, Enhance, Audio & Captions, Automate, and Custom open the intended active surfaces at desktop and compact sizes.

#### WP34-48 — Advanced Timeline lanes and virtualization

- **Executor:** Vibe.
- **Work:** Add grouped property disclosure, animated/modified filters, multi-key marquee, atomic paste, interpolation menu, and viewport virtualization.
- **Acceptance:** 50,000-key stress fixture remains interactive and creates bounded DOM/canvas work.

#### WP34-49 — Accessibility and focus closeout

- **Executor:** Vibe.
- **Work:** Complete keyboard traversal, focus restoration, ARIA names/states, visible focus, reduced motion, contrast, and screen-reader key-state announcements.
- **Acceptance:** axe/Playwright checks pass at 320, 360, 420, 480, and 560 px docks plus standard editor viewports.

**Phase H gate:** full screenshot matrix, saved-layout migration suite, `pnpm test:e2e:audit`, `pnpm check`, and build.

### Phase I — Agent API, performance, and release

#### WP34-50 — Agent/change-set animation operations

- **Executor:** Vibe.
- **Work:** Expose the typed operations in section 8.7 through existing agent tools and permission/validation boundaries.
- **Acceptance:** UI and agent produce equivalent commands; old unscoped edits retain their current static behavior.

#### WP34-51 — Coverage and omission CI gate

- **Executor:** Vibe.
- **Work:** Generate a machine-readable property report and fail CI for unclassified creative controls/descriptors.
- **Acceptance:** adding a new adjustable control without animation/static policy breaks a focused test with a useful message.

#### WP34-52 — Performance and memory pass

- **Executor:** Vibe for evaluator and UI profiling; Hermes may provide read-only VPS measurements.
- **Work:** Cache descriptor lookup, active curves, sampled curve snapshots, lane geometry, and dependency preloads; eliminate avoidable React rerenders.
- **Budgets:** paused control-to-preview p95 under 50 ms; no interaction task over 50 ms; 500 active scalar channels evaluate under 5 ms p95 on the CI reference machine; keyframe UI work scales with visible lanes/keys.
- **Acceptance:** benchmark artifacts and profiler evidence are reviewed by GPT; no unexplained playback regression over 15%.

#### WP34-53 — Full CI and staging build

- **Executor:** Vibe runs full local/CI evidence; Hermes performs only immutable VPS staging after GPT accepts that evidence.
- **Work:** On the approved integration SHA run frozen install, `pnpm verify:ci`, Playwright audit, browser export parity, and immutable staging release creation.
- **Acceptance:** all checks green; artifact and source SHA recorded; previous release remains available for rollback.

#### WP34-54 — Signed-in live acceptance

- **Executor:** Vibe runs automated Playwright/browser acceptance; GPT reviews evidence, and Hermes observes VPS logs read-only.
- **Work:** Run a real project matrix: transform, effect, color Clip/Output, audio, caption style, camera, transition, time remap, undo/redo, reload, export, and workspace restoration.
- **Acceptance:** screenshots/video and project/export evidence are tied to the staging SHA; no live hotfix.

#### WP34-55 — Production promotion and rollback drill

- **Executor:** Hermes only when `WP34_ALLOW_PRODUCTION=1` was explicitly authorized before the lights-out run; otherwise this packet is parked without a request.
- **Work:** Promote the already-tested immutable artifact through the canonical symlink/service workflow, verify public health, and document the exact rollback target.
- **Acceptance:** `https://joyst.ir/?deploy=<short-sha>` reports the approved SHA, smoke tests pass, and rollback can be completed by switching to the recorded prior immutable release.

## 12. Required automated coverage

### Schema and compatibility

- All old project fixtures validate and retain prior serialized/visual behavior.
- Binding keys round-trip canonically and reject unknown owners/properties/time domains.
- Compound channel sets, hold keys, and curve snapshots reject malformed/non-finite data.
- First edit migrates one legacy property; untouched properties remain legacy and unchanged.
- Orphan diagnostics are deterministic and do not auto-delete user data.

### Commands and interaction

- Enable, add, update, remove, disable, and replace animation each undo/redo exactly.
- Slider, wheel, curve point, key, and tangent drags create one history entry.
- Escape/pointer cancel creates none and restores the exact prior value.
- Keyboard repeats coalesce as specified.
- Compound color/vector edits are atomic.
- Expression ownership and fallback preserve retained keyframes.

### Ownership and time

- Split, trim, duplicate, copy/paste, delete, undo, reload, and nested reuse preserve ownership.
- Clip, transition, caption, scene, output, composition, and audio domains sample known values at boundaries.
- Keys cannot escape valid owner bounds.
- Time remap stays monotonic except explicitly supported reverse segments and never samples outside valid source ranges.

### Rendering and audio

- Identity animation leaves pixels/samples unchanged.
- Main Inspector effect keys affect Program Monitor and browser export.
- Clip color stays before effects/transitions; Output color stays after composite.
- CPU/GPU/browser export parity stays within established channel tolerances.
- Color hue wrap and curve-snapshot interpolation have no discontinuities.
- Audio ramps are time-correct and de-zippered at block boundaries.
- Caption RTL, karaoke, line wrapping, and safe areas remain correct while style animates.
- Diagnostics/compare/scopes/keyframe overlays never appear in export.

### UI and information architecture

- Every adjustable control resolves to a descriptor or an explicit non-creative classification.
- Property rows expose label, value, reset, animation state, navigation, tooltip, keyboard, and focus behavior.
- Animated-only/modified filters are accurate.
- Old named/custom layouts migrate and can reopen every panel.
- Default presets match the intended responsibilities and do not duplicate selected-property editors.
- Accessibility checks pass at all specified narrow widths and desktop presets.
- Timeline stress fixtures virtualize offscreen lanes/keys.

### Agent and security

- Agent operations cannot address raw JSON paths, unknown descriptors, missing owners, or forbidden structural properties.
- UI and agent commands yield the same normalized project state.
- Missing LUT/font/effect dependencies block incorrect output rather than silently changing appearance.
- No credentials, runtime backend state, or UI preferences enter project animation data.

## 13. Phase and release commands

Workers use focused package/test commands during a packet. At every phase gate, GPT requires at least:

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
git diff --check
```

Before staging/production:

```powershell
pnpm verify:ci
pnpm test:e2e:audit
```

On VPS, Hermes must first verify the canonical checkout path, clean status, remote, and approved source SHA. It then follows the existing Joy Media immutable release procedure documented by the current deployment runbook. It must not invent a new release command, edit an active release, or expose environment values.

## 14. Acceptance scenarios for the user

### Scenario A — Simple animation remains simple

1. Select a visual clip.
2. Open Inspector Visual.
3. Enable Position animation at 0:00.
4. Move to 2:00 and drag X.
5. See one new key, smooth preview, and exactly one undo entry for the drag.
6. Press Graph and refine easing.
7. Export the same motion seen in Program Monitor.

### Scenario B — Professional color motion

1. Select one clip and open Color.
2. Animate exposure and wheel offset over the clip.
3. Animate a curve between two differently shaped snapshots.
4. Keep Output grade static or animate it independently.
5. Confirm scopes remain diagnostics only and exported pixels match preview.

### Scenario C — Effect, transition, and camera

1. Apply an effect from the catalog.
2. Animate eligible effect parameters in Inspector.
3. Select a junction and animate a shader uniform in transition-local time.
4. Select a camera and animate Z/FOV.
5. View all selected animated properties together in Timeline Keys and Graph.

### Scenario D — Audio and captions

1. Animate clip gain/pan and bus gain without zipper noise.
2. Animate caption position/plate/highlight while transcript timing remains intact.
3. Undo each gesture once, reload, and export with matching timing.

### Scenario E — UI clarity

1. Edit workspace opens Library, Monitor, Inspector, and Timeline without System clutter.
2. Templates and My Motions are found in Library.
3. Animate contains lanes/graphs/paths, not a browsing card.
4. Camera rig controls structure; Inspector controls selected camera values.
5. Effects/Transitions browse and apply; Inspector edits.
6. Custom workspace restores exactly after reload.

## 15. Explicit deferrals

These are outside WP-34 unless a prerequisite implementation already exists and GPT adds a reviewed packet:

- node-based compositing or color grading;
- arbitrary mask/path morphing across incompatible topology;
- HDR/ACES/RAW camera pipelines beyond WP-33's internal future boundary;
- optical-flow retiming or high-quality pitch-preserving reverse audio;
- collaborative multi-user concurrent keyframe editing;
- expressions for every domain (existing transform expressions remain supported; the architecture stays compatible);
- arbitrary DOM/CSS animation in untrusted HTML scenes;
- active-camera generic keyframes instead of a future camera-cut track;
- animating imports, jobs, workflow structure, plugin installation, export settings, or any runtime/system control.

## 16. First orchestration action

When WP-34 execution is started, GPT sets `mode = lights-out`, `primary_executor = vibe`, `vibe_spend_ceiling = 200 USD`, and `release_ceiling = staging` unless a different preauthorized value already exists. GPT then dispatches **WP34-01 only** to Vibe and automatically advances through the dependency-safe queue without requesting routine user input.

GPT must not implement any production or test code. It reviews WP34-01 evidence, dispatches WP34-02 to Vibe, and sends every later implementation or repair through Vibe. Hermes remains reserved for VPS-only evidence, staging, logs, rollback, or the automatic exceptional fallback defined in section 10.2.

The first production code change is WP34-03 or WP34-05, depending on whether the descriptor contract can be introduced without the schema types. GPT makes that planning decision from WP34-02 evidence, records it, and dispatches the selected packet to Vibe without waking the user. The unattended run continues until it reaches the staging ceiling, the Vibe spend ceiling, or a phase-wide safety blocker; it then leaves a complete report rather than a clarification request.

The guiding rule for the entire program is:

> Register once, edit anywhere appropriate, animate only when meaningful, evaluate once, and render the same result everywhere.
