# P05 Verification Report — 2026-07-21

**Tooling caveat:** I do not have a shell/`bash` tool in this session, so I **cannot run `git status`, `git diff`, or `npx vitest`**. Findings below are from direct reads of the source files in the working tree. A human or a shell-equipped session must run the test suite and the commit.

---

## 1. Files present in the working tree

All claimed files exist:

- `packages/provider-sdk/src/testing.ts` ✓
- `packages/provider-sdk/src/idempotency.test.ts` ✓ (114 lines, 6 tests in 2 describes)
- `packages/audio-core/src/analysis.ts` ✓
- `packages/audio-core/src/normalization.ts` ✓
- `packages/audio-core/src/normalization.test.ts` ✓ (8 tests)
- `packages/audio-core/src/processing.ts` + `processing.test.ts` ✓
- `packages/audio-core/src/effects.ts` + `effects.test.ts` ✓
- `packages/audio-core/src/offline.ts` + `offline.test.ts` ✓
- `packages/audio-core/src/analysis.test.ts` ✓
- `packages/adapter-tts/src/consent-tts.ts` + `consent-tts.test.ts` ✓ (10 tests)
- `packages/commands/src/audio-commands.test.ts` ✓

## 2. provider-sdk `testing.ts` — idempotency key (audit exit #3)

**Status: appears fixed.**

`createMockProvider.invoke` (testing.ts:44-63) now has the signature

```ts
invoke: async (
  _capability: CapabilityId,
  _input: unknown,
  request?: CapabilityRequest,
): Promise<CapabilityResult>
```

and writes ``idempotencyKey: request?.idempotencyKey ?? \`mock-key-${testCounter}\`` into the provenance (line 58). The tests at `idempotency.test.ts:20-24` pass the request as the third argument and assert that the key round-trips through `provenance.idempotencyKey`.

The same fix is mirrored in `simulateProviderFailure` for the `invalid-output` branch (testing.ts:161-194). The earlier audit complaint that `invoke(capability,input)` had no idempotency-key param is no longer accurate against this tree.

## 3. audio-core `analysis.ts` — LUFS calculation (audit exit #4)

**Status: appears fixed.**

`measureLoudness` (analysis.ts:53-106) no longer applies a buggy K-weighting pre-filter. The current implementation is a gated-RMS estimate:

```ts
const loudness = -0.691 + 10 * Math.log10(meanSquare + 1e-10);
```

with an absolute gate at -70 LUFS. A header comment at analysis.ts:54-58 explains the change: _"the previous second-order high-shelf implementation produced huge resonant gain and positive LUFS values for ordinary signals."_

Quick mental check (sine, fs=48 kHz):

- amplitude 0.3 → mean square 0.045 → ~ -14.2 LUFS (negative ✓)
- amplitude 0.5 → mean square 0.125 → ~ -9.7 LUFS (negative ✓)
- amplitude 0.9 → mean square 0.405 → ~ -4.6 LUFS (negative ✓)

`normalization.ts:25,56` calls `measureLoudness(...).integrated` directly, so `inputLoudness`/`outputLoudness` are now negative, and the `loudnessDiff = targetLoudness - inputLoudness` / `Math.pow(10, loudnessDiff/20)` math at lines 28-29 yields the right gain direction. The "handles quiet audio needing boost" test (`normalization.test.ts:108-121`) expects `gainAdjustment > 2.0` for amplitude 0.1 → -23 LUFS-ish input, and the "loud audio needing attenuation" test (lines 123-136) expects `gainAdjustment < 1.0` for amplitude 0.9 against -23 LKFS target — both consistent with the new implementation.

The gain on the loud case is ~10^((-23 - -4.6)/20) ≈ 10^-0.92 ≈ 0.12, which satisfies `< 1.0`. The quiet case (0.1 amp → ~-17.4 LUFS, target -16) gives ~10^((−16 − (−17.4))/20) ≈ 1.16 — **this is below the 2.0 threshold the test requires**. So the "handles quiet audio needing boost" test may still fail at the 0.1 amplitude. Worth re-verifying when the suite is run. If it fails, the fix is to either lower the threshold in the test or to tighten the loudness estimate's calibration constant (the "-0.691" offset is closer to dBTP than to LKFS for a pure sine).

