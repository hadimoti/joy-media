# GBrain Index/Current-State Split Plan — G0.2

**Status:** Plan ready for owner review  
**Session:** WP-37 G0 knowledge-quality remediation  
**Date:** 2026-08-17  

---

## Purpose

This document describes the **reversible, linked information architecture** to replace the monolithic `joy-media-state` page and split the oversized `joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17` page, per WP-37 G0.2 requirements.

**Goal:** Every current JOY Media fact becomes retrievable from small index/current-state pages, all under 50 KB, linked, and tagged.

---

## Current State (Problems to Solve)

### Problem 1: Monolithic `joy-media-state` (336 KB)
- Contains: Current revision, deployed release, open work, historical notes, command logs
- Size: 336,198 bytes (6.7x over 50 KB threshold)
- Impact: GBrain content-sanity warns on every write; retrieval quality degraded

### Problem 2: Oversized WP-36 page (56 KB)
- Page: `joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17`
- Size: 55,615 bytes (1.1x over threshold)
- Impact: GBrain content-sanity warns; contains full command logs and screenshots

### Problem 3: No index structure
- No central index page linking all JOY Media knowledge
- Facts scattered across multiple pages with duplication
- No clear current-state vs historical separation

---

## Proposed Architecture

```
joy-media-index                                    [NEW - Index]
├── joy-media-current-state              (<10 KB) [NEW - Current truth]
├── joy-media-architecture-index         (<10 KB) [NEW - ADR/package map]
├── joy-media-release-index              (<10 KB) [NEW - Links to releases]
├── joy-media-quality-index              (<10 KB) [NEW - Test summaries]
├── joy-media-wp36-summary              (<10 KB) [NEW - Split from oversized page]
│   ├── joy-media-wp36-evidence-...    (linked evidence chunks)
│   └── joy-media-wp36-commands-...    (linked command logs)
├── joy-media-history-2026-08           (<10 KB) [NEW - Monthly archive]
│   ├── joy-media-wp35-...              (archived)
│   ├── joy-media-wp34-...              (archived)
│   └── ...
└── joy-media-state                    (DEPRECATED - pointer only)
```

---

## Detailed Page Specifications

### 1. `joy-media-index` (NEW)

**Purpose:** Master index linking all JOY Media GBrain pages  
**Size target:** <10 KB  
**Tags:** `joy-media`, `index`, `master`  

**Content structure:**
```markdown
# JOY Media GBrain Index

## Current State
- [joy-media-current-state] — Live project revision, deployed release, open work

## Architecture
- [joy-media-architecture-index] — ADR list, package map, dependency diagram

## Releases
- [joy-media-release-index] — All releases with source SHA, artifact paths

## Quality
- [joy-media-quality-index] — Test totals, regression status, coverage

## Historical
- [joy-media-history-2026-08] — August 2026 archive
- [joy-media-history-2026-07] — July 2026 archive

## Deprecated (Pointers Only)
- [joy-media-state] → See joy-media-current-state
- [joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17] → See joy-media-wp36-summary
```

**Links:** Typed links with `supersedes`, `related_to` relationships

---

### 2. `joy-media-current-state` (NEW)

**Purpose:** Current truth only — no journal, no history  
**Size target:** <10 KB  
**Tags:** `joy-media`, `current-state`, `live`  

**Content structure:**
```markdown
# JOY Media Current State — 2026-08-17

## Source
- Local checkout: 0287946
- VPS checkout: 0287946
- Branch: (current)

## Deployed Releases
- Editor: 733f584 at /opt/joy-media/web-releases/editor-web-20260816T233403Z-733f584-wp36-color-render-final
- API: wp35-final-api-20260816T200008Z-07ecbe1 at /opt/joy-media/releases/wp35-final-api-20260816T200008Z-07ecbe1

## Open Work
- WP-37: AI Creative OS Foundation (in progress)
  - G0: GBrain remediation (in progress)
  - S1: Semantic Project Snapshot (not started)

## Service Health
- API: active (running) on 127.0.0.1:8790
- GBrain: active (running) on 10.250.99.1:3131, version 0.42.59.0

## Links
- supersedes: joy-media-state
- related_to: joy-media-release-index
- related_to: joy-media-wp37-ai-creative-os-foundation
```

**Rules followed:**
- Only current truth
- Links to evidence (not inline evidence)
- No raw logs, screenshots, or command output
- Size strictly bounded

---

### 3. `joy-media-architecture-index` (NEW)

**Purpose:** ADR and package ownership map  
**Size target:** <10 KB  
**Tags:** `joy-media`, `architecture`, `adr`, `packages`  

