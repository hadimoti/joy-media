# Motion Studio — Professional Direct-Manipulation & Animation Upgrade Plan

> Verbatim transcription of the owner-supplied Persian architecture doc
> ("Motion Studio Upgrade Plan.docx"), 2026-07-28. See `P17-motion-studio-phase-2-7.md`
> in this directory for the up-to-date status against the real codebase — this
> file is the original source, kept as-is for reference. Its own "Current
> Implementation Baseline" (§2) is stale; do not trust it over the real code.

## 1. Product Definition

Motion Studio یک محیط تمام‌صفحه برای ساخت، ویرایش و انیمیت‌کردن یک سند مستقل از نوع
`MotionSceneDocument` است.

Motion Studio باید سادگی ویرایش مستقیم CapCut را با ساختار حرفه‌ای ابزارهایی مانند
Figma، After Effects Essential Graphics و یک Timeline ساده‌شده ترکیب کند.

هدف نهایی: ساخت یک Motion Composer چندلایه که کاربر بتواند بدون نوشتن کد، متن،
Shape، تصویر، ویدیو، SVG و سایر عناصر را مستقیماً روی Canvas طراحی و در Timeline
انیمیت کند.

Motion Studio نباید با سه سیستم دیگر اشتباه گرفته شود: Motion Presets، HTML
Scenes، Main Project Timeline. هرکدام مسیر و مدل داده‌ی مستقل خود را دارند.

## 2. Current Implementation Baseline

> **Stale as of 2026-07-28** — the real `motion-core`/`motion-studio` code is far
> more advanced than this table describes (fills/strokes/shadows/filters/blend
> modes/masks/typography/keyframes/version+migration/undo commands already
> exist). Kept verbatim for history; see P17 for the real gap list.

نسخه‌ی فعلی Motion Studio یک Prototype قابل استفاده دارد و نباید از صفر بازنویسی شود.

قابلیت‌های فعلی:

| بخش                | وضعیت فعلی                                          |
| ------------------ | --------------------------------------------------- |
| Studio Shell       | Fullscreen overlay فعال                             |
| Scene creation     | همیشه با Untitled Motion باز می‌شود                 |
| Layer types        | Text، Rectangle، Ellipse                            |
| Layer operations   | Add، select، reorder، hide، lock، delete            |
| Canvas             | Render، selection، drag-to-move                     |
| Inspector          | Transform، text basics، font، fill                  |
| Timeline           | Play/seek، zoom/fit، layer lanes، mute/lock         |
| Undo/redo          | فعال                                                |
| Panel resizing     | فعال                                                |
| Visual/code toggle | UI موجود، Code Mode هنوز placeholder                |
| Publish            | دکمه موجود، عملکرد واقعی ندارد                      |
| Library Open       | Studio باز می‌شود ولی motion id نادیده گرفته می‌شود |

محدودیت‌های فعلی:

- Sceneهای موجود از Library بارگذاری نمی‌شوند.
- تغییرات به Motion Library ذخیره نمی‌شوند.
- Publish چیزی به Main Timeline اضافه نمی‌کند.
- Canvas با Playhead و Keyframeها هماهنگ نیست.
- Timeline هنوز Property Track و Keyframe ندارد.
- Resize و Rotate مستقیم روی Canvas وجود ندارد.
- Text editing مستقیم روی Canvas وجود ندارد.
- Inspector بر اساس نوع Layer ساخته نمی‌شود.
- Image، Video، SVG، Group و HTML Layer وجود ندارند.
- Code Mode هنوز Editor واقعی نیست.

## 3. Architectural Boundary

ساختار محصول باید واضح باقی بماند:

```
Main Editor
├── Motion Presets
│   └── اعمال Animation روی Objectهای Main Timeline
├── Motion Library
│   ├── Open existing MotionSceneDocument
│   ├── Duplicate
│   ├── Rename
│   └── Create new MotionSceneDocument
├── HTML Scenes
│   └── قرار دادن HTML Package روی Main Timeline
└── Motion Studio
    ├── Visual authoring
    ├── Layer composition
    ├── Property animation
    ├── Scene preview
    └── Save / Publish
```

قانون اصلی: Motion Studio باید فقط روی MotionSceneDocument کار کند. نباید:

