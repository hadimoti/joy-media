# JOY Media desktop shell

This package is the dependency-free desktop host contract for JOY Media. It deliberately does not contain editor, timeline, rendering, or agent logic: those remain in `apps/editor-web` and shared packages.

## Boundaries

- **Editor origin:** only the configured JOY production origin and explicit loopback development origins may request the bridge. Unknown origins are rejected before IPC dispatch.
- **IPC:** only the versioned channels in `src/ipc.ts` are exposed. Requests carry opaque IDs and structured data; there is no arbitrary command, shell, or path channel.
- **Files:** native selection is represented by an opaque `local-file` reference. The raw path never crosses the renderer boundary. Derivatives must be explicitly requested by reference and kind.
- **Deep links:** only `joy://open/project/<UUID>` is accepted. Credentials, arbitrary hosts, and arbitrary paths are rejected.
- **Worker:** the shell reports lifecycle/status and startup preference only. The Worker remains the owner of probing, hashing, and derivative generation; project mutation stays in the editor command path.

The current repository does not declare Tauri, Electron, WebView2, or a signing toolchain. Therefore this milestone ships a host-neutral contract and a deterministic unsigned development package manifest. It is not a production installer and no signing claim is made.

## Commands

```text
pnpm --filter @joy-media/desktop test
pnpm --filter @joy-media/desktop build
pnpm desktop:package
```

`desktop:package` creates `apps/desktop/dist/joy-media-desktop-dev.json`, a deterministic package manifest containing the shell contract version, runtime requirements, and explicit `signing: blocked` metadata. A signed Windows installer requires a future owner-approved native runtime and certificate/tooling.
