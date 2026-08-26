# JOY Media Worker Companion (Windows)

This is a deliberately thin Electron shell around the existing `apps/worker` daemon. It displays local lifecycle state, the owner-approval pairing code, recent redacted Worker output, and explicit start/stop/restart controls. It does not contain creative or render logic, does not connect to Sweden directly, and never stores a JOY login or Worker session token in its own configuration. The existing Worker state file remains Worker-owned.

## Development

From the repository root:

```powershell
pnpm install
pnpm --filter @joy-media/desktop build
pnpm --filter @joy-media/desktop dev
```

Enter the versioned API URL and, on Windows, absolute paths to both `ffmpeg.exe` and `ffprobe.exe` in the local configuration panel. Both tools must be executable; the companion refuses to start the Worker if either is missing. The Worker uses the existing pairing flow and prints a code until the signed-in owner approves it.

## Windows package

```powershell
pnpm --filter @joy-media/desktop package:win
```

`prepare-runtime` builds the existing Worker dependency graph and bundles it into `.runtime/worker.js`. Electron Builder then puts that file in the NSIS installer as an extra resource. At runtime the companion starts the packaged Worker with the packaged Electron executable and `ELECTRON_RUN_AS_NODE=1`; users do not need a separately installed system Node.js. `.runtime` and `dist-installer` are generated and should not be committed.

## Release signing (owner-only)

Unsigned packages are for local testing only. Before distributing an installer, the release owner must provide a code-signing certificate through the build machine's protected certificate store or an ephemeral CI secret and run:

```powershell
pnpm desktop:package:signed
```

The signing script invokes `signtool.exe` and then verifies the resulting installer with `Get-AuthenticodeSignature`. It fails closed when `signtool.exe`, the owner-provided certificate selection, or a valid `Status` is absent. Do not commit certificates, passwords, PFX files, certificate paths containing secrets, or signing environment values. A build without those owner-supplied prerequisites must remain unsigned and must not be called a release.