- Main Timeline را مستقیماً داخل Studio ویرایش کند.
- Motion Preset را به‌عنوان Scene باز کند.
- HTML Scene را بدون Conversion به Motion Scene تبدیل کند.
- State موقت Studio را به State اصلی Editor متصل کند.

## 4. Target User Experience

کاربر باید بتواند:

- از Motion Library روی Create کلیک کند.
- یک Scene خالی یا Template انتخاب کند.
- روی Canvas لایه اضافه کند.
- لایه را مستقیماً Move، Resize و Rotate کند.
- متن را با Double-click ویرایش کند.
- Appearance و Typography را از Inspector تغییر دهد.
- Propertyها را در Timeline باز کند.
- برای Position، Scale، Rotation، Opacity و Style Keyframe بسازد.
- Animation را با Playhead روی Canvas مشاهده کند.
- Scene را ذخیره کند.
- Scene را Publish کرده و به Motion Library یا Main Timeline بفرستد.

چرخه‌ی واقعی:

```
Motion Library
      ↓ Open / Create
Motion Studio
      ↓ Design + Animate
Save Draft
      ↓
Motion Library
Motion Studio
      ↓ Publish
Motion Clip Instance
      ↓
Main Project Timeline
```

## 5. Core Architecture

Motion Studio باید به چهار لایه‌ی اصلی تقسیم شود:

```
MotionStudioShell
├── Document Layer
│   ├── MotionSceneDocument
│   ├── layer tree
│   ├── animation tracks
│   └── serialization
├── Editor State Layer
│   ├── selection
│   ├── active tool
│   ├── playhead
│   ├── viewport
│   └── temporary interaction state
├── Evaluation Layer
│   ├── property interpolation
│   ├── keyframe evaluation
│   ├── expression evaluation
│   └── resolved scene state
└── UI Layer
    ├── Layers panel
    ├── Canvas
    ├── Inspector
    ├── Timeline
    └── Code view
```

Document State و Editor State باید جدا باشند. مواردی مانند Selection، Zoom، Open
Accordion و Hover نباید داخل فایل Scene ذخیره شوند.

```ts
interface MotionStudioEditorState {
  selectedLayerIds: string[];
  activeTool: 'select' | 'hand' | 'text' | 'shape';
  currentTimeMs: number;
  viewportZoom: number;
  viewportOffset: { x: number; y: number };
  editingTextLayerId?: string;
}
```

## 6. MotionSceneDocument Evolution

ساختار سند باید برای Layerهای جدید، Animation و Version Migration آماده شود.

```ts
interface MotionSceneDocument {
  id: string;
  version: number;
  name: string;
  width: number;
  height: number;
  durationMs: number;
  frameRate: number;
  background: MotionBackground;
  layers: MotionLayer[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    thumbnailAssetId?: string;
    source?: 'studio' | 'template' | 'import';
  };
}
```

هر Layer باید دارای مشخصات پایه‌ی مشترک باشد:

```ts
interface MotionLayerBase {
  id: string;
  type: MotionLayerType;
  name: string;
  parentId?: string;
  visible: boolean;
  locked: boolean;
  inPointMs: number;
  outPointMs: number;
  transform: MotionTransform;
  appearance: MotionAppearance;
  animation: MotionAnimationTrack[];
}
```

Layer Types پیشنهادی:

```ts
type MotionLayerType =
  'text' | 'rectangle' | 'ellipse' | 'image' | 'video' | 'svg' | 'group' | 'html';
```

در فازهای اولیه، HTML Layer می‌تواند فقط به‌صورت Placeholder و Read-only اضافه شود.

## 7. Capability-Based Layer System

Inspector و Timeline نباید بر اساس مجموعه‌ای از شرط‌های پراکنده ساخته شوند. برای
هر Layer Type یک Capability Definition تعریف شود:

```ts
interface LayerCapabilities {
  transform: boolean;
  typography?: boolean;
  fill?: boolean;
  stroke?: boolean;
  cornerRadius?: boolean;
  shadow?: boolean;
  glow?: boolean;
  blur?: boolean;
  blendMode?: boolean;
  crop?: boolean;
  mask?: boolean;
  filters?: boolean;
  editableText?: boolean;
}
```

نمونه:

```ts
const textCapabilities: LayerCapabilities = {
  transform: true,
  typography: true,
  fill: true,
  stroke: true,
  shadow: true,
  glow: true,
  blur: true,
  blendMode: true,
  editableText: true,
};
```

