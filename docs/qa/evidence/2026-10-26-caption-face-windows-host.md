# Caption face on the Windows host: probe deadline, first-start retry and render drift, 2026-10-26

Scope: the L3 Windows acceptance. The case is "changes the caption band when Persian captions render and refuses when the
canonical face is unavailable" in `apps/cli/src/humanized/render-parity.e2e.test.ts`. It was run the way the Windows
lifecycle runs it: `JOY_MEDIA_REQUIRE_CAPTION_FACE=1`, `--no-file-parallelism --retry=0`, one case.

**Status: passing on this host.** Two runs, about 25 seconds each, after the probe deadline fix (`a9aea00b`) and the
bounded retry described below. The lifecycle receipt on the release gate is still pending. That gate runs the case on a CI
Windows runner, which this host does not represent.

## Runs on the host

| Run  | State                                                 | Outcome                                                                                                                       |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Before the fix, the host also running the Linux suite | Failed at preparation: `Chromium text measurement failed: Chromium DevTools endpoint startup timed out`                       |
| 2, 3 | Before the fix, quiet host                            | Failed at render: `RENDER_ENVIRONMENT_DRIFT`. The record has `version null`; the render-time probe has `Chrome/156.0.8078.47` |
| 4, 5 | After the 15-second deadline                          | Failed at render, with the same drift                                                                                         |
| 6, 7 | After the bounded retry                               | Passed, about 25 seconds each                                                                                                 |

## What the failures were

1. The version probe used a 3-second startup deadline. It now uses the capture deadline of 15 seconds (`a9aea00b`).
2. The first Chromium start in each new profile root timed out, even at 15 seconds. Measured with the probe alone: in six
   fresh roots, the first probe failed with `RENDER_CAPTURE_TIMEOUT` every time, and the second probe in the same root
   succeeded every time. Preparation recorded `launchable: false` and `version: null`; the render then probed again,
   succeeded, and the drift check refused the record.
3. Without the Windows system directories in the harness environment, the Persian text measurement during preparation
   exceeded its 15-second budget in seven of seven runs. With those directories it passed in four of four runs. The
   directories were not kept in the harness, because the probe still failed then; see "Open".

## What changed in this step

- `probeChromium` retries once when the first attempt fails with a startup or capture timeout. A browser that never answers
  fails both attempts and is recorded as unlaunchable. An abort stops the retry.
- The drift check is unchanged, and it still blocks a render whose record disagrees with the browser.
- Regression test: `retries a probe whose first browser start runs past its deadline` (`chromium-driver.test.ts`). With the
  retry removed it fails (`expected length 2 but got 1`); with it, all 16 driver tests pass.

## Open

- The cause of the slow first start is not verified. Antivirus scanning of new profile files is the most likely candidate,
  and it was not tested.
- The release gate's lifecycle runs this case on a CI Windows runner. Whether its first start behaves the same way is unknown.
- The harness does not pass the Windows system directories. Adding them fixed the text measurement, but that was reverted,
  because it did not change the probe outcome then. With the retry in place it may not be needed. It was not tested again.

## Decision recorded

Retry the start once, and keep the drift check blocking. The owner may choose a different design: a persistent probe profile,
a longer first-start budget, or an antivirus exclusion for the probe profile folder. The exclusion is a system setting, and it
was not changed.

## Corrupted face (L3 acceptance)

- The probe judges a corrupted face unusable. `caption-face-probe.test.ts` passes corrupted bytes to
  `probeCanonicalCaptionFace`, through a new optional `faceBytes` argument, and asserts `usable: false` (81 ms). With the
  argument ignored, the test fails with `expected true to be false`.
- An unusable probe becomes `SETUP_REQUIRED` with kind `canonical-caption-face-unavailable`. The existing test in
  `capabilities-cmd.test.ts` covers that mapping, through `planMedia` with an unusable injected probe.
- Not covered in one test: real corrupted bytes flowing through the probe into `planMedia`. The two halves are covered
  separately.

## Not claimed

- The lifecycle receipt for L3 is not produced.
- The desktop export spec with the canonical face passed 2 of 2 on the unpacked build earlier, as recorded in the milestone
  status. This evidence does not change that result.
