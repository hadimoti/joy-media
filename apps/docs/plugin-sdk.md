# JOY Plugin SDK v1

Build one of the three supported v1 extension shapes: a sandboxed panel, a data-only caption pack, or a Worker provider adapter. Start with:

```text
joy-plugin init ./my-plugin com.example.my-panel "My Panel" "Example Studio"
```

Declare only the permissions you need in `plugin.json`. The local permission simulator and fixture runner show whether an entrypoint would run; safe mode always blocks third-party code. Packages must pass the SDK manifest validator, immutable SHA-256 package hash, and a trusted Ed25519 signature before installation.
