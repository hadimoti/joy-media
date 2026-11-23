---
name: joy-code-speech-subtitles
description: Use when a user asks for speech subtitles or asks to correct subtitle cue wording or timing in a selected range.
---

# Speech Subtitles

1. Resolve the selected source clip, language, time range, transcript, existing cues and current project revision. Keep reviewed text, names, numbers, punctuation, ZWNJ and diacritics intact.
2. Apply the **Dialogue Cues** design target: use speech boundaries, usually two rendered lines, and roughly 1–5 seconds per cue when the speech supports it. Use 12–17 characters per second only as a Latin-script review signal; use speech boundaries and rendered width for Persian and Arabic.
3. Read the live Joy Code operation list. `caption.setSegmentText` and `caption.setSegmentTiming` can edit identified existing segments when the host advertises them. Joy Code has no speech-recognition or new-cue creation operation. Use the editor's Captions workflow for local transcription and cue creation, when available, and report missing setup otherwise.
4. Read changed cues back. Confirm each changed cue has source evidence, positive duration and timing inside the selected clip. Preview the longest cue and a mixed-script cue when present. Flag crowded cues for a human split review.
5. Stage only typed, scoped changes through the current preview and approval flow. Refresh the project context if its revision changed. Report which checks came from cue data and which came from rendered preview.

**Preset IDs:** Dialogue Cues is a design label and has no native subtitle-generation preset ID. The native caption styles are `joy-clean`, `joy-rtl-classic` and `joy-karaoke-pop`; use Caption Styling to select one. New speech recognition and cue creation remain in the editor's Captions workflow.