این Registry باید توسط موارد زیر استفاده شود: Inspector، Timeline property list،
Context menu، Canvas interaction، Keyboard commands، Code serialization.

## 8. Canvas Direct Manipulation

### 8.1 Professional Bounding Box

هنگام انتخاب یک Layer روی Canvas باید موارد زیر نمایش داده شوند: Bounding box،
چهار Corner handle، چهار Edge handle، Rotate handle، Pivot یا Transform origin (فاز
بعدی)، اندازه‌ی فعلی Layer، Position feedback هنگام Drag، Selection outline متناسب
با Zoom.

Bounding box نباید بخشی از Scene Render باشد و باید در یک Editor Overlay Layer
جداگانه رسم شود.

### 8.2 Move Interaction

Drag داخل Bounding Box باید Position را تغییر دهد. قابلیت‌ها: Drag آزاد، Shift
برای محدودکردن حرکت به محور غالب، Snap به مرکز Scene، Snap به لبه‌های Scene، Snap
به مرکز و لبه‌های سایر Layerها، نمایش Alignment Guide، نمایش فاصله (فاز بعدی)،
جلوگیری از Interaction برای Layer قفل‌شده.

در طول Drag بهتر است تغییرات به‌صورت Preview State نگهداری شوند و در پایان Drag
به یک Undo Command تبدیل شوند.

### 8.3 Resize Interaction

Resize باید از Cornerها و Edgeها پشتیبانی کند. قوانین: Corner handle = تغییر
هم‌زمان Width و Height، Edge handle = تغییر تنها یک محور، Shift = حفظ Aspect
Ratio، Alt = Resize از مرکز، Shift+Alt = حفظ نسبت و Resize از مرکز، حداقل اندازه
برای جلوگیری از Scale صفر، پشتیبانی از Rotation هنگام محاسبه‌ی Pointer Delta،
احترام به Lock state.

برای Text Layer دو رفتار Resize لازم است:

- **Fixed Text Box**: Resize باعث تغییر اندازه‌ی Text Container می‌شود و Font
  Size ثابت می‌ماند.
- **Scale Text**: Resize باعث تغییر Scale کل Text Layer می‌شود.

رفتار پیش‌فرض بهتر است Fixed Text Box باشد، مشابه ابزارهای طراحی حرفه‌ای.

### 8.4 Rotate Interaction

Rotate handle باید: زاویه را حول مرکز Layer محاسبه کند، مقدار Rotation را در
Inspector به‌روزرسانی کند، با Shift روی گام‌های 15 درجه Snap شود، نزدیک زاویه‌های
0، 90، 180 و 270 درجه Snap نرم داشته باشد، زاویه را هنگام Drag نمایش دهد.

### 8.5 Multi-Selection

Selection model باید از ابتدا آرایه‌ای باشد: `selectedLayerIds: string[]`.

Interactionها: Click = انتخاب یک Layer، Shift+Click = اضافه یا حذف از Selection،
Drag روی فضای خالی = Marquee Selection، Escape = Clear Selection، Ctrl/Cmd+A =
انتخاب همه‌ی Layerهای قابل انتخاب، Drag گروهی = Move همه‌ی Layerهای انتخاب‌شده،
Delete = حذف Selection، Group = ایجاد Group Layer.

Multi-selection در Inspector باید تنها Propertyهای مشترک را نشان دهد. مقادیر
متفاوت با حالت Mixed نمایش داده شوند.

### 8.6 Direct Text Editing

برای Text Layer: Single-click = انتخاب Layer، Double-click = ورود به Text Edit
Mode، نمایش Caret و Text Selection، تایپ مستقیم روی Canvas، Escape = خروج از Text
Edit Mode، Ctrl/Cmd+A در Text Mode = انتخاب متن نه تمام Layerها، Click خارج از متن
= Commit و خروج. Inspector و Canvas باید هم‌زمان متن را به‌روزرسانی کنند.

Text editing نباید یک Input ساده روی کل Canvas باشد. باید با Position، Rotation،
Scale و Text Box لایه هماهنگ شود.

### 8.7 Canvas Context Menu

