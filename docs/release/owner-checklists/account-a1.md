# Owner checklist: account and upscale qualification (A1)

Owner-only. Run it at the keyboard, with a dedicated test account. Nothing from this session goes into the repository, CI
logs or gbrain, except the receipt file, which you send to engineering.

The rules for every attended session are in `docs/qa/attended/README.md`. This file gives the order and the exact commands.

## Scope

- Account (L7a, decision D10): sign in with a dedicated test account that has no payment method. Restart, refresh the
  entitlement, go offline, sign out, and confirm that the old token is refused.
- Upscale quality (L7b, decision D12): run one upscale job with the licensed model, and judge the output against a threshold
  you register before the session.
- Not in scope: `cli.worker` (L7c), which stays excluded unless you decide otherwise, and denoise. Denoise is excluded from
  v1.0.3 (`docs/product/FEATURE-STATUS.md`).

## Blockers (engineering, before this session can run)

1. **Upscale measurement.** The repository has no SSIM measurement. The upscale step cannot run until engineering builds and
   tests one. Until then the A1 receipt cannot be accepted.
2. **Sign-out probes.** Step 6 needs two checks: that the stored credential is removed, and that an authenticated call with the
   pre-sign-out token returns 401. Neither probe exists. Do not make these calls by hand. A hand-made call would expose the
   token.
3. **Account origin (D10).** The packaged app uses its default account origin. The test-mode override
   (`JOY_MEDIA_TEST_API_BASE_URL`) accepts loopback addresses only. Confirm which account service holds the dedicated test
   account before you schedule the session.

Tests that already cover the receipt rules (run them on the checkout before the session): `tooling/attended/src/write-receipt.test.ts`
(7 of 7).

## Before the session (you)

1. **Register the threshold.** Set `upscale.ssimMarginOverBicubic` in `docs/qa/attended/model-thresholds.json`, and update the
   `status` field in the same commit. Commit that change alone, before the session. The commit is the registration record. A
   receipt refuses while the value is null.
2. **Literal file.** Create a file outside the repository, with one secret literal per line: the test account's email, its
   password, and any one-time code you expect. Keep it in your password manager, and delete the file after the leak scan.
3. **Model pin (D12).** Obtain the licensed model file and compute its SHA-256. Give that value to the Worker as
   `JOY_MEDIA_REAL_ESRGAN_MODEL_SHA256`. The Worker refuses the model when the pin is missing or the file differs
   (`apps/worker/src/local-upscaling.ts`, covered by `local-upscaling.test.ts`). Engineering confirms the model path in the Worker
   configuration before the session.
4. **Candidate.** Record the candidate commit and the SHA-256 of the exact `joy-media.exe` under test:

```powershell
Get-FileHash "<path to joy-media.exe>" -Algorithm SHA256
```

## Session steps

Type every secret into the app window yourself. Never paste one into chat, a file or a command.

| Step | What you do                                                                                                                                                                          | Step id for the receipt                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1    | Start with a fresh profile. Sign in with the test account.                                                                                                                           | `sign-in`                                                        |
| 2    | Read the signed-in state and the entitlement label on screen. Write down those two words only.                                                                                       | none (record it in the step 1 note)                              |
| 3    | Restart the app. It must still be signed in.                                                                                                                                         | `restart-keeps-session`                                          |
| 4    | Refresh the entitlement.                                                                                                                                                             | `entitlement-refreshed`                                          |
| 5    | Turn Wi-Fi off briefly. The offline messages must appear, and nothing may crash. Turn Wi-Fi back on.                                                                                 | `offline-boundary-visible`                                       |
| 6    | Sign out. Two checks: the stored credential is removed, and an authenticated call with the pre-sign-out token returns 401. Blocked until blocker 2 is fixed.                         | `sign-out-clears-credential` and `token-rejected-after-sign-out` |
| 7    | Run one upscale job with the licensed model, and judge the output against the registered threshold. Blocked until blocker 1 is fixed. Record the margin as the step's `measurement`. | `upscale-quality`                                                |

Record each step as `pass` or `fail`. A failed step stays in the record. Do not drop it.

## Leak scan (you, after the session)

```bash
node tooling/attended/src/leak-scan.mjs --root <profile logs folder> --root <evidence folder> --literals <literal file outside the repository> > leak-scan.json
```

The scan prints only counts and fingerprints. Any non-zero count stops the receipt. Stop, tell engineering, and do not send the
logs.

## Receipt (you)

Write the steps as a JSON array, one entry per step above. Each entry has `id`, `result` (`pass` or `fail`), and optionally
`measurement` and `unit`:

```json
[
  { "id": "sign-in", "result": "pass" },
  { "id": "upscale-quality", "result": "pass", "measurement": 0.031, "unit": "ssim-margin" }
]
```

Then write the receipt:

```bash
node tooling/attended/src/write-receipt.mjs --session A1 --candidate-sha <40-character commit> --exe <path to joy-media.exe> --thresholds docs/qa/attended/model-thresholds.json --started <UTC time> --finished <UTC time> --steps <steps.json> --leak-scan <leak-scan.json> --out <file outside the repository>
```

The receipt refuses while a threshold is null, while a required step is missing, and while the leak scan has a hit. In those cases
it writes nothing. A failed step is kept, and the verdict becomes `not-accepted`.

## Results (send to engineering with the receipt)

| Step                              | Result | Note    |
| --------------------------------- | ------ | ------- |
| 1 `sign-in`                       |        |         |
| 3 `restart-keeps-session`         |        |         |
| 4 `entitlement-refreshed`         |        |         |
| 5 `offline-boundary-visible`      |        |         |
| 6 `sign-out-clears-credential`    |        |         |
| 6 `token-rejected-after-sign-out` |        |         |
| 7 `upscale-quality`               |        | margin: |
| Leak scan hits                    |        |         |
| Verdict in the receipt            |        |         |
