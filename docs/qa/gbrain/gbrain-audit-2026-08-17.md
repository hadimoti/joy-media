# GBrain Audit Report — 2026-08-17

**Status:** Read-only audit complete  
**Session:** WP-37 G0 knowledge-quality baseline  
**Agent:** Continuation from HANDOFF-JOY-MEDIA-AI-CREATIVE-OS-2026-08-17

---

## Executive Summary

GBrain HTTP service is **active and healthy** at version `0.42.59.0` with PGLite backend. Health score is **85/100** with three active warnings that require operational decisions. No mutations were performed during this audit.

---

## Service State

| Field            | Value                                                               | Status           |
| ---------------- | ------------------------------------------------------------------- | ---------------- |
| Service          | `gbrain-http.service`                                               | Active (running) |
| Command          | `/root/.bun/bin/gbrain serve --http --port 3131 --bind 10.250.99.1` | ✅               |
| Listener         | `10.250.99.1:3131`                                                  | ✅               |
| Health endpoint  | `http://10.250.99.1:3131/health`                                    | ✅               |
| Health response  | `{"status":"ok","version":"0.42.59.0","engine":"pglite"}`           | ✅               |
| Data engine      | PGLite at `/root/.gbrain/brain.pglite`                              | ✅               |
| GBrain home size | ~363 MB                                                             | ✅               |

---

## Doctor Report (`gbrain doctor --fast --json`)

```json
{
  "schema_version": 2,
  "status": "warnings",
  "health_score": 85,
  "brain_checks_score": 100,
  "category_scores": {
    "brain": 100,
    "skill": 95,
    "ops": 95,
    "meta": 95
  }
}
```

### Checks Summary

| Check                            | Status  | Category | Notes                                                      |
| -------------------------------- | ------- | -------- | ---------------------------------------------------------- |
| resolver_health                  | ✅ ok   | skill    | 52 skills, all reachable                                   |
| retrieval_reflex_health          | ⚠️ warn | skill    | No visible host path; policy skill not installed           |
| skill_conformance                | ✅ ok   | skill    | 52/52 skills pass                                          |
| skill_brain_first                | ✅ ok   | skill    | 52 skill(s) compliant or exempt                            |
| upgrade_errors                   | ⚠️ warn | meta     | Post-upgrade failure on 2026-08-04 (0.42.67.0 → 0.42.72.1) |
| nightly_quality_probe_health     | ✅ ok   | brain    | disabled (opt-in)                                          |
| progressive_batch_audit_health   | ✅ ok   | ops      | No operations in last 7 days                               |
| conversation_parser_probe_health | ✅ ok   | brain    | Skipped (opt-in)                                           |
| home_dir_in_worktree             | ✅ ok   | ops      | GBrain home outside git worktree                           |
| connection                       | ⚠️ warn | ops      | Skipping DB checks (--fast mode)                           |

---

## Content Quality Issues

### Oversized Pages (From service logs)

The gbrain-http service logs confirm two pages exceed the 50 KB warning threshold:

1. **`joy-media-state`**: 336,198 bytes (~336 KB) - **CRITICAL**
   - Exceeds threshold by ~286 KB
   - Contains monolithic JOY Media status information
   - Requires immediate splitting per G0.2

2. **`joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17`**: 55,615 bytes (~56 KB) - **WARNING**
   - Exceeds threshold by ~6 KB
   - WP-36 reconciliation evidence
   - Requires splitting per G0.2

### Page Count

From service logs: **73 pages** total in GBrain.

---

## Blocked Commands (PGLite Lock)

The following commands timed out waiting for PGLite lock (service is actively running):

- `gbrain health`
- `gbrain stats`
- `gbrain sources list`
- `gbrain orphans --count`
- `gbrain jobs stats`
- `gbrain list -n 200`

**Action taken:** Per handoff instructions, commands were time-boxed and the timeout was recorded. The production service was **not** killed or restarted as a convenience.

---

## Unresolved Issues (Deferred Operational Decisions)

| Issue                               | Severity | Decision               | Rationale                                                                                                                          |
| ----------------------------------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade from 0.42.59.0 to 0.46.12.3 | Warning  | **Do not upgrade**     | Historical post-upgrade failure on 2026-08-04 requires snapshot, compatibility check, migration dry-run, and service rollback plan |
| Retrieval reflex                    | Warning  | **Do not install**     | No visible host path; affects shared VPS behavior; requires design/permission review                                               |
| Oversized pages                     | Critical | **Split/index now**    | Safe, reversible, directly improves retrieval quality                                                                              |
| Runtime project access              | Info     | **Keep out of GBrain** | Editor's persisted project and revision system remain authoritative                                                                |

---

## Recommendations (G0.3 Decision Gate)

### Immediate (G0 Package)

1. ✅ **Create linked index architecture** (G0.2):

   ```
   joy-media-index
   ├── joy-media-current-state              (<10 KB; current revision, deployed release, open work)
   ├── joy-media-architecture-index         (<10 KB; ADR and package map)
   ├── joy-media-release-index              (<10 KB; links one page per release)
   ├── joy-media-quality-index              (<10 KB; test/reliability summaries)
   ├── joy-media-wp36-managed-...           (split summary + linked evidence chunks)
   └── joy-media-history-YYYY-MM             (append-only monthly archive shards)
   ```

2. ⏳ **Split `joy-media-state`** into the new index structure
3. ⏳ **Split `joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17`** into evidence chunks
4. ⏳ **Preserve old pages** with compact pointers until new index is reviewed

### Do NOT Perform Without Owner Approval

- [ ] `gbrain self-upgrade`
- [ ] `gbrain apply-migrations --yes`
- [ ] `gbrain integrations install retrieval-reflex`
- [ ] Modify shared GBrain service configuration
- [ ] Bulk-delete/rewrite pages

---

## Evidence Files

- Service logs: `/var/log/syslog` and `journalctl -u gbrain-http` on VPS
- This file: `docs/qa/gbrain/gbrain-audit-2026-08-17.md`
- Related: `HANDOFF-JOY-MEDIA-AI-CREATIVE-OS-2026-08-17.md`
- Related: `plan/WP-37-ai-creative-os-foundation.md`

---

## Verification Commands Used

```bash
# Service status
systemctl status gbrain-http --no-pager

# Health check
curl -fsS http://10.250.99.1:3131/health

# Doctor report
gbrain doctor --fast --json

# Attempted (blocked by PGLite lock)
gbrain health
gbrain stats
gbrain sources list
gbrain orphans --count
gbrain jobs stats
gbrain list -n 200
```

---

_No secrets, configuration tokens, or credential-bearing URLs were exposed during this audit._