Right-click روی Layer: Cut، Copy، Paste، Duplicate، Delete، Bring Forward، Bring
to Front، Send Backward، Send to Back، Group، Ungroup، Lock، Hide، Reset
Transform، Fit to Canvas، Center Horizontally، Center Vertically.

Right-click روی فضای خالی: Paste، Select All، Add Text، Add Shape، Add Image،
Canvas Settings.

## 9. Unified Selection Synchronization

چهار بخش باید از یک Selection Store مشترک استفاده کنند:

```
Layers Panel
     ↕
Canvas
     ↕
Inspector
     ↕
Timeline
```

رفتار مورد انتظار: انتخاب Layer در Layers آن را روی Canvas انتخاب کند. انتخاب
Layer روی Canvas همان Row را در Layers و Timeline فعال کند. انتخاب Lane در
Timeline همان Layer را انتخاب کند. Inspector همیشه Selection فعلی را نمایش دهد.
حذف Layer از هر بخش Selection را پاک‌سازی کند. انتخاب Layer مخفی یا قفل‌شده از
Layers ممکن باشد، ولی Interaction روی Canvas محدود شود. Scroll-to-selection برای
Layers و Timeline وجود داشته باشد. هیچ‌کدام از این بخش‌ها نباید Selection محلی
مستقل داشته باشند.

## 10. Professional Inspector

Inspector باید Schema-driven و Capability-based باشد.

### 10.1 Scene Inspector

هنگامی که هیچ Layerی انتخاب نشده است:

```
Scene
├── Name
├── Width
├── Height
├── Aspect Ratio Presets
├── Duration
├── Frame Rate
├── Background
├── Safe Area
└── Preview Quality
```

Width، Height و Duration دیگر نباید برای همیشه Read-only باقی بمانند؛ اما
تغییرشان باید Validation و Undo داشته باشد.

### 10.2 Layer Inspector Structure

Accordionهای پیشنهادی: Transform، Content، Typography، Fill، Stroke/Border،
Background، Corner Radius، Shadow، Glow، Blur، Blend & Opacity، Crop & Fit، Mask،
Filters، Animation، Advanced. فقط بخش‌های پشتیبانی‌شده توسط Layer نشان داده شوند.

### 10.3 Transform

Position X/Y، Width/Height، Scale X/Y، Rotation، Anchor X/Y، Flip Horizontal،
Flip Vertical، Reset Transform.

قابلیت‌های ضروری: Drag روی Label برای Scrub عددی، پشتیبانی از Keyboard Arrow،
Increment کوچک با Arrow، Increment بزرگ با Shift+Arrow، Link/Unlink برای Scale و
Size، Keyframe button کنار Propertyهای قابل انیمیت.

### 10.4 Typography

برای Text Layer: Font Family، Font Style، Font Size، Font Weight، Line Height،
Letter Spacing، Paragraph Spacing، Text Align، Vertical Align، Text Transform،
Text Direction، Auto Size Mode، Text Box Mode. همچنین: Font search، Recent fonts،
Local/project fonts، Missing font warning، Font fallback، Bold/Italic/Underline،
Text color از Fill system.

### 10.5 Appearance System

Appearance باید قابلیت چند Effect را در آینده داشته باشد، اما نسخه‌ی اولیه
می‌تواند Single Effect باشد.

- **Fill**: Solid Color، Opacity، Gradient (فاز بعدی)، Image Fill (فاز بعدی)
- **Stroke**: Color، Width، Position، Join، Cap، Dash، Opacity
- **Shadow**: Enabled، Color، Opacity، X، Y، Blur، Spread
- **Glow**: Color، Intensity، Radius، Spread، Blur
- **Blur**: Gaussian Blur، Background Blur (در صورت پشتیبانی Renderer)
- **Blend & Opacity**: Layer opacity، Blend mode، Isolate blending برای Group
  (فاز بعدی). Blend Modeهای اولیه: Normal، Multiply، Screen، Overlay، Darken،
  Lighten، Color Dodge، Color Burn، Difference.

### 10.6 Inspector Keyframe Controls

در کنار هر Property قابل انیمیت: Diamond خالی = Property بدون Keyframe، Diamond
پر = در زمان فعلی Keyframe وجود دارد، Diamond فعال با رنگ متفاوت = Property دارای
Animation است ولی در زمان فعلی Keyframe ندارد، Previous/Next keyframe،
Add/remove keyframe.

