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
