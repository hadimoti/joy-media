# CLI render support boundary

`joy-media render` produces real MP4, WebM, and ProRes/MOV media when project clips resolve to
local files. A successful real render is probed before publication; the CLI reports completion
only when the output contains playable video and audio streams at the planned size, frame rate,
and duration. The sidecar manifest describes the same timeline. `--manifest-only` always plans
without encoding, and label-only projects remain manifest-only.

The current real-media path supports ordinary video, non-alpha still images, and audio clips on
enabled tracks. It places clips at their timeline times, trims `sourceInUs`, draws later video
tracks over earlier ones, and creates a silent audio stream when the sources contain no audio.
Audio placement and stereo channels are preserved. A render targeting a path already in use by
another JOY Media process returns an `output` error. Failed encoding, blocked sidecars, and
interrupted media/manifest replacement leave the last complete output pair intact or recover it
on the next render.

The CLI returns a machine-readable `unsupported-feature` error before starting output when a
project asks for a feature the current renderer does not implement. Features the renderer does
support and reject are listed in the capability catalog.

## Source of truth: `joy-media capabilities --json`

Run `joy-media capabilities --json` for the definitive, up-to-date list of features the CLI
supports and rejects. The catalog is derived from the same code paths the renderer uses, so the
two cannot drift.

### Supported features

| Feature ID                            | Area        | Notes                                                                                                                             |
| ------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `render.real-media`                   | render      | Ordinary video, still images, and audio clips on enabled tracks. Needs ffmpeg/ffprobe (check with `joy-media doctor`).            |
| `render.frame-rate.ntsc-and-fraction` | frame-rate  | NTSC rates (23.976, 29.97, 59.94) and exact fractions (e.g. 30000/1001).                                                          |
| `captions.drawtext`                   | captions    | Captions rendered with ffmpeg drawtext. Needs a font file (set `JOY_MEDIA_CAPTION_FONT` or a system font is used when available). |
| `transitions.dissolve`                | transitions | Dissolve transitions between touching clips are rendered.                                                                         |
| `audio.gain`                          | audio       | Clip gain from 0 to 4 (0 to +12 dB).                                                                                              |
| `audio.fades`                         | audio       | Audio fade-in and fade-out.                                                                                                       |
| `audio.mute`                          | audio       | Clip mute.                                                                                                                        |

### Unsupported features

The following features cause an `unsupported-feature` error before any output is produced:

| Feature ID                      | Area        | Reason                                                              |
| ------------------------------- | ----------- | ------------------------------------------------------------------- |
| `render.alpha-media`            | render      | Alpha-bearing media: the CLI renderer cannot preserve transparency. |
| `render.playback-rate`          | render      | Playback rate changes are not supported.                            |
| `render.freeze-frame`           | render      | Freeze frames are not explicitly supported.                         |
| `render.reverse`                | render      | Reverse playback is not supported.                                  |
| `render.time-remap`             | render      | Time remapping is not supported.                                    |
| `render.nested-composition`     | render      | Nested compositions are rejected as non-video clips.                |
| `render.visual-objects`         | render      | Visual objects, transforms, and effects.                            |
| `render.property-animations`    | render      | Property animations.                                                |
| `render.color-grade`            | render      | Color grading.                                                      |
| `render.audio-effects`          | audio       | Audio effects.                                                      |
| `render.audio-bus-routing`      | audio       | Audio bus routing.                                                  |
| `render.audio-pan`              | audio       | Audio pan.                                                          |
| `render.audio-solo`             | audio       | Audio solo.                                                         |
| `render.track-mute-solo`        | render      | Track mute and solo.                                                |
| `render.audio-processed-source` | audio       | Processed audio sources.                                            |
| `transitions.other`             | transitions | Only dissolve transitions are rendered.                             |

An unresolved real asset is an error. Only projects that contain labels and no real media files
fall back to the plan manifest. This keeps planning useful without presenting a manifest as a
playable export.

## Timeline editing the CLI supports

Every editing command is checked against the decoded output in tests, not only in the project file.

- `timeline add-clip` checks the media before writing: a file-like `--asset` that is not on disk
  is `MEDIA_NOT_FOUND`; audio-only media on a visual track, or media with picture on an audio
  track, is `TRACK_KIND_MISMATCH`; a clip longer than its source is `CLIP_EXCEEDS_SOURCE` unless
  `--allow-extend` is given. Still images are exempt from the source length.
- `timeline add-track --family visual|audio [--name]` adds an empty track on top of the stack.
  Its clips render with the same rules as the default tracks.
- `timeline move --clip <id> [--start <s>] [--track <id>]` moves a clip in time, or to another
  track of the same family. The source, length and overlap checks still apply.
- `timeline split`, `trim` and `remove-clip` are unchanged.

The CLI supports dissolve transitions, captions, audio gain/fades/mute via `timeline set-audio`.
Not supported: pan, solo, effects, bus routing, playback-rate changes, reverse and time remapping,
visual objects, property animations, color grading, alpha media, and non-dissolve transitions.
Add these in the desktop editor and export there.

A real render of a project with no clips fails with `nothing-to-render` (exit 1). Only
`--manifest-only` may succeed without media. Every `--json` failure has the same envelope:
`{"type":"error","code":...,"message":...}`.

Projects may use NTSC rates (23.976, 29.97, 59.94) or an exact fraction (`--fps 30000/1001`).
A real render encodes at that exact rate. A plan-only (`--manifest-only`) render still counts
frames at the preset rate, and says so in its warnings.