تغییر Property در زمانی که Animation فعال است باید بر اساس تنظیم پروژه یکی از این
رفتارها را داشته باشد: Auto-Key روشن = Keyframe ایجاد یا به‌روزرسانی شود. Auto-Key
خاموش = مقدار پایه تغییر کند یا از کاربر هشدار گرفته شود. در فاز اول، Auto-Key
می‌تواند خاموش باشد و تغییر Property در صورت وجود Track، Keyframe زمان فعلی را
ایجاد کند.

## 11. Real Animation Timeline

### 11.1 Timeline Hierarchy

هر Layer باید Expandable باشد:

```
Text Layer
├── Transform
│   ├── Position
│   ├── Scale
│   ├── Rotation
│   └── Opacity
├── Style
│   ├── Fill Color
│   ├── Stroke Width
│   ├── Blur
│   └── Shadow
└── Text
    ├── Font Size
    ├── Tracking
    └── Line Height
```

Propertyها تنها زمانی نمایش داده شوند که: توسط Layer پشتیبانی شوند. Animation
Track داشته باشند. کاربر آن‌ها را Pin کرده باشد. Search یا Filter مربوط به
Animated Properties فعال باشد.

### 11.2 Keyframe Model

```ts
interface MotionKeyframe<T = unknown> {
  id: string;
  timeMs: number;
  value: T;
  interpolation: 'hold' | 'linear' | 'bezier' | 'ease-in' | 'ease-out' | 'ease-in-out';
  easing?: { inX: number; inY: number; outX: number; outY: number };
}

interface MotionAnimationTrack<T = unknown> {
  id: string;
  propertyPath: string;
  keyframes: MotionKeyframe<T>[];
}
```

نمونه‌ی propertyPath: `transform.position.x`، `transform.position.y`،
`transform.scale.x`، `transform.rotation`، `appearance.opacity`،
`appearance.fill.color`، `text.letterSpacing`.

### 11.3 Keyframe Editing

قابلیت‌های اولیه: Add/Delete/Move keyframe، Multi-select keyframes، Duplicate
keyframes، Copy/paste keyframes، Snap به Playhead، Snap به Keyframeهای دیگر،
Previous/next keyframe navigation، Linear/Hold/Ease presets، Undo/redo کامل.

قابلیت‌های بعدی: Graph Editor، Velocity handles، Roving keyframes، Motion path
editing، Expressions.

### 11.4 Layer Timing

هر Layer باید `inPointMs` و `outPointMs` داشته باشد. Timeline باید پشتیبانی کند:
Trim start/end، Move layer timing، Duplicate layer، Split در Playhead برای
Layerهای مناسب، Timeline snapping، Scene duration boundary، Layer visibility
خارج از بازه. در فاز اول Stretch یا Time Remapping ضروری نیست.

### 11.5 Playhead-Driven Canvas Evaluation

Canvas نباید مستقیماً مقادیر خام Document را Render کند. مسیر صحیح:

```
MotionSceneDocument
        ↓
Animation Evaluator
        ↓ currentTimeMs
Resolved Scene State
        ↓
Canvas Renderer
```

هر بار که Playhead تغییر می‌کند: Trackهای فعال خوانده شوند. Keyframeهای قبل و
بعد پیدا شوند. Interpolation محاسبه شود. مقدار نهایی Property تولید شود. Canvas
با Resolved State رندر شود.

این Evaluator باید مستقل از React Componentها باشد تا بعداً توسط موارد زیر نیز
استفاده شود: Preview renderer، Export pipeline، Thumbnail generator، Main
Timeline playback، Headless rendering، Agent editing API.

## 12. Layer Expansion Roadmap

**Phase A — Existing Layers**: Text، Rectangle، Ellipse. برای این سه Layer ابتدا
Direct Manipulation، Inspector و Animation کامل شود.

**Phase B — Media Layers**:

- Image: Asset picker، Replace source، Fit/Fill/Contain/Cover، Crop، Corner
  radius، Mask، Filters
- Video: Poster frame، In/out source trim، Fit/crop، Muted preview، Loop option،
  Basic playback synchronization

**Phase C — Structural Layers**:

- Group: Parent-child transform، Group selection، Ungroup، Nested hierarchy،
  Group opacity، Group blend behavior
- SVG: Import، Scale، Fill override (در صورت امکان)، Preserve original colors،
  Convert to shape (فاز بعدی)

