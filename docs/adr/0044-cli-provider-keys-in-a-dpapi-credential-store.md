# ADR-0044: CLI provider keys in a Windows DPAPI credential store

Status: accepted
Date: 2026-10-29
Supersedes: none. It extends the local-only decision in [ADR-0043](./0043-local-only-free-no-accounts-no-signed-updates.md).

## Context

The CLI kept provider API keys in plaintext inside `ai-providers.json`. The desktop app already keeps
keys out of its profile records and protects them through the operating system. The CLI needs the same
protection without a native addon, so it stays a plain Node package.

## Decisions

- Keys live in `credentials.json`, beside the provider file. The file holds a format version, the name
  of the protector that wrote it, and one ciphertext per provider name. The provider file keeps the
  metadata only: base URL, default model and the rest.
- On Windows the protector is DPAPI in the CurrentUser scope, called through PowerShell's
  `System.Security` `ProtectedData` class. The secret goes in on standard input and never on the
  command line. A spike on 2026-10-29 measured about 230 ms per call.
- On other systems the protector is `restricted-file`. It stores the bytes as they are, and the file is
  written with mode 0600. The values are not encrypted, and the store does not claim otherwise.
- Writes are atomic: the store writes a temporary file and renames it. After each write it reads the
  entry back, and refuses the write if the bytes differ.
- A file with a newer version than this build is refused, and left unchanged. So is a file written by a
  different protector. The store never guesses which one applies.
- The first start moves each plaintext key from `ai-providers.json` into the store. A key that cannot be
  protected stays in the plaintext file. The legacy `kilo` and `joy-hosted` profiles are never moved;
  they stay listed as disabled (PLAN-v4 §9a).

## Consequences

- On Windows, a key can be read only by the Windows user who stored it, on that PC. A copy of the store
  on another PC, or under another user, cannot be read. The CLI then treats that key as missing.
- Each key read or write starts one PowerShell process on Windows.
- The store reads files by path, not through a native handle. A link or a cloud placeholder created
  between a check and a read is not detected. `joy-media doctor-local` says so.

## Alternatives considered

- A native keychain addon: rejected, because it adds a native build step to the CLI package.
- Electron `safeStorage` from the CLI: not available outside an Electron process.
- Keeping plaintext with a warning: rejected. It is the state this ADR removes.

## Verification

- `apps/cli/src/utils/credential-store.test.ts` (9 tests): an encrypted round trip; a read-back refusal;
  a newer version refused with the file unchanged; a protector mismatch; migration that moves keys and
  keeps legacy profiles disabled; an interrupted migration that completes on the next start; an
  idempotent second run; a protector failure that keeps the plaintext; and, on Windows, a DPAPI round
  trip that never writes the secret in clear.