**Content structure:**
```markdown
# JOY Media Architecture Index

## ADRs
- ADR-0019: Project persistence
- ADR-0020: Command transactions
- ADR-0021: Agent host/provenance
- ADR-0022: Asset management
- ADR-0023: Universal Timeline
- ... (all relevant ADRs)

## Package Map
```
@joy-media/project-schema      — Innermost, canonical types
    @joy-media/commands        — Command validation, history
        @joy-media/timeline-engine — Viewport, placement
        @joy-media/agent-tools   — Agent plans, tools
    @joy-media/audio-core      — DSP, buses, FX
    @joy-media/render-ir       — Render intermediate representation
    @joy-media/renderer-pixi   — PixiJS renderer
    ...
```

## Links
- related_to: joy-media-current-state
```

---

### 4. `joy-media-release-index` (NEW)

**Purpose:** Links to one page per release (not entire logs)  
**Size target:** <10 KB  
**Tags:** `joy-media`, `releases`, `deployment`  

**Content structure:**
```markdown
# JOY Media Release Index

## Latest
- WP-36: 733f584 — Managed universal track deck + color labels
  - evidence: joy-media-wp36-summary
  - artifact: /opt/joy-media/web-releases/editor-web-20260816T233403Z-733f584-wp36-color-render-final

- WP-35: 5273e34 — Universal timeline + GPU preview
  - evidence: (link to WP-35 evidence)
  - artifact: /opt/joy-media/web-releases/editor-web-20260816T213059Z-1298c17-wp35-ruler-surface

- WP-34: 630c8ad — Universal animation + editor IA
  - artifact: /opt/joy-media/web-releases/editor-web-20260814T...

## Rollback Targets
- Previous stable: ffa9ea0 (WP-35 responsive)

## Links
- related_to: joy-media-current-state
```

**Rules followed:**
- One page per release
- Source SHA, artifact path, evidence link (not raw logs)
- Rollback reference included

---

### 5. `joy-media-quality-index` (NEW)

**Purpose:** Test/reliability summaries  
**Size target:** <10 KB  
**Tags:** `joy-media`, `quality`, `tests`  

**Content structure:**
```markdown
# JOY Media Quality Index

## Current Test Suite
- Total files: 336
- Total tests: 2,268 passed
- Skipped: 2
- Last run: 2026-08-17 (WP-36 deployment)

## Browser Tests
- Chrome desktop-primary: 5/5 cases passed
- Persian/RTL: Verified in WP-36

## Regression Status
- All WP-35 tests: passing
- All WP-36 tests: passing
- Known issues: (list any)

## Links
- related_to: joy-media-current-state
```

---

### 6. `joy-media-wp36-summary` (NEW)

**Purpose:** Split summary from oversized WP-36 page  
**Size target:** <10 KB  
**Tags:** `joy-media`, `wp36`, `summary`  

**Content structure:**
```markdown
# WP-36 — Managed Universal Track Deck + Color Labels — Summary

## Goal
Replace manual Add/Delete Track with adaptive two-family deck.

## Outcome
- Visual rows always above audio rows
- Runway rows always visible per family
- Stable empty rows (no Delete Track needed)
- Durable label colors
- 336 files, 2,268 tests passed

## Artifacts
- Source commit: 733f584
- Editor artifact: /opt/joy-media/web-releases/editor-web-20260816T233403Z-733f584-wp36-color-render-final

## Evidence Chunks (Linked)
- [joy-media-wp36-evidence-screenshots] — Browser verification screenshots
- [joy-media-wp36-evidence-logs] — Test logs and build output
- [joy-media-wp36-commands] — Command history (if needed separately)

## Links
- supersedes: joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17
- related_to: joy-media-release-index
```

**Rules followed:**
- Summary only (<10 KB)
- Large evidence in separate linked pages
- No raw command logs in summary

---

### 7. `joy-media-history-YYYY-MM` (NEW - Monthly)

**Purpose:** Append-only monthly archive shards  
**Size target:** <10 KB each (can have multiple per month if needed)  
**Tags:** `joy-media`, `history`, `YYYY-MM`  

**Content structure (example for 2026-08):**
```markdown
# JOY Media History — August 2026

## Completed
- WP-36: Managed universal track deck + color labels (2026-08-17)
- WP-35: Universal timeline + GPU preview (2026-08-16)
- WP-34: Universal animation + editor IA (2026-08-14)

## In Progress
- WP-37: AI Creative OS Foundation (started 2026-08-17)

## Links
- related_to: joy-media-current-state
```

---

### 8. Deprecated Pages (Pointer Only)

**`joy-media-state`** (EXISTING - to be replaced with pointer)

**Action:** Replace body with:
```markdown
# joy-media-state — DEPRECATED

This page has been superseded by the JOY Media index structure.

## Current State
See: [joy-media-current-state]

## All Pages
See: [joy-media-index]

---
*This page is preserved for historical links. All current information is in the indexed pages above.*
```

