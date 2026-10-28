# ADR-0043: Local-only, free, no accounts, no signed updates

Status: accepted
Date: 2026-10-28
Supersedes: ADR-0013, ADR-0016, and [ADR-0017 (independent media login)](./0017-independent-media-login.md)

## Context

On 2026-10-28 the owner decided that JOY Media becomes a free, open-source, local app. Premium, payments, user login and the
JOY Media server are removed. The landing site and the downloads move to joyst.ir. The decisions below are the owner's answers,
recorded in the v1.1.0 planning notes (PLAN-v4, sections 0b and 12). Those notes are kept outside this repository. This ADR
records the decisions. It does not repeat the plan's removal lists.

## Decision

1. **Free and local.** The app has no payments, entitlements or checkout. It runs offline and needs no account (decision Free).
2. **No accounts.** There is no sign-in, no shared JOY identity and no JOY Media login. [ADR-0013](./0013-marketplace-commercial-boundary.md),
   [ADR-0016](./0016-shared-joy-identity-boundary.md) and [ADR-0017 (independent media login)](./0017-independent-media-login.md)
   are superseded. Google is reached with a Gemini API key only: no Antigravity sign-in and no Gemini OAuth.
3. **Provider credentials belong to the user.** The desktop app keeps each secret with Windows DPAPI through safeStorage. Provider
   credentials go through the main-process broker (D10), and Workers hold none. OpenRouter and ChatGPT use OAuth (D2). Grok,
   MiniMax and Kimi use API keys, and Kimi and MiniMax offer a region choice (S5). Kilo is removed from the app, the engine, the
   SDK, the CLI, the admin panel and joy-vps residue (I1). Kilo in the code-server workspace is not touched.
4. **Local models.** Loopback endpoints (127.0.0.1 or localhost) are allowed, with a warning for each URL and no key (D8). IPv6
   loopback is refused (S4).
5. **Standalone CLI storage (placeholder).** The CLI's keys move into a store protected with Windows DPAPI (CurrentUser) if the P4
   spike passes. If the spike fails, the documented limit stays: an ACL-restricted file. The shipped option is recorded here when
   P4 decides it (D10).
6. **Updates are a download page only (D3 = B).** There are no signed updates, no update check and no public-key pin. The
   release-trust documents are archived (S6). `rollback` is kept, because it is local. Users check the SHA-256 by hand.
7. **Hosting.** joyst.ir and the downloads are served from Cloudflare Pages, with GitHub release assets (D1). The VPS is not shut
   down before v1.1.0 is released (S1), and the DNS moves no earlier than that release (S2).
8. **Server.** The JOY Media server code is deleted after the local control plane moves to a dev-only fixture (D5). In joy-vps,
   the Kilo and OpenRouter removal covers the JOY Media gateway only (D6).
9. **Other decisions of the same date**, recorded in the planning notes:
   - D4: v1.1.0 is the release vehicle. v1.0.3 keeps its scope minus account session A1.
   - D7: the `media.joyteam.ir` redirect stays for 90 days, and is then removed (follow-up D7-F).
   - D11: VPS data is deleted without export, behind three gates. D12: there are no subscribers and no members, confirmed by a
     read-only count before shutdown. D13: the user chooses whether to convert or delete Kilo and joy-hosted profiles. D14: only
     `X-Title: JOY Media` is sent. D15: there is no AI video generation in v1.1.0.
   - S3: the owner turns off new checkout on the live server before v1.0.3 ships.
   - S7: a Telegram bot token is revoked only if it is dedicated to JOY Media. A shared token is never revoked under this plan.
   - The GPU answers OA1 to OA4 are recorded in the planning notes (section 12e). This ADR does not restate them.

## Open proposals (not confirmed)

- **S8**: public HTTPS custom endpoints per profile, with consent. Needed before the P2 merge. If S8 is not confirmed by then,
  public custom endpoints are refused, and converted Kilo profiles stay disabled (kept, not deleted).
- **S9**: rerun the acceptance session on the exact v1.1.0 candidate. Needed before the PR phase.
- **S11**: shared provider credentials other than the Telegram token (see S7) are not revoked. Only JOY Media's reference is
  removed. Needed before P8 B3.
- **S10** is withdrawn (OA1). It was an alternative GPU threshold set.

## Release trust: pin lookup

On 2026-10-28 the read-only lookup in PLAN-v4 section 8d ran with `gh`, and both commands exited 0.

- `gh pr list --state all --limit 500` listed 13 pull requests. Their titles and branch names, filtered for pin, release-key,
  release-trust, ceremony, signing and signed, matched one: #12 (merged). The match is the substring "pin" inside "housekeeping" in
  its branch name, and its title concerns the v1.0.2 release record.
- `gh pr list --search "release-key in:body"` returned four pull requests, all merged: #2, #3, #7 and #12. None of them is a pin
  change.

No open pull request matched, so none was closed. The pin work is recorded as cancelled.

## Consequences

- The app is local-first. It has no telemetry, no server and no update UI (PLAN-v4, section 6f).
- This decision removes account session A1 from v1.0.3 (D4). It does not change the GPU track (PLAN-v4, section 10).
- The planning notes refer to ADR-0019 for this decision. Read them as ADR-0043. The owner chose this number on 2026-10-28,
  because ADR-0019 is already taken on main.
