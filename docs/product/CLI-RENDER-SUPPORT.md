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
project asks for a feature the current renderer does not implement. This includes playback-rate
changes, freeze frames, reverse playback, time remapping, nested compositions, captions and
caption tracks, visual objects and their transforms/crops/effects, transitions, property
animations, color grading, alpha-bearing media, track mute/solo, non-default audio gain/pan/mute/
solo/fades, processed audio sources, audio effects, or non-default audio-bus routing and settings.
These features are not represented in the encoded video; use the desktop export path for projects
that depend on them. The renderer does not silently flatten or omit them.

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

Not supported by the CLI yet, and rejected or absent rather than approximated: transitions, text
and captions, audio gain/fades/mute, transforms and effects, playback-rate changes, reverse and
time remapping. Add these in the desktop editor and export there.

A real render of a project with no clips fails with `nothing-to-render` (exit 1). Only
`--manifest-only` may succeed without media. Every `--json` failure has the same envelope:
`{"type":"error","code":...,"message":...}`.

Projects may use NTSC rates (23.976, 29.97, 59.94) or an exact fraction (`--fps 30000/1001`).
A real render encodes at that exact rate. A plan-only (`--manifest-only`) render still counts
frames at the preset rate, and says so in its warnings.