**Phase D — Advanced Layers** (خارج از MVP): HTML Layer، Component Instance،
Particle Layer، Audio-reactive Layer، Generated Layer، Nested Motion Scene.

## 13. Motion Library Integration

### 13.1 Create

دکمه‌ی + Create باید: یک MotionSceneDocument جدید بسازد، id واقعی ایجاد کند،
Draft اولیه را در Motion Library ثبت کند، Studio را با همان document id باز کند.

گزینه‌های Create: Blank، Vertical 1080×1920، Square 1080×1080، Landscape
1920×1080، From Template.

### 13.2 Open

Library Open باید motion id را منتقل کند:

```ts
openMotionStudio({ mode: 'edit', motionDocumentId });
```

Studio باید: سند را Load کند، Version را Validate کند، در صورت نیاز Migration
اجرا کند، Missing Assetها را گزارش دهد، Unsaved changes را Track کند.

### 13.3 Save

Save باید سند فعلی را در Motion Library ذخیره کند. رفتار پیشنهادی: Auto-save با
Debounce، Save indicator در Top Bar، Manual Save با Ctrl/Cmd+S، ذخیره‌ی
Thumbnail، ذخیره‌ی updatedAt، Version increment داخلی در صورت نیاز، Recovery
snapshot برای Crash.

وضعیت‌های UI: Saved، Saving…، Unsaved changes، Save failed، Offline draft.

### 13.4 Publish

Publish نباید فقط Save باشد. Publish باید یک خروجی قابل استفاده ایجاد کند. دو
مقصد:

- **Publish to Motion Library**: نسخه‌ی قابل استفاده و نهایی Scene را در Library
  ثبت می‌کند.
- **Add to Main Timeline**: یک Clip Instance روی Main Timeline ایجاد می‌کند:

```ts
interface MotionClipInstance {
  id: string;
  motionDocumentId: string;
  motionDocumentVersion?: number;
  startTimeMs: number;
  durationMs: number;
  parameters?: Record<string, unknown>;
}
```

برای جلوگیری از خراب‌شدن پروژه با ویرایش‌های بعدی، باید یکی از دو مدل مشخص
انتخاب شود: **Live-linked instance** یا **Version-pinned instance**. پیشنهاد
برای نسخه‌ی اول: Clip به نسخه‌ی Publish‌شده‌ی Scene متصل شود، نه Draft زنده.

### 13.5 Close and Unsaved Changes

هنگام Back یا Close: Save and Close، Discard Changes، Cancel. اگر Auto-save
مطمئن فعال باشد، فقط در Save failure یا Draft unsaved هشدار نمایش داده شود.

## 14. Visual Mode and Code Mode

Code Mode فعلاً نباید تبدیل به یک HTML/CSS Editor جداگانه شود. بهتر است Code
Mode نمایش متنی همان MotionSceneDocument باشد.

فاز اول: Read-only structured document، Syntax highlighting، Jump from selected
Layer to code، نمایش Validation error.

فاز دوم: Editable JSON/DSL، Parse و Validate، Apply changes، Sync با Visual
Mode، Error recovery، Undo integration.

Code Mode نباید Source of Truth جداگانه داشته باشد.

```
Visual Mode ─┐
             ├── MotionSceneDocument
Code Mode ───┘
```

## 15. HTML Scenes Relationship

در نسخه‌ی فعلی هیچ Bridge مستقیمی لازم نیست. HTML Scenes و Motion Studio باید
مستقل بمانند. در آینده می‌توان دو عملیات کنترل‌شده اضافه کرد: Import HTML Scene
as HTML Layer، Export Motion Scene as HTML Package. این عملیات Conversion هستند
و نباید باعث یکی‌شدن دو Editor شوند.

## 16. Undo / Redo Command System

تمام تغییرات Document باید از یک Command Layer عبور کنند. نمونه‌ی Commandها:
AddLayerCommand، DeleteLayerCommand، MoveLayerCommand، ResizeLayerCommand،
RotateLayerCommand، UpdatePropertyCommand، ReorderLayerCommand،
AddKeyframeCommand، MoveKeyframeCommand، TrimLayerCommand، GroupLayersCommand.

Interactionهای پیوسته مانند Drag نباید صدها Undo entry ایجاد کنند. الگو:

```
Pointer Down → Begin transaction
Pointer Move → Preview updates
Pointer Up   → Commit one command
```

Editor-only state مانند Zoom یا Open Accordion نباید وارد Undo history شود.

## 17. Keyboard and Professional Interaction Model

میان‌برهای اولیه:

| Action         | Shortcut                            |
| -------------- | ----------------------------------- |
| Select tool    | `V`                                 |
| Hand tool      | `H` یا Space                        |
| Text tool      | `T`                                 |
| Rectangle      | `R`                                 |
| Ellipse        | `O`                                 |
| Delete         | Delete / Backspace                  |
| Duplicate      | Ctrl/Cmd+D                          |
| Copy / Paste   | Ctrl/Cmd+C / V                      |
| Undo / Redo    | Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z       |
| Save           | Ctrl/Cmd+S                          |
| Select all     | Ctrl/Cmd+A                          |
| Group          | Ctrl/Cmd+G                          |
| Ungroup        | Shift+Ctrl/Cmd+G                    |
| Zoom in/out    | `+` / `-`                           |
| Fit canvas     | `0`                                 |
| Preview        | Space، زمانی که Text Edit فعال نیست |
| Exit text edit | Escape                              |

Focus management باید مشخص کند Shortcut متعلق به Canvas، Inspector input یا Text
Editor است.

## 18. UI Layout Improvements

ساختار فعلی حفظ شود:

```
┌────────────────────────────────────────────┐
│ Top Bar                                    │
├────────────┬───────────────────┬───────────┤
│ Layers     │ Canvas            │ Inspector │
│            │                   │           │
├────────────┴───────────────────┴───────────┤
│ Timeline                                   │
└────────────────────────────────────────────┘
```

بهبودها: ذخیره‌ی اندازه‌ی Panelها، Collapse و Restore هر Panel، Focus Mode برای
Canvas، Timeline height presets، Inspector search، Layer search، Breadcrumb برای
Groupها، Status bar شامل Zoom/Selection/current time، Empty state حرفه‌ای برای
Scene خالی.

## 19. Implementation Phases

**Phase 0 — Stabilize Existing Studio** (هدف: جلوگیری از توسعه روی State
پراکنده): تعریف Source of Truth واحد برای Document، تعریف Editor State مستقل،
یکپارچه‌سازی Selection، تثبیت Layer IDs، تعریف Document version، افزودن Migration
framework، تبدیل تغییرات به Undo Commands، حذف Stateهای تکراری بین Canvas،
Layers و Timeline. خروجی: Studio فعلی بدون تغییر بزرگ ظاهری، معماری قابل توسعه
پیدا می‌کند.

**Phase 1 — Real Library Round-Trip**: Create واقعی، Open با motion id، Save،
Auto-save، Rename، Duplicate، Thumbnail generation، Unsaved state، Publish to
Library، Add published scene to Main Timeline. خروجی: چرخه‌ی اصلی کامل می‌شود:
Create → Edit → Save → Close → Reopen → Publish.

**Phase 2 — Canvas Direct Manipulation**: Bounding box، Corner و Edge handles،
Resize، Rotate، Alignment guides، Snapping، Keyboard movement، Double-click text
editing، Context menu، Lock-aware interaction. خروجی: Text، Rectangle و Ellipse
بدون Inspector نیز قابل ویرایش مستقیم هستند.

**Phase 3 — Capability-Based Inspector**: Inspector schema، Layer capability
registry، Transform، Typography، Fill، Stroke، Shadow، Glow، Blur، Blend mode،
Opacity، Mixed values برای Multi-selection، Keyframe buttons. خروجی: Inspector
بر اساس نوع Layer تغییر می‌کند و فرم ثابت قبلی حذف می‌شود.

**Phase 4 — Animation Engine**: Property paths، Animation tracks، Keyframe
model، Evaluator، Playhead-driven Canvas، Interpolation، Auto-key behavior،
Previous/next keyframe، Undo support. خروجی: Animation واقعی Position، Scale،
Rotation و Opacity فعال می‌شود.

**Phase 5 — Timeline Property Editor**: Expandable layers، Property tracks،
Keyframe rendering، Add/delete/move/multi-select، Layer trimming، Timeline
snapping، Ease presets، Animated-property filter. خروجی: Timeline از Layer Lane
ساده به Property Animation Timeline تبدیل می‌شود.