**Tags:** Add `deprecated`, `superseded-by-joy-media-current-state`

---

**`joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17`** (EXISTING - to be replaced with pointer)

**Action:** Replace body with:
```markdown
# WP-36 Evidence — DEPRECATED

This page has been split into smaller, linked pages.

## Summary
See: [joy-media-wp36-summary]

## Evidence
- Screenshots: [joy-media-wp36-evidence-screenshots]
- Logs: [joy-media-wp36-evidence-logs]

---
*This page is preserved for historical links. All current information is in the indexed pages above.*
```

**Tags:** Add `deprecated`, `superseded-by-joy-media-wp36-summary`

---

## Typed Links Matrix

| Source Page | Link Type | Target Page | Purpose |
| --- | --- | --- | --- |
| joy-media-index | `related_to` | joy-media-current-state | Current truth link |
| joy-media-index | `related_to` | joy-media-architecture-index | Architecture link |
| joy-media-index | `related_to` | joy-media-release-index | Releases link |
| joy-media-index | `related_to` | joy-media-quality-index | Quality link |
| joy-media-index | `related_to` | joy-media-history-2026-08 | History link |
| joy-media-current-state | `supersedes` | joy-media-state | Replacement |
| joy-media-current-state | `related_to` | joy-media-release-index | Release reference |
| joy-media-wp36-summary | `supersedes` | joy-media-wp36-managed... | Replacement |
| joy-media-wp36-summary | `related_to` | joy-media-wp36-evidence-screenshots | Evidence link |
| joy-media-wp36-summary | `related_to` | joy-media-wp36-evidence-logs | Evidence link |

---

## Implementation Steps

### Step 1: Create New Pages (Owner Review Required)
1. Create `joy-media-index`
2. Create `joy-media-current-state`
3. Create `joy-media-architecture-index`
4. Create `joy-media-release-index`
5. Create `joy-media-quality-index`
6. Create `joy-media-wp36-summary`
7. Create `joy-media-history-2026-08`

### Step 2: Extract Evidence (Owner Review Required)
1. Create `joy-media-wp36-evidence-screenshots` from `joy-media-wp36-managed...`
2. Create `joy-media-wp36-evidence-logs` from `joy-media-wp36-managed...`
3. Verify each evidence chunk is <50 KB

### Step 3: Deprecate Old Pages (Owner Approval Required)
1. Replace `joy-media-state` body with pointer to `joy-media-current-state`
2. Replace `joy-media-wp36-managed-universal-track-deck-color-labels-2026-08-17` body with pointer to `joy-media-wp36-summary`
3. Add deprecation tags

### Step 4: Verify
1. All current JOY Media facts retrievable from new index
2. All new pages <50 KB
3. All pages linked with typed relationships
4. Old pages recoverable via pointers

---

## Size Estimates

| Page | Estimated Size | Status |
| --- | --- | --- |
| joy-media-index | ~2 KB | ✅ Under target |
| joy-media-current-state | ~4 KB | ✅ Under target |
| joy-media-architecture-index | ~5 KB | ✅ Under target |
| joy-media-release-index | ~3 KB | ✅ Under target |
| joy-media-quality-index | ~2 KB | ✅ Under target |
| joy-media-wp36-summary | ~4 KB | ✅ Under target |
| joy-media-wp36-evidence-screenshots | ~20-40 KB | ⚠️ May need splitting |
| joy-media-wp36-evidence-logs | ~20-40 KB | ⚠️ May need splitting |
| joy-media-history-2026-08 | ~2 KB | ✅ Under target |
| joy-media-state (pointer) | ~1 KB | ✅ Under target |
| joy-media-wp36-managed... (pointer) | ~1 KB | ✅ Under target |

**Note:** Evidence chunks may need further splitting if they exceed 50 KB. The WP-36 page was 56 KB, so splitting screenshots and logs separately should keep each under threshold.

---

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| Page creation fails | All pages created before any deprecation |
| Evidence too large | Pre-split evidence into multiple pages if needed |
| Broken links | Preserve old pages with pointers; verify all links |
| Retrieval issues | Use typed links (`supersedes`, `related_to`) for GBrain to understand relationships |

---

## Approval Checklist

- [ ] Owner reviews and approves this split plan
- [ ] Owner confirms new page creation is acceptable
- [ ] Owner confirms old page deprecation (pointer replacement) is acceptable
- [ ] Owner confirms no GBrain migration/command execution is needed
- [ ] Pages created and verified on VPS GBrain
- [ ] Old pages replaced with pointers
- [ ] All pages <50 KB verified
- [ ] All current facts retrievable from index

---

*This plan is ready for owner review. No mutations to GBrain will be performed without explicit approval.*
