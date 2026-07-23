# WP-19 — Real normalizeAudio port

**Status:** done 2026-07-23

Replaces `__stub` on `transform.normalizeAudio` with `audio-core.normalizeDialogue` fixture PCM DSP. Other first-party ports remain stubs.

Exit: measuredLufs near target; no `__stub` on normalize output; unit test green.
