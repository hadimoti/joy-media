# Joy Media Architecture Summary

## Overview

Joy Media is a professional video editing application built with a modular, package-based architecture. The system follows a clean separation of concerns with immutable data models, command-based state management, and a renderer-agnostic intermediate representation.

---

## 1. Core Types and Interfaces

### 1.1 Project Schema (`@joy-media/project-schema`)

**Time Primitives:**

- `TimeUs`: Integer microseconds (never floats)
- `Rational`: Frame rates as `{ num, den }` (e.g., 30000/1001 for 29.97fps)
- `TimeRange`: `{ startUs, durationUs }` - end-exclusive ranges

**Document Model (v1):**

```typescript
JoyProjectV1 {
  schemaVersion: 1
  id, title, createdAt, updatedAt
  rootCompositionId
  settings: { defaultLocale }
  compositions: Record<CompositionId, CompositionV1>
  assets: Record<string, AssetRecordV1>
  variables: Record<string, JsonValue>
  markers: MarkerV1[]
  visualObjects: Record<string, VisualObjectV1>
  captionDocuments: Record<string, CaptionDocumentV1>
  pluginData: Record<string, JsonValue>
}
```

**Composition Structure:**

```typescript
CompositionV1 {
  id, name, width, height
  pixelAspectRatio: Rational
  frameRate: Rational
  durationUs: TimeUs
  background: string
  tracks: TrackV1[]
}

TrackV1 {
  id
  kind: 'video' | 'audio' | 'caption' | 'object' | 'control'
  name, order, enabled, locked
  clips: ClipV1[]
}
```

**Clip Types:**

```typescript
ClipV1 = VideoClipV1 | CompositionClipV1 | CaptionClipV1

VideoClipV1 {
  kind: 'video'
  assetId, startUs, durationUs, sourceInUs
}

CompositionClipV1 {
  kind: 'composition'
  compositionId, startUs, durationUs, childOffsetUs
}

CaptionClipV1 {
  kind: 'caption'
  captionDocumentId, startUs, durationUs
}
```

**Visual Objects:**

```typescript
VisualObjectV1 {
  id
  kind: 'image' | 'text' | 'shape' | 'null'
  transform: VisualObjectTransformV1
  animations?: Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>
  parentId?: string
  motionBlur?: MotionBlurV1
  assetId?, text?, shape?
}

VisualObjectTransformV1 {
  x, y, scaleX, scaleY, rotationDeg, opacity
  crop: { left, top, right, bottom }
}

AnimatablePropertyV1 = 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity'
```

**Animation System:**

```typescript
AnimationCurveV1 {
  keyframes: KeyframeV1[]
}

KeyframeV1 {
  timeUs: TimeUs
  value: number
  interpolation: 'hold' | 'linear' | 'eased' | 'bezier'
  bezier?: BezierHandlesV1
}

BezierHandlesV1 {
  x1, y1, x2, y2  // cubic bezier control points
}
```

**Caption Model:**

```typescript
CaptionDocumentV1 {
  id, language, direction: 'ltr' | 'rtl' | 'auto'
  speakers: CaptionSpeakerV1[]
  words: Record<string, CaptionWordV1>
  segments: CaptionSegmentV1[]
  styleRef?, animationRef?
  provenance?: { providerId, modelId, createdAt }
}

CaptionWordV1 {
  id, text, startUs, endUs
  confidence?, speakerId?
}

CaptionSegmentV1 {
  id, startUs, endUs
  wordIds: string[]
  textOverride?, speakerId?
}
```

### 1.2 Render IR (`@joy-media/render-ir`)

**Renderer-Intermediate Representation:**

```typescript
RenderFrameIR {
  version: 1
  compositionId, timeUs
  viewport: { width, height, dpr }
  background: Rgba
  nodes: RenderNode[]
}

RenderNode = SpriteNode | VideoFrameNode | TextNode | GroupNode

SpriteNode {
  kind: 'sprite'
  id, zIndex, opacity, transform
  width, height, color: Rgba
}

VideoFrameNode {
  kind: 'video-frame'
  id, zIndex, opacity, transform
  width, height, sourceTimeUs, color: Rgba
}

TextNode {
  kind: 'text'
  id, zIndex, opacity, transform
  text, color: Rgba
  direction?, align?, maxWidth?, fontSizePx?
  background?, spans?: TextSpan[]
}

GroupNode {
  kind: 'group'
  id, zIndex, opacity, transform
  children: RenderNode[]
}
```

