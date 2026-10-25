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
   The inventory changes no setting. Its output passes the redactor before it is kept.
2. Crash evidence from the default build: record the GPU process exit code, the faulting module and the fast-fail
   subcode. Diagnostics that change system state (WinDbg, a driver change, an exploit-protection override, a sandbox-off
   launch) need the owner's per-item approval, and each is reversed before the session ends.
3. Record each step as pass or fail in the receipt. A failed step is kept, never dropped.

## G2: default-path acceptance (RTX 5070 Ti, owner PC)

1. Thirty default launches of the candidate, each followed by a short export. Record the GPU process exits, the fallback
   relaunches, and the encoder session count during each export (from `nvidia-smi`).
2. Pass means 0 GPU process exits, 0 fallback relaunches, and at least one encoder session during export, as the
   thresholds file states.
3. The export spec runs once on the same build. Its result goes into the receipt as a step.

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
