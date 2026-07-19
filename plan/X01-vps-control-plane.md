# X01 — Live VPS Control Plane (deployment part)

**Status:** not-started (skeleton dir exists on VPS) · **Activates with:** P01 (WP-01.5 produces the deployable) · **Master plan:** §27, §28, §35, §2.11
**Scope rule:** this is the ONLY part allowed to touch the live VPS. Every other part builds and tests locally.

## Measured baseline (2026-07-19, `ssh sweden`)

| Fact                       | Value                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU                        | QEMU Virtual CPU 2.5+ — `avx avx2 sse4_2 ssse3` **present** (plan §27.2 corrected in v1.1; model is provider-controlled, re-check after host migrations) |
| RAM                        | 8 GB total, ~4.6 GB available (Synapse, joy-vps bot, admin, matrix, wg services share it)                                                                |
| Disk                       | 99 GB, ~43 GB free                                                                                                                                       |
| Node                       | v22.23.1                                                                                                                                                 |
| PostgreSQL / Redis         | **not installed**                                                                                                                                        |
| Docker                     | containerd present                                                                                                                                       |
| Ports in use               | 22, 53, 80, 443, 5355, 8008, 8080–8083, 8766–8767, 9090, 9222, 10001–10005, 19825                                                                        |
| **Reserved for JOY Media** | **8790** API+WS · **8791** object gateway (optional). Re-verify free before first bind.                                                                  |
| Skeleton                   | `/opt/joy-media/` created 2026-07-19 — contains this plan; nothing runs                                                                                  |

Resource budget (DECIDED Q2, ADR-0001): **≤3 GB RAM, ≤2 CPU cores** — set as systemd `MemoryMax=3G` / `CPUQuota=200%` and kept adjustable; owner re-evaluates (VPS upgrade vs stay) after real usage. Disk working default ~10 GB. No GPU/model/render workloads ever (§2.11).

## Isolation contract (§27.3 — every WP below must respect it)

Own service unit + user (`joy-media`) · own PostgreSQL cluster/database · own secrets file · own storage path (`/opt/joy-media/`) · own subdomain (suggest `media.joyteam.ir`, owner confirms) · shared ONLY: nginx reverse proxy + the shared JOY identity boundary (DECIDED Q10: existing JOY login, no second sign-in, separate application page, access **off by default** and granted per-user through the admin panel via a `joymedia_allowed`-style flag). Independent rollback; migrations can never block other JOY services; logs separated; health checks honest about dependencies.

## Work packages

- [ ] **WP-X1.1 — Ground preparation.** Install PostgreSQL (from PGDG apt, pinned major version); create `joymedia` DB + role; create `joy-media` system user; directory layout under `/opt/joy-media/{app,data,secrets,logs}`; systemd unit template (disabled); **CPU-feature + dependency health-check script** that reports required-vs-available before any native component starts (§27.2). Nothing public yet.
- [ ] **WP-X1.2 — First deploy.** Deploy WP-01.5 API build; nginx server block for the chosen subdomain with TLS; port 8790 bound to loopback, proxied; rate limits; readiness/health endpoints; smoke test; documented rollback (previous release dir + symlink flip).
- [ ] **WP-X1.3 — Backups + monitoring.** `pg_dump` schedule wired into the existing Parspack rclone off-site flow (`parspack:c890934/sweden-backups/`); restore drill documented and executed once; disk/RAM/port watchdog; log rotation; §30.6 metric baselines.
- [ ] **WP-X1.4 — Object storage.** Start with local volume under `/opt/joy-media/data/objects` + quotas (§8.3); evaluate S3-compatible storage only when size demands it. Per DECIDED Q4: local-first with **optional** user-opted cloud storage/sync of media — the VPS may hold opted-in media within Q2 quotas, but nothing is uploaded by default and heavy files are expected to stay local early on.

## Exit criteria

- [ ] API reachable over TLS on its subdomain; all other joy-vps services unaffected (port/RAM/disk checks before+after).
- [ ] Health check reports CPU features, DB connectivity, disk headroom.
- [ ] Backup runs on schedule AND a restore drill succeeded.
- [ ] Rollback procedure tested once for real.
- [ ] Everything here reproducible from this file — no snowflake state on the VPS.