### 1.3 Audio Core (`@joy-media/audio-core`)

**Audio Types:**

```typescript
WaveformBucket { min: number, max: number }

PcmWavExport {
  mimeType: 'audio/wav'
  sampleRate, sampleCount
  bytes: Uint8Array
  sha256: string
}

AudioPreviewClock {
  sampleRate: number
  timeUs: number
  sampleIndex: number
  seek(timeUs): number
  advanceBy(elapsedUs): number
}
```

### 1.4 Provider SDK (`@joy-media/provider-sdk`)

**Provider Interface:**

```typescript
Provider {
  manifest: ProviderManifest
  invoke(capability, input): Promise<TranscriptionResult>
}

ProviderManifest {
  id, version: 1
  capabilities: ['speech.transcribe']
}

TranscriptionResult {
  language: string
  words: TranscriptionWord[]
  speakers?: { id, name }[]
  provenance: { providerId, modelId, createdAt }
}

TranscriptionWord {
  text, startUs, endUs
  confidence?, speakerId?
}
```

### 1.5 Media Core (`@joy-media/media-core`)

**Asset Management:**

```typescript
AssetRecord {
  id, kind: 'video' | 'image'
  displayName, contentHash, byteLength
  locations: AssetLocation[]
  derivatives: AssetDerivative[]
}

AssetLocation {
  kind: 'worker-file'
  workerId, opaquePathId
}

AssetDerivative {
  id, kind: 'thumbnail' | 'proxy'
  sourceAssetId, byteLength
  location: AssetLocation
}

MediaDescriptor {
  durationUs, width?, height?
  videoCodec?, audioCodec?, sampleRate?
}
```

### 1.6 Job Protocol (`@joy-media/job-protocol`)

**Worker Communication:**

```typescript
WorkerHello {
  protocolVersion: 1
  workerId, workerVersion, platform, architecture
  capabilities: WorkerCapability[]
  localAssetIds: string[]
  maxConcurrentJobs: number
}

ThumbnailJob {
  protocolVersion: 1
  jobId, type: 'asset.thumbnail'
  payload: { assetId, maxEdgePx }
  requirements: { capabilities, privacy: 'local-only' }
  idempotencyKey, maxAttempts
}

ThumbnailJobSnapshot {
  job: ThumbnailJob
  state: 'queued' | 'assigned' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'canceled'
  attempts, assignedWorkerId?
  progress?: { completed, total, message }
  cancellationRequested, outputAssetId?, failureCode?
}
```

---

## 2. Architectural Patterns

### 2.1 Command Pattern

**Core Principle:** All state mutations are expressed as commands that return both the new state and an inverse command for undo.

**Timeline Commands (`@joy-media/commands`):**

```typescript
SpikeCommand =
  | { type: 'timeline.insertClip', payload: InsertClipPayload }
  | { type: 'timeline.removeClip', payload: RemoveClipPayload }
  | { type: 'timeline.moveClip', payload: MoveClipPayload }
  | { type: 'timeline.trimClipStart', payload: TrimClipStartPayload }
  | { type: 'timeline.trimClipEnd', payload: TrimClipEndPayload }
  | { type: 'timeline.splitClip', payload: SplitClipPayload }
  | { type: 'timeline.joinClips', payload: JoinClipsPayload }
  | { type: 'property.setTrackEnabled', payload: SetTrackEnabledPayload }
```

**Visual Object Commands (`@joy-media/property-system`):**

```typescript
VisualObjectCommand =
  | { type: 'object.setTransformProperty', payload: { objectId, key, value } }
  | { type: 'object.setCrop', payload: { objectId, crop } }
  | { type: 'marker.add', payload: { marker } }
  | { type: 'marker.remove', payload: { markerId } }
  | CaptionCommand
  | MotionCommand
```

**Caption Commands (`@joy-media/captions-core`):**

```typescript
CaptionCommand =
  | { type: 'caption.setSegmentText', payload: { documentId, segmentId, textOverride } }
  | { type: 'caption.setSegmentTiming', payload: { documentId, segmentId, startUs, endUs } }
  | { type: 'caption.setWordTiming', payload: { documentId, wordId, startUs, endUs } }
  | { type: 'caption.addSegment', payload: { documentId, segment } }
  | { type: 'caption.removeSegment', payload: { documentId, segmentId } }
  | { type: 'caption.setStyle', payload: { documentId, styleRef } }
  | { type: 'caption.replaceDocument', payload: { documentId, document } }
```

**Motion Commands (`@joy-media/motion-core`):**

