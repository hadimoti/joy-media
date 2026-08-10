# WP-29 R5 — Closure of the 37 former NOT-RUN browser cases

Run ID: `wp29-closeout-20260810-0621-r5`

## Verdict

**OPEN — NOT CLOSED.** Every former NOT-RUN case has an explicit current
functional and UI/A11y outcome below. No case is promoted to PASS without a
reproducible browser action and evidence. The remaining NOT-RUN and
BLOCKED-INTEGRATION outcomes are the acceptance blockers.

## Case matrix

| Case | Functional | UI/A11y | Current evidence / blocker |
|---:|---|---|---|
| 10 | NOT-RUN | PASS | Sign-out confirmation was inspected; no destructive sign-out submitted. |
| 15 | NOT-RUN | PASS | File bridge fixture upload not available in the authenticated Chrome bridge. |
| 16 | NOT-RUN | PASS | Same file bridge blocker for MP4. |
| 17 | NOT-RUN | PASS | Same file bridge blocker for WAV/MP3. |
| 18 | NOT-RUN | PASS | Invalid-file fixture could not be transmitted safely. |
| 24 | BLOCKED-CONSENT | PASS | Destructive/cloud bulk action requires a disposable live project and action-time confirmation. |
| 25 | NOT-RUN | PASS | Timeline placement depends on the blocked file bridge/import fixture. |
| 32 | NOT-RUN | PASS | Pointer drag/snap journey requires a real browser gesture harness; no accepted run. |
| 33 | NOT-RUN | PASS | Trim handles require a real pointer gesture run; no accepted evidence. |
| 37 | NOT-RUN | PASS | Freeze/rate mutation was not submitted in the disposable project. |
| 46 | NOT-RUN | PASS | Fullscreen was not entered; browser permission/display surface not exercised. |
| 53 | NOT-RUN | FAIL | Caption-track path is available after the empty-state fix, but delete/revert was not replayed in a browser run. |
| 54 | NOT-RUN | FAIL | Clean/Karaoke/RTL template mutation was not replayed. |
| 55 | NOT-RUN | FAIL | SRT file input was not exercised. |
| 56 | NOT-RUN | FAIL | WebVTT file input was not exercised. |
| 57 | NOT-RUN | FAIL | Caption download was not captured and parsed. |
| 58 | NOT-RUN | FAIL | English transcription was not submitted in the closure run. |
| 59 | NOT-RUN | FAIL | Persian transcription/RTL seek behavior was not submitted in the closure run. |
| 63 | BLOCKED-INTEGRATION | PASS | Real Worker result path passed at the control-plane level; UI pairing form did not create the dummy worker record, so browser pairing is not closed. |
| 66 | BLOCKED-INTEGRATION | PASS | Worker produced a real RNNoise derivative, but browser Audio “Run locally” wiring was not independently completed. |
| 67 | NOT-RUN | PASS | Browser DSP/Cloud Brain execution needs an explicit cost/remote confirmation and was not submitted. |
| 71 | NOT-RUN | PASS | Effect application was not replayed on a selected browser clip. |
| 72 | NOT-RUN | PASS | Effect Studio recipe was not created/submitted. |
| 74 | NOT-RUN | PASS | Transition replacement was not submitted. |
| 75 | NOT-RUN | PASS | Manual grade mutation/reset was not submitted. |
| 76 | NOT-RUN | PASS | LUT/scopes mutation was not submitted. |
| 77 | NOT-RUN | PASS | Inspector mutation was not submitted on an accepted selected clip. |
| 79 | NOT-RUN | PASS | Motion creation/keyframe edit was not submitted. |
| 80 | NOT-RUN | PASS | Motion rename/duplicate/delete was not submitted. |
| 81 | NOT-RUN | PASS | Motion preset application was not submitted. |
| 82 | NOT-RUN | PASS | HTML scene mutation was not submitted. |
| 83 | NOT-RUN | PASS | Spatial path creation was not submitted. |
| 84 | NOT-RUN | PASS | Camera creation/configuration was not submitted. |
| 85 | NOT-RUN | PASS | Template application/deletion was not submitted. |
| 89 | BLOCKED-INTEGRATION | PASS | Worker revoke/re-lease browser flow remains blocked by pairing-form creation; API receipt/revocation evidence exists. |
| 93 | NOT-RUN | PASS | Joy Code attachment file bridge was not available. |
| 100 | NOT-RUN | PASS | Reload during a live queued/running browser operation was not injected in an accepted run. |

## Evidence and next gate

- Historical source: `docs/qa/gpt-chrome-usage-audit-20260809.md`.
- Worker evidence: `docs/qa/WP-29-r2-worker-result-20260810-0621.md` and its
  0600 receipt JSON.
- R4 controlled playback evidence is separately recorded in
  `docs/qa/WP-29-r4-playback-20260810-0621.md`; it remains blocked because the
  seeded media source decoded zero frames.
- The next valid closure run must use a disposable authenticated browser
  project, Playwright with system Chrome and file fixtures, and explicit
  confirmation before destructive/cloud actions. Until then R5 is not closed.

## Chrome fixture rerun (2026-08-10)

Using the user-enabled Chrome file bridge and a disposable project:

- Case 16 and 25: **PASS/PASS** — `video.mp4` uploaded, was placed on the
  timeline automatically, and played through Program Monitor without console
  errors.
- Case 53: **PASS/PASS** — imported caption deletion removed the cue and Undo
  restored it.
- Case 54: **PASS/PASS** — Karaoke and RTL templates selected correctly; Clean
  was restored afterward.
- Case 55: **PASS/PASS** — `captions-en.srt` imported into an editable cue.
- Case 57: **BLOCKED-INTEGRATION/PASS** — SRT export was invoked but Chrome's
  browser bridge did not emit a downloadable-file event within 10 seconds;
  no application console error was produced.

The other R5 outcomes remain unchanged pending their dedicated fixture,
worker, pointer, or consent flows.


## Browser bridge follow-up (2026-08-10)

A Chrome file-upload continuation was attempted only after the user enabled
local-file access. Before any fixture was selected or transmitted, the Chrome
DevTools attachment detached from the claimed JOY tab. The retry confirmed the
same detached state, so no import case was changed and no user asset was
uploaded. This is **BLOCKED-INTEGRATION**, not an app import failure.

A disposable in-app-browser project, `WP-29 remaining audit 1786378792577`,
was created before the file-bridge continuation switched to Chrome. Its
in-app tab was no longer available to the audit session for cleanup. It must
be moved to Trash and permanently deleted in that in-app browser before R6
can close.
