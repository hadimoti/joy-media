# WP-29 — GPT Chrome Reliability Rerun

Run ID: `20260810-wp29`  
Run date: 2026-08-10  
Target: [https://joyst.ir/](https://joyst.ir/)  
Scope: WP-29 implementation verification and browser safety smoke. This is a
follow-up to the historical 100-scenario report
[`gpt-chrome-usage-audit-20260809.md`](gpt-chrome-usage-audit-20260809.md).

## Result

The reliability slice is verified in the canonical repository and the local
browser harness is green. The full signed-in 100-scenario closure is **not yet
claimed**: the 37 cases that required a real authenticated file bridge, a
disposable Worker, or destructive live operations remain open until they are
run with evidence. Carry-forward outcomes and defects remain in the historical
report and are not silently converted to PASS here.

### Automated evidence

| Check                        | Result   | Evidence                                                                                                                                            |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                   | PASS     | `pnpm typecheck`                                                                                                                                    |
| ESLint                       | PASS     | `pnpm lint`                                                                                                                                         |
| Production build             | PASS     | `pnpm build` (38/39 buildable workspaces)                                                                                                           |
| Unit/integration tests       | PASS     | 232 files; 1,722 passed; 2 skipped                                                                                                                  |
| Production dependency audit  | PASS     | `pnpm audit:prod`; no known vulnerabilities                                                                                                         |
| Browser safety smoke         | PASS     | `pnpm test:e2e`; 3 projects: 1639×1066, 1366×768, 1024×768                                                                                          |
| Axe login gate               | PASS     | No Axe violations at the three viewport checkpoints                                                                                                 |
| Live project selector        | PASS     | Signed-in JOY tab: visible 32px action button, Rename/Duplicate/Move to Trash menu, Escape dismissal, no horizontal overflow at all three viewports |
| Live Audio Studio            | PASS     | Signed-in JOY tab: three equal `40.9018px` runtime cards at 1639×1066 and 1024×768; no horizontal overflow; no warning/error logs                   |
| Full repository format check | BASELINE | 81 pre-existing files outside this slice remain unformatted; all changed files pass targeted Prettier check                                         |

The browser smoke records page errors, console errors, failed requests,
horizontal overflow, and Axe violations. It runs against a test-local Vite
server and does not add a production authentication bypass or committed
credentials.

The signed-in live JOY tab was also checked after deployment. The project card
exposed an always-visible 32px action trigger; its anchored menu exposed Rename,
Duplicate, and Move to Trash, and Escape closed the menu with
`aria-expanded="false"`. At 1639×1066, 1366×768, and 1024×768 the document
client and scroll widths were equal. Audio Studio measured three equal
`40.9018px` runtime cards at the primary and minimum viewports; the live tab
reported no warning or error logs. No destructive project action was submitted.

## Implemented WP-29 findings

- Imported-media resolution remains project-scoped and OPFS-first, with
  authorized cloud fallback and an allowlist for static reference media.
- Import/Timeline placement persists safe media descriptors and preserves real
  duration; library placement has an explicit Add to timeline action.
- Export uses content bounds, a single authored mixed-audio source, cancellation
  cleanup, retryable history, and bounded OPFS result caching.
- Operation metadata now records logical IDs, fingerprints, revisions, attempts,
  terminal state, and result/error references; purging a project removes its
  operation records.
- Recovery warnings are surfaced instead of discarded.
- Worker ML capability advertisement fails closed when the command/model is not
  runnable; ML subprocesses are cancellable; keepalives and pairing polling are
  independent of job progress; runtime failures are terminally reported.
- Generated browser-audit fixtures cover PNG, JPEG, MP4, WAV, MP3, SRT, WebVTT,
  unsupported text, and corrupt media with checksum and descriptor metadata.
- The login gate now uses a main landmark and decorative method icons do not
  duplicate button labels; Axe reports no violations in the smoke.

## Open closeout items

These are intentionally **NOT-RUN / OPEN**, not failures hidden by this report:

- Authenticated Playwright golden path: create project → upload fixture →
  timeline placement → captions → browser audio → export → refresh →
  re-download.
- Cases 15–18, 25, 32–33, 37, 46, 53–59, 63, 66–67, 71–85, 89, 93, and 100
  requiring file chooser/DnD, pointer/fullscreen, real Worker pairing, or
  mid-operation reload.
- Worker result insertion into the selected project after approval, including
  one-job/one-result behavior on cancel/retry/reload.
- Browser-level MP4 verification with ffprobe for codec, dimensions, duration,
  and authored audio; the repository has Node export verification, but a live
  browser download must still be captured.
- Controlled playback performance runs using `requestVideoFrameCallback`
  metadata on the named Chrome/GPU host.

No passwords, tokens, personal file paths, or secret configuration values are
included. No public API or production configuration was changed by this audit.