```typescript
MotionCommand =
  | { type: 'object.replaceAnimation', payload: { objectId, property, curve? } }
  | { type: 'object.setParent', payload: { objectId, parentId? } }
```

**Command Application Pattern:**

```typescript
function applyCommand(project: Project, command: Command): ApplyResult {
  // 1. Validate command
  // 2. Compute new state
  // 3. Compute inverse from pre-state
  // 4. Validate new state
  // 5. Return { project, inverse }
}
```

### 2.2 Transaction Pattern

**Atomic Groups:** Commands are grouped into transactions that apply atomically.

```typescript
CommandTransaction {
  label: string
  commands: SpikeCommand[]
  coalesceKey?: string  // for merging continuous edits
}

applyTransaction(project, transaction): TransactionResult {
  // Apply all commands
  // Collect inverses in reverse order
  // Return { project, record }
}
```

### 2.3 History Pattern

**Undo/Redo Stack:**

```typescript
ProjectHistory {
  present: Project
  undo: TransactionRecord[]
  redo: TransactionRecord[]

  apply(transaction): Project
  undo(): Project
  redo(): Project
}
```

**Coalescing:** Continuous interactions (e.g., dragging) can be merged into a single undo step using `coalesceKey`.

### 2.4 Persistence Pattern

**Write-Ahead Log:**

```typescript
LocalProjectPersistence<P, T> {
  initialize(project): void
  saveTransaction(project, transaction): P
  recover(projectId): RecoveryResult<P>
}

PersistenceAdapter<P, T> {
  projectId: (project) => string
  schemaVersion: (project) => number
  validate: (project) => Diagnostic[]
  apply: (project, transaction) => P
}
```

**Recovery Strategy:**

1. Find latest valid snapshot (checksum verified)
2. Replay transactions after snapshot
3. Stop at first invalid transaction
4. Return recovered project with warnings

### 2.5 Renderer-Agnostic Pattern

**Evaluation Pipeline:**

```
Project → Evaluator → Render IR → Renderer → Pixels
```

**Evaluator (`@joy-media/evaluator`):**

```typescript
evaluateFrame(project, compositionId, timeUs): EvaluatedFrame {
  compositionId, timeUs, frameIndex
  frames: EvaluatedVideoFrame[]
}

EvaluatedVideoFrame {
  clipPath: ClipId[]
  assetId, sourceTimeUs
}
```

**Renderers:**

- `@joy-media/renderer-headless`: Software rasterizer for testing
- `@joy-media/renderer-pixi`: GPU-accelerated preview (production)

Both consume the same `RenderFrameIR` and produce pixel buffers.

### 2.6 Worker Pattern

**Outbound Pairing:**

```typescript
Worker → Coordinator: PairingRequest
Coordinator → Worker: PairingGrant (session token)
Worker → Coordinator: WorkerHello (capabilities)
```

**Job Lifecycle:**

```typescript
Coordinator: enqueueThumbnail(job) → queued
Worker: claimNextThumbnail() → assigned
Worker: beginThumbnail() → running
Worker: reportThumbnailProgress() → progress updates
Worker: succeedThumbnail() → succeeded
  or failThumbnail() → failed
  or finishCanceled() → canceled
```

### 2.7 Provider Pattern

**Capability-Based:**

```typescript
Provider {
  manifest: { id, version, capabilities }
  invoke(capability, input): Promise<Result>
}
```

**Current Capabilities:**

- `speech.transcribe`: Audio → CaptionDocument

**Provider Implementation:**

```typescript
createLocalWhisperProvider(execute, modelId): Provider {
  // Wraps execution function
  // Adds provenance tracking
  // Handles errors uniformly
}
```

---

## 3. Package Dependency Graph

```
Layer 0 (Foundation):
  project-schema (types, validation, time primitives)
  render-ir (renderer intermediate representation)

Layer 1 (Core Logic):
  commands → project-schema
  audio-core (standalone)
  motion-core → project-schema
  captions-core → project-schema, render-ir
  evaluator → project-schema, motion-core

Layer 2 (UI Support):
  property-system → project-schema, captions-core, motion-core
  timeline-engine → project-schema, commands
  playback-engine (standalone)
  media-core (standalone)

Layer 3 (Rendering):
  renderer-headless → render-ir
  renderer-pixi → render-ir
  html-scene-runtime → render-ir

Layer 4 (Persistence):
  project-persistence (generic, adapter-based)

Layer 5 (Integration):
  provider-sdk → project-schema
  job-protocol (standalone)
  export-core (standalone)

Layer 6 (Applications):
  editor-web → all packages
  worker → job-protocol, export-core, media-core
```

