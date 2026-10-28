# ADR-0043: Local-only, free, no accounts, no signed updates

Status: accepted
Date: 2026-10-28
Supersedes: ADR-0013, ADR-0016, ADR-0017 (independent media login)

## Context

On 2026-10-28 the owner decided that JOY Media becomes a free, open-source, local app. Premium, payments, user login and the
JOY Media server are removed. The landing site and the downloads move to joyst.ir. The decisions below are the owner's answers
recorded in the v1.1.0 plan (PLAN-v4, sections 0b and 12). This ADR records them. It does not repeat the plan's removal lists.

## Decision

1. **Free and local.** The app has no payments, entitlements or checkout. It runs offline and needs no account (decision Free).
2. **No accounts.** There is no sign-in, no shared JOY identity and no JOY Media login. ADR-0013, ADR-0016 and ADR-0017
   (independent media login) are superseded. Google is reached with a Gemini API key only, and Antigravity sign-in is not used.
3. **Provider credentials belong to the user.** The desktop app keeps each secret with Windows DPAPI through safeStorage. Worker
   jobs get provider credentials only through the main-process broker (D10). OpenRouter and ChatGPT use OAuth (D2). Grok, MiniMax
   and Kimi use API keys, and Kimi and MiniMax offer a region choice (S5). Kilo is removed from the app, the engine, the SDK, the
   CLI and the admin residue (I1).
4. **Local models.** Loopback endpoints (127.0.0.1 or localhost) are allowed, with a warning for each URL and no key (D8). IPv6
   loopback is refused (S4).
5. **Standalone CLI storage (placeholder).** The CLI's keys move into a store protected with Windows DPAPI (CurrentUser) if the P4
   spike passes. If the spike fails, the documented limit stays: an ACL-restricted file. The shipped option is recorded here when
   P4 decides it (D10).
6. **Updates are a download page only (D3 = B).** There are no signed updates, no update check and no public-key pin. The
   release-trust documents are archived (S6). `rollback` is kept, because it is local. Users check the SHA-256 by hand.
7. **Hosting.** joyst.ir and the downloads are served from Cloudflare Pages, with GitHub release assets (D1). The VPS is not shut
   down before v1.1.0 is released (S1), and the DNS moves no earlier than that release (S2).
8. **Server.** The JOY Media server code is deleted after the local control plane moves to a dev-only fixture (D5). The JOY Media
   gateway is removed from joy-vps only (D6).

## Open proposals (not confirmed)

- **S8**: public HTTPS custom endpoints per profile. Needed before the P2 merge.
- **S9**: rerun the acceptance session on the exact v1.1.0 candidate. Needed before the PR phase.
- **S11**: shared provider credentials other than the Telegram token are not revoked. Only JOY Media's reference is removed.
  Needed before P8 B3.
- **S10** is withdrawn (OA1). It was an alternative GPU threshold set.

## Release trust: pin lookup

On 2026-10-28 a read-only search of all pull requests (titles, branch names and bodies) found no pin, release-key or signing pull
request, and no pull request is open. The pin work is recorded as cancelled. Nothing was closed.

## Consequences

- The app is local-first. It has no telemetry, no server and no update UI (PLAN-v4, section 6f).
- The GPU track (v1.0.3) is separate from this decision, and this decision does not change it (PLAN-v4, section 10).
- The plan's references to ADR-0019 for this decision are read as ADR-0043. The owner chose this number on 2026-10-28, because
  ADR-0019 was already taken on main.
