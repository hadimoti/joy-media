# Caption face on the Windows host: probe deadline and render drift, 2026-10-26

Scope: the L3 Windows acceptance. The case is "changes the caption band when Persian captions render and refuses when the
canonical face is unavailable" in `apps/cli/src/humanized/render-parity.e2e.test.ts`. It was run the way the Windows
lifecycle runs it: `JOY_MEDIA_REQUIRE_CAPTION_FACE=1`, `--no-file-parallelism --retry=0`, one case.

**Status: not passing on this host.** One cause is fixed in this change. The other is open, and it needs an owner decision.

## Runs on the host

| Run  | State                                                 | Outcome                                                                                                                       |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Before the fix, the host also running the Linux suite | Failed at preparation: `Chromium text measurement failed: Chromium DevTools endpoint startup timed out`                       |
| 2, 3 | Before the fix, quiet host                            | Failed at render: `RENDER_ENVIRONMENT_DRIFT`. The record has `version null`; the render-time probe has `Chrome/156.0.8078.47` |
| 4, 5 | After the probe fix                                   | Failed at render, with the same drift                                                                                         |

## How the drift happens

1. Preparation probes Chromium (`probeChromium` in `packages/html-scene-runtime/src/chromium-driver.ts`) and stores the
   result in the frozen record.
2. When the probe fails, the record says `launchable: false` and `version: null`. Preparation still succeeds.
3. The render probes again. When the browser answers, it reports a version. The drift check
   (`chromiumFactsChanged` in `apps/cli/src/services/render-preparation.ts`) compares the two and refuses.

A probe failure at preparation therefore becomes a refusal at render, until the project is prepared again.

## Measurements

- Probe from plain Node, normal environment: 957 ms, version `Chrome/156.0.8078.47`.
- Probe under the environment the test harness passes to the CLI: failed at 3 s (`RENDER_CAPTURE_TIMEOUT: Chromium capture
exceeded 3000ms`) after 5.7 s. Succeeded at 15 s in 3.8 s, in two runs.
- Preparation under the full environment: 3 s. Its record has `launchable: true`, `version: "Chrome/156.0.8078.47"`.
- Preparation under the harness environment, after the fix: one run's record had `launchable: false` with the reason
  `Chromium could not be launched headlessly: RENDER_CAPTURE_TIMEOUT: Chromium capture exceeded 15000ms`. Other runs of the
  same environment took 4 s to 18 s.

## What is fixed in this change

- The version probe used a 3-second startup deadline. The capture driver uses 15 seconds. The probe now uses the capture
  deadline. A regression test (`gives the version probe the capture startup deadline…`, `chromium-driver.test.ts`) fails at
  3 seconds (`expected 3000 to be 15000`) and passes at 15 seconds. The runtime driver test file passes 15 of 15 on the host.

## What is still open

- Under the harness environment, with a new Chromium profile for each run, the browser sometimes takes longer than 15 seconds
  to start. The cause is not verified. The most likely candidate is antivirus scanning of the new profile files.
- The harness passes only a few environment variables to the CLI. A trial that also passed the Windows system directories and
  processor facts did not change the outcome in two runs, so it was reverted and is not part of this change.

## Decisions for the owner

1. A probe that fails at preparation currently blocks rendering until the project is prepared again. Keep that, or probe
   again at render time? Probing again is weaker drift protection.
2. Give the probe a persistent profile, so that each run does not start a cold browser?
3. An antivirus exclusion for the probe profile folder would also help. That is a system setting, so it was not changed.

## Not claimed

- L3's Windows acceptance is not met on this host, and no lifecycle receipt exists for it.
- The desktop export spec with the canonical face passed 2 of 2 on the unpacked build, as recorded in the milestone status. That
  result is unchanged by this evidence.