**Key Dependency Rules:**

- Dependencies point inward (toward project-schema)
- No circular dependencies
- Renderers depend only on render-ir, never on project model
- Commands are pure functions over immutable data

---

## 4. Extension Points

### 4.1 Audio Extensions

**Current State:**

- `AudioPreviewClock`: Timeline-synchronized audio clock
- `buildWaveform`: Waveform visualization from PCM samples
- `exportPcm16Wav`: Deterministic WAV export

**Extension Points:**

1. **Audio Clip Type:**

   ```typescript
   // Add to ClipV1 union
   AudioClipV1 {
     kind: 'audio'
     assetId, startUs, durationUs, sourceInUs
     gain?: number
     pan?: number
   }
   ```

2. **Audio Track Kind:**

   ```typescript
   // Already defined in TrackV1
   kind: 'audio'; // ready for implementation
   ```

3. **Audio Effects:**

   ```typescript
   // Add to VisualObjectV1 or create AudioEffectV1
   AudioEffectV1 {
     id, type: 'gain' | 'fade' | 'filter'
     parameters: Record<string, number>
     animationCurve?: AnimationCurveV1
   }
   ```

4. **Audio Mixer:**

   ```typescript
   // New package: @joy-media/audio-mixer
   AudioMixer {
     mix(tracks: AudioTrack[], timeUs): Float32Array
   }
   ```

5. **Audio Decoders:**
   ```typescript
   // Extend FrameDecoder interface
   AudioDecoder {
     decode(assetId, sourceTimeUs, duration): Promise<Float32Array>
   }
   ```

### 4.2 Provider Extensions

**Current State:**

- `Provider` interface with `speech.transcribe` capability
- `createLocalWhisperProvider` factory

**Extension Points:**

1. **New Capabilities:**

   ```typescript
   type ProviderCapability =
     | 'speech.transcribe'
     | 'speech.synthesize' // TTS
     | 'image.generate' // AI image generation
     | 'video.analyze' // Scene detection
     | 'audio.separate' // Stem separation
     | 'caption.translate'; // Translation
   ```

2. **Provider Registry:**

   ```typescript
   // New package: @joy-media/provider-registry
   ProviderRegistry {
     register(provider: Provider): void
     get(capability: ProviderCapability): Provider[]
     invoke(capability, input): Promise<Result>
   }
   ```

3. **Cloud Providers:**

   ```typescript
   createOpenAIWhisperProvider(apiKey): Provider
   createGoogleSpeechProvider(credentials): Provider
   createAzureSpeechProvider(key, region): Provider
   ```

4. **Provider Results:**

   ```typescript
   // Extend TranscriptionResult
   TranscriptionResult {
     language, words, speakers, provenance
     confidence?: number           // overall confidence
     alternativeTexts?: string[]   // alternative transcriptions
     metadata?: Record<string, any>
   }
   ```

5. **Provider UI Integration:**
   ```typescript
   // Extend editor-web with provider selection UI
   ProviderSelector {
     capability: ProviderCapability
     onSelect: (provider: Provider) => void
   }
   ```

### 4.3 Clip Type Extensions

**Current Clip Types:**

- `VideoClipV1`
- `CompositionClipV1`
- `CaptionClipV1`

**Potential Extensions:**

```typescript
// Audio clip
AudioClipV1 {
  kind: 'audio'
  assetId, startUs, durationUs, sourceInUs
  gain?, pan?
}

// Image clip
ImageClipV1 {
  kind: 'image'
  assetId, startUs, durationUs
}

// Effect clip
EffectClipV1 {
  kind: 'effect'
  effectType: string
  parameters: Record<string, any>
  startUs, durationUs
}

// Generator clip
GeneratorClipV1 {
  kind: 'generator'
  generatorType: 'solid' | 'gradient' | 'noise'
  parameters: Record<string, any>
  startUs, durationUs
}
```

### 4.4 Track Type Extensions

**Current Track Kinds:**

- `video`
- `audio` (defined but not implemented)
- `caption`
- `object`
- `control`

**Potential Extensions:**

```typescript
// Adjustment layer
kind: 'adjustment';

// Effect track
kind: 'effect';

// Guide track (non-rendering)
kind: 'guide';
```

### 4.5 Renderer Extensions

**Current Renderers:**

- Headless (software)
- Pixi (GPU preview)