**Phase 6 — Media and Group Layers**: Image layer، Video layer، SVG layer،
Group layer، Asset picker، Fit/crop، Parent-child transform، Media timing.

**Phase 7 — Advanced Authoring**: Editable Code Mode، Graph Editor، Masks،
Gradient fills، Multiple fills/effects، Motion paths، Expressions، Nested Motion
Scenes، Template parameters، Agent-facing editing API.

## 20. Prioritization Rules

برای جلوگیری از تبدیل پروژه به یک Clone ناقص از After Effects:

باید ابتدا ساخته شود: Library round-trip، Bounding box، Move/resize/rotate،
Text editing، Inspector architecture، Keyframe engine، Property Timeline،
Save/Publish.

باید بعداً ساخته شود: Graph Editor، Expressions، 3D layers، Particle systems،
Advanced masks، Multiple effect stacks، HTML conversion، Audio-reactive
animation، Nested compositions.

اصل محصول: ابتدا یک Motion Studio ساده، پایدار و لذت‌بخش؛ سپس قابلیت‌های
پیشرفته.

## 21. Performance Requirements

Pointer interaction باید نزدیک به 60 FPS باقی بماند. Drag نباید باعث Re-render
کل Studio شود. Timeline و Canvas باید از State subscription محدود استفاده کنند.
Evaluation engine باید pure و قابل Memoization باشد. Thumbnail generation باید
خارج از Interaction اصلی انجام شود. Inspector input نباید Document را در هر
Keystroke سنگین Serialize کند. Sceneهای حداقل 100 Layer باید قابل ویرایش باشند.
Timeline virtualization برای تعداد زیاد Property Row در نظر گرفته شود. Media
decoding نباید Main UI thread را مسدود کند.

## 22. Acceptance Criteria

نسخه‌ی اصلی Upgrade زمانی قابل قبول است که سناریوی زیر کامل کار کند:

1. کاربر از Motion Library یک Scene جدید ایجاد می‌کند.
2. Studio با id واقعی باز می‌شود.
3. کاربر یک Text Layer اضافه می‌کند.
4. متن را با Double-click روی Canvas ویرایش می‌کند.
5. Layer را Move، Resize و Rotate می‌کند.
6. Fill، Stroke و Shadow را از Inspector تغییر می‌دهد.
7. یک Rectangle اضافه می‌کند.
8. هر Layer در Layers، Canvas و Timeline Sync باقی می‌ماند.
9. برای Position و Opacity Keyframe می‌سازد.
10. با حرکت Playhead، Canvas مقدار انیمیت‌شده را نمایش می‌دهد.
11. Scene ذخیره می‌شود.
12. Studio بسته و دوباره باز می‌شود.
13. تمام Layerها و Keyframeها بدون تغییر باقی می‌مانند.
14. Publish یک نسخه در Motion Library ایجاد می‌کند.
15. Add to Timeline یک Motion Clip معتبر روی Main Timeline می‌سازد.
16. Preview در Main Editor با Preview داخل Studio یکسان است.

> Status 2026-07-28: steps 1–3, 7–8, 11–13 pass (Phase 0/1 done). Steps 4–6, 9–10,
> 14 partial (Publish exists but only to the Library, not "usable finalized
> artifact" verified against a real render), 15–16 not started. See P17.

## 23. Final Product Principle

Motion Studio نباید صرفاً یک Inspector با Canvas باشد. تجربه‌ی نهایی باید بر این
سه اصل ساخته شود:

- **Direct**: کاربر بیشتر عملیات را مستقیماً روی Canvas انجام می‌دهد.
- **Synchronized**: Layers، Canvas، Inspector و Timeline همیشه یک Scene و
  Selection مشترک را نمایش می‌دهند.
- **Animatable**: هر Property مهمی که کاربر تغییر می‌دهد، قابلیت
  تبدیل‌شدن به Animation Track و Keyframe را دارد.

تعریف نهایی محصول: Motion Studio یک سازنده‌ی مستقل MotionSceneDocument با
ویرایش مستقیم CapCut-style، دقت Figma-style، کنترل‌های Essential Graphics و
Timeline موشن ساده‌شده است؛ بدون اینکه پیچیدگی کامل After Effects را به کاربر
تحمیل کند.
