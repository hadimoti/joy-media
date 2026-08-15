# LUNA platform remediation — 2026-08-15

## Release decision

**GO — all identified implementation and test-environment defects from the
2026-08-15 Luna baseline are remediated and the complete local release gate is
green.** This document supersedes the baseline's `NO-GO` decision for this
candidate; the original report remains an immutable record of the findings.

## Remediated platform seams

| Area                    | Correction                                                                                                                                                                                  | Evidence                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Persian captions        | Replaced English words in the `fa-IR` fixture with Persian transcript tokens while retaining RTL and timing coverage.                                                                       | Caption browser cases 56 and 59 pass on primary, compact, and minimum layouts. |
| Local audio             | Escaped Windows RNNoise filter paths and added the DeepFilterNet adapter for the portable local binary. Runtime status now distinguishes installed, setup-required, and unavailable routes. | Unit contract plus real local adapter WAV output.                              |
| Upscaling               | Added the BasicSR compatibility shim required by current torchvision releases.                                                                                                              | RealESRGAN local Worker contract produces the expected 2× image.               |
| Masking                 | Added a Worker router; provisioned local BiRefNet ONNX aliases; repaired local SAM2 loading and enabled Grounding DINO prompt selection.                                                    | BiRefNet, SAM2 box, and SAM2+Grounding prompt contracts produce masks.         |
| Worker source recovery  | Before queueing Local Worker audio, the editor verifies a durable cloud original and restores the registered source from OPFS when a reload/dev catalog lost it.                            | R5 CASE-66 passes its queue/reload routing stage in every desktop project.     |
| Asset routing           | Non-cloud-backed cards no longer probe remote storage. Owner-library items use their owning-project original endpoint; only curated cloud assets use the shared-library endpoint.           | WP-32 real-project journey completes with no console or HTTP errors.           |
| Jobs initialization     | Removed the transient Initialize action shown while authenticated startup was already initializing the project.                                                                             | R5 CASE-100 reload/re-attach passes in every desktop project.                  |
| Browser audit stability | Bound the shared owner/control-plane test fixture to three desktop workers and retained a `PLAYWRIGHT_WORKERS` override for isolated CI capacity.                                           | Full audit: 153 checks passed.                                                 |

## Final verification

| Gate                      | Result                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Unit/integration suite    | **2,209 passed, 2 skipped** across 322 files                              |
| Browser audit             | **153 passed** across primary, compact, and minimum desktop layouts       |
| TypeScript                | `pnpm typecheck` passed                                                   |
| Lint                      | `pnpm lint` passed                                                        |
| Production build          | `pnpm build` passed                                                       |
| Dependency audit          | `pnpm audit --prod --audit-level=moderate` found no known vulnerabilities |
| Formatting / diff hygiene | `pnpm format:check` and `git diff --check` passed                         |

## Local Worker readiness

`run-worker.bat` now points to the installed local model root and routes:

- RNNoise through FFmpeg with Windows-safe paths;
- DeepFilterNet through the portable `deep-filter` binary;
- RealESRGAN through the compatible Python runner;
- BiRefNet, SAM2, and Grounding DINO through the masking router.

Qwen TTS, Demucs, and Speech Enhance stay honestly marked **Runtime setup
required** until their dedicated local execution routes are installed; they are
not represented as downloadable/ready merely because model files may exist.

## Release follow-up

Deploy this reviewed commit through the immutable Sweden VPS release procedure,
retain the preceding API/web release for rollback, then run the signed-in
Chrome smoke and record the exact release labels in GBrain.