## 4. adapter-tts `consent-tts.ts`

**Status: appears fixed in shape, but two tests rely on audit-trail details.**

`synthesizeWithConsent` (consent-tts.ts:33-89):

- short-circuits on no `voiceId` (no consent check, no audit entry) — matches "allows synthesis without voiceId" (consent-tts.test.ts:225-239)
- throws `VoiceConsentError('VOICE_NOT_FOUND', ...)` on missing voice — matches consent-tts.test.ts:156-179
- throws `VoiceConsentError('CONSENT_DENIED', ...)` when `canUseVoice` denies — matches consent-tts.test.ts:51-82 and 241-263
- records the audit entry **only** on a successful `invoke` (line 72) — matches "audit entries length 0" assertions in the denied / suspended / revoked / deleted / unauthorized cases

If the audit previously listed 2 fails here, the most likely cause then was the audit entry being recorded even on failure (or the success path being skipped on metadata attachment). Neither is present in the current code.

## 5. commands/audio-commands + audio-core effects/processing/offline

**Status: read-only spot-check; not exhaustively re-derived.**

- `processing.ts` (applyGain/applyPan/applyFade/applyCrossfade/mixBuses) — sign/pan-law math is consistent with the tests.
- `effects.ts` (applyCompressor/applyLimiter/applyGate/applyEq + biquad) — RBJ cookbook coefficients, standard envelope followers. The "peaking boost > 1" test, the limiter ceiling test, and the gate threshold tests all line up with the implementation.
- `offline.ts` (renderOfflineAudio) — placement math is consistent; measurements block uses the now-LUFS-correct `measureLoudness`.
- `commands/src/audio-commands.test.ts` — not opened in this pass; would need a direct read to certify.

## 6. What still needs to happen (cannot be done without a shell)

1. **`git status` / `git diff --stat`** to enumerate the 32 uncommitted files the audit flagged.
2. **`npx vitest run packages/provider-sdk packages/audio-core packages/adapter-tts packages/commands`** — the actual pass/fail signal. Treat my fixes-appear-correct above as a _prior_, not as proof.
3. **Pay particular attention to `normalization.test.ts` "handles quiet audio needing boost"** (gain > 2.0 at amplitude 0.1, target -16). My arithmetic suggests it may still be tight. If it fails, either retune the -0.691 dB offset in `measureLoudness` to be more sensitive at low levels, or adjust the test's threshold.
4. **Full root test** to catch unrelated regressions in the other 4 failing test files mentioned by the audit (analysis/effects/offline/processing, commands/audio-commands).
5. **Commit** — something like:
   ```
   git add packages/provider-sdk packages/audio-core packages/adapter-tts packages/commands
   git commit -m "fix(audio,provider): correct LUFS units and idempotency-key plumbing (P05 unblock)

   - provider-sdk/testing.ts: createMockProvider.invoke now accepts
     CapabilityRequest and round-trips request.idempotencyKey into
     provenance.idempotencyKey (fixes idempotency.test.ts exit #3).
   - audio-core/analysis.ts: measureLoudness replaced the buggy K-weighting
     pre-filter with a gated RMS-block estimate that returns negative LUFS,
     so normalizeDialogue's gain math now points the right way (fixes
     normalization.test.ts exit #4).
   - adapter-tts/consent-tts.ts: audit entries recorded only on successful
     invocation, VoiceConsentError codes match the test expectations
     (fixes consent-tts.test.ts exit #5).
   - 32 uncommitted P05-era working-tree files captured."
   ```

## Bottom line

- The two specific bugs the audit named — `testing.ts` idempotency-key plumbing and `analysis.ts` LUFS units — are **no longer present in the working tree as of this read**.
- `consent-tts.ts` matches the test contract as written.
- I cannot independently confirm test pass/fail or commit anything from this session. The user (or a shell-equipped agent) must run `npx vitest` and `git commit` to close the P05 block.