**Extension Points:**

1. **Export Renderer:**

   ```typescript
   // New package: @joy-media/renderer-export
   renderExportFrame(frame: RenderFrameIR): Uint8Array {
     // High-quality software rendering
     // No preview optimizations
   }
   ```

2. **WebGL Renderer:**

   ```typescript
   // New package: @joy-media/renderer-webgl
   createWebGLRenderer(canvas): Renderer
   ```

3. **Custom Render Nodes:**
   ```typescript
   // Extend RenderNode union
   CustomNode {
     kind: 'custom'
     shaderType: string
     uniforms: Record<string, any>
   }
   ```

### 4.6 Command Extensions

**Adding New Commands:**

1. Define command type in appropriate package
2. Implement `apply*Command` function
3. Compute inverse from pre-state
4. Add to command union type
5. Update command registry (for UI discovery)

**Example:**

```typescript
// New command
type SetAudioGainCommand = {
  type: 'audio.setGain';
  payload: { clipId: string; gain: number };
};

// Implementation
function applySetAudioGain(project: JoyProjectV1, command: SetAudioGainCommand): ApplyResult {
  const clip = findClip(project, command.payload.clipId);
  const previousGain = clip.gain ?? 1.0;

  return {
    project: updateClip(project, clip.id, { gain: command.payload.gain }),
    inverse: {
      type: 'audio.setGain',
      payload: { clipId: clip.id, gain: previousGain },
    },
  };
}
```

### 4.7 Property System Extensions

**Current Animatable Properties:**

- `x`, `y`, `scaleX`, `scaleY`, `rotationDeg`, `opacity`

**Extension Points:**

1. **New Animatable Properties:**

   ```typescript
   type AnimatablePropertyV1 =
     | 'x'
     | 'y'
     | 'scaleX'
     | 'scaleY'
     | 'rotationDeg'
     | 'opacity'
     | 'crop.left'
     | 'crop.top'
     | 'crop.right'
     | 'crop.bottom'
     | 'blur' // motion blur amount
     | 'hue' // color adjustment
     | 'saturation'
     | 'brightness';
   ```

2. **Custom Properties:**

   ```typescript
   // Add to VisualObjectV1
   customProperties?: Record<string, number | string | boolean>
   ```

3. **Property Editors:**
   ```typescript
   // Extend VISUAL_INSPECTOR
   const VISUAL_INSPECTOR: PropertyDescriptor[] = [
     // ... existing
     { key: 'blur', label: 'Blur', kind: 'number', min: 0, max: 100 },
   ];
   ```

### 4.8 Export Extensions

**Current Export:**

- FFmpeg-based H.264/AAC export
- Fixed preset: `social-h264-aac`

**Extension Points:**

1. **Export Presets:**

   ```typescript
   type ExportPreset =
     'social-h264-aac' | 'webm-vp9-opus' | 'prores-422' | 'h265-main10' | 'gif' | 'image-sequence';
   ```

2. **Custom Encoders:**

   ```typescript
   interface Encoder {
     encode(manifest: RenderManifest, frames: Uint8Array[]): Promise<Buffer>;
   }
   ```

3. **Streaming Export:**
   ```typescript
   // New package: @joy-media/export-streaming
   streamExport(manifest, frameGenerator): ReadableStream
   ```

---

## 5. Data Flow

### 5.1 Editing Flow

```
User Action
  ↓
Command Controller
  ↓
applyCommand(project, command)
  ↓
{ newProject, inverse }
  ↓
ProjectHistory.apply(transaction)
  ↓
LocalProjectPersistence.saveTransaction()
  ↓
React State Update
  ↓
UI Re-render
```

### 5.2 Playback Flow

```
PlaybackScheduler.tick()
  ↓
PlaybackScheduler.seek(timeUs)
  ↓
Evaluator.evaluateFrame(project, compositionId, timeUs)
  ↓
EvaluatedFrame
  ↓
Build RenderFrameIR
  ↓
Renderer.render(frame)
  ↓
Pixels → Canvas/Video Element
```

### 5.3 Export Flow

```
ExportJob
  ↓
For each frame:
  Evaluator.evaluateFrame()
  ↓
  Build RenderFrameIR
  ↓
  Renderer.render()
  ↓
  Collect RGBA frames
  ↓
ExportCore.renderRgbaFrames()
  ↓
FFmpeg encoding
  ↓
Output file
```

### 5.4 Transcription Flow

