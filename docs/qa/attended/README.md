# Attended qualification sessions

These sessions need the owner at the keyboard, and they are not CI. They run on the frozen candidate after the fast
CI run passes. A defect found there means a fix, a new commit, a new run, and the affected steps run again.

Thresholds come from [model-thresholds.json](model-thresholds.json). The owner registers the null values before the
session. A receipt is refused while any value it needs is still null.

## Rules for every session

- Secrets are typed by the owner into the app window, never by the agent. The agent never drives credential fields.
- Literals for the leak scan are kept in a file outside the repository, one per line. Run
  `tooling/attended/src/leak-scan.mjs --root <folder> --literals <file>` over the profile logs and the evidence folder.
  Only counts and fingerprints are printed. A non-zero count stops the receipt.
- The receipt is built by `tooling/attended/src/receipt.mjs`. It binds the result to the candidate commit, the exe
  digest and the thresholds digest. It holds step results and counts only.
- Nothing from a session goes into the repository, CI logs or gbrain except the receipt.

## G1: GPU diagnosis (RTX 5070 Ti, owner PC)

1. Read-only inventory: `node --experimental-strip-types tooling/diagnostics/src/gpu-inventory.ts --out <file outside the repo>`.
   The inventory changes no setting, and it writes its output already redacted. The G1 steps, in order, are in
   [gpu-g1.md](../../release/owner-checklists/gpu-g1.md). The session runs from the kit that `build-g1-kit.ps1` builds.
2. Crash evidence from the default build: record the GPU process exit code, the faulting module and the fast-fail
   subcode. Diagnostics that change system state (WinDbg, a driver change, an exploit-protection override, a sandbox-off
   launch) need the owner's per-item approval, and each is reversed before the session ends.
3. Record each step as pass or fail in the receipt. A failed step is kept, never dropped.

## G2: default-path acceptance (RTX 5070 Ti, owner PC)

The steps are in [gpu-acceptance.md](../../release/owner-checklists/gpu-acceptance.md). The harness is
`tooling/diagnostics/run-default-export-repeat.ps1`. It is attended, and it never runs unattended.

1. Thirty default launches of the candidate, each followed by an export. GPU process exits are counted from the test side:
   a listener in `tests/desktop/gpu-acceptance.spec.ts` records every GPU child-process exit, and Windows Error Reporting is
   read as a cross-check. A crash that the listener did not see counts as an unexplained exit. The production build carries
   no part of this (OA3).
2. The encoder session count is sampled from `nvidia-smi` on every poll during each run. A non-numeric answer is a harness error,
   never a zero. Three consecutive harness errors end the loop. App failures never do.
3. Pass means 0 GPU process exits, 0 fallback relaunches, and at least one encoder session in every run, as the thresholds
   file states. A run with no measurement fails its step.
4. The export spec runs once after the thirty runs. Its result goes into the receipt as the `export-spec` step.

## A1: account and worker qualification (dedicated test account, no payment method)

1. Fresh profile, sign in with the test account typed by the owner.
2. Read the signed-in state and entitlement. Record only the redacted fields the qualification flag exposes.
3. Restart. The session must persist.
4. Refresh the entitlement.
5. Turn Wi-Fi off briefly. The offline-boundary messages must appear, and nothing may crash.
6. Sign out. The stored credential is removed, and an authenticated call made with the pre-sign-out token must return 401.
7. Run the leak scan. It must report zero.

Local model qualification (cli.worker, Worker upscale) follows the same receipt rules. Each model's SHA-256 is checked
before use, and its output is judged against the registered thresholds. Raw model output is not stored.