```
User clicks "Transcribe"
  ↓
Provider.invoke('speech.transcribe', { assetId, language })
  ↓
TranscriptionResult
  ↓
captionDocumentFromTranscription()
  ↓
CaptionDocumentV1
  ↓
caption.replaceDocument command
  ↓
Project update
```

---

## 6. Key Design Decisions

### 6.1 Immutable Data

- All project data is immutable (`readonly`)
- Commands return new state, never mutate
- Enables cheap undo/redo via inverse commands
- Simplifies reasoning about state changes

### 6.2 Integer Microseconds

- All time values are integer microseconds (`TimeUs`)
- Never float seconds
- Avoids floating-point drift in long timelines
- Exact frame mapping via rational frame rates

### 6.3 Rational Frame Rates

- Frame rates as `{ num, den }` (e.g., 30000/1001)
- Exact representation of NTSC, PAL, etc.
- Precise frame-to-time mapping

### 6.4 Renderer-Agnostic IR

- Render IR is separate from project model
- Renderers consume IR, never project data
- Enables multiple renderer implementations
- Clean separation of concerns

### 6.5 Command-Based State

- All mutations are commands
- Commands are serializable
- Enables CRDT/ collaboration later
- Audit trail of all changes

### 6.6 Local-First Persistence

- Write-ahead log for crash recovery
- Periodic snapshots for performance
- Checksum verification
- No server dependency for core functionality

### 6.7 Worker Isolation

- Workers run in separate process
- Communication via structured messages
- Workers have local file access
- Control plane has no path access

### 6.8 Provider Abstraction

- Providers are capability-based
- Providers are replaceable
- Results are normalized
- Provenance tracking built-in

---

## 7. Testing Strategy

### 7.1 Unit Tests

- Every package has comprehensive tests
- Pure functions are easy to test
- Command tests verify both forward and inverse

### 7.2 Integration Tests

- Worker control plane integration
- Persistence recovery scenarios
- End-to-end editing flows

### 7.3 Golden Tests

- Renderer parity tests (headless vs Pixi)
- Export verification (ffprobe)
- Frame-exact evaluation tests

---

## 8. Performance Considerations

### 8.1 Timeline Virtualization

- Only visible tracks are rendered
- `virtualTracks()` filters by viewport
- Reduces DOM/Canvas load

### 8.2 Frame Caching

- `FrameCache` stores decoded frames
- LRU eviction policy
- Reduces redundant decoding

### 8.3 Proxy Media

- Low-resolution proxies for preview
- Full resolution for export
- `ProxyCache` tracks derivatives

### 8.4 Waveform Compression

- `encodeWaveformPeaks()` compresses waveform data
- int16 quantization
- 4 bytes per bucket (min/max)

---

## 9. Security Considerations

### 9.1 Opaque Identifiers

- Asset locations use opaque IDs, never paths
- Workers resolve paths locally
- Control plane never sees filesystem paths

### 9.2 Provider Sandboxing

- Providers run in isolated context
- No direct file access
- Results are validated

### 9.3 Input Validation

- All external data is validated
- Diagnostic-based error reporting
- No exceptions for invalid data

---

## 10. Future Directions

### 10.1 Collaboration

- CRDT-based merging
- Real-time multi-user editing
- Conflict resolution strategies

### 10.2 Cloud Integration

- Automatic owner-private original backup through the authenticated API
- Curated cross-account cloud catalog, isolated from personal backups
- Reference-counted private-object deletion
- Cloud rendering
- Provider marketplace

### 10.3 Plugin System

- User-defined commands
- Custom renderers
- Third-party providers

### 10.4 Advanced Features

- Audio mixing and effects
- Color grading
- 3D compositing
- AI-assisted editing

---

## Summary

Joy Media is a professionally architected video editing system with:

- **Clean separation of concerns** across 20+ packages
- **Immutable, command-based state management** with full undo/redo
- **Renderer-agnostic intermediate representation**
- **Local-first persistence** with crash recovery
- **Extensible provider system** for AI capabilities
- **Worker-based architecture** for heavy processing
- **Comprehensive type safety** with TypeScript
- **Extensive test coverage** at all levels

The architecture is designed for:

- **Correctness**: Pure functions, validation, diagnostics
- **Performance**: Virtualization, caching, proxy media
- **Extensibility**: Command pattern, provider abstraction, renderer IR
- **Security**: Opaque identifiers, sandboxing, validation
- **Maintainability**: Clear dependencies, single responsibility, documentation

The system is production-ready for core editing workflows and provides clear extension points for audio, providers, and advanced features.
