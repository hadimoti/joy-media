# WP-37 Creative Brief UI Cleanup Implementation Plan

> **For Vibe:** Use test-driven-development skill and task tool to implement this plan task-by-task.

**Goal:** Replace the current browser-default Creative Brief presentation with a compact, sorted, responsive JOY Studio panel that makes the recommendation and resolved goal easy to scan while preserving every WP-37 safety and data contract.

**Architecture:** Keep `CreativeBriefV1`, the controller, opt-in flow, API runner, and read-only behavior unchanged. Make `CreativeBriefPanel` conform to the repository-wide `PanelShell` contract, add pure presentation helpers for structured metrics/evidence, and render a fixed information hierarchy: composer → overview → recommendations → findings → secondary concerns → technical details. Array order from the validated brief remains unchanged; “sorted” means a deliberate section hierarchy, not inventing a new model priority.

**Tech Stack:** React 19, TypeScript, `PanelShell`, JOY design tokens in `app.css`, Vitest, `react-dom/server`, Vite, browser QA at `joyst.ir`.

---

## 1. Current context and constraints

### Verified defects

1. `apps/editor-web/src/CreativeBriefPanel.tsx` renders a raw `.creative-brief-panel` root instead of the mandatory `PanelShell` structure from `DESIGN.md` §3a.
2. `apps/editor-web/src/app.css` contains result-display rules for `.creative-brief-*`, but contains no rules for `.creative-brief-panel-*`. The textarea, button, input row, consent gate, status, retry, and empty states therefore fall back to browser defaults.
3. The request composer has no constrained grid/flex layout, so the textarea and CTA collide at narrow panel widths.
4. The result order puts request/goal, facts, and inferences ahead of recommendations. The primary user value is pushed below a long wall of diagnostic text.
5. Confidence, evidence, verification, source, and risk are rendered as inline bracket/parenthesis strings rather than compact metadata badges.
6. `formatDuration()` currently emits malformed copy and `formatEvidence()` adds `startUs + endUs`; evidence ranges must display the structured start and end values directly.
7. The current tests mostly validate TypeScript fixtures. They do not assert DOM hierarchy, shell compliance, accessible structure, section order, RTL behavior, or human-readable time formatting.
8. The screenshot appears to show duplicate Creative Brief chrome. Before deleting any label, inspect the live DOM and distinguish Dockview tab labels from the panel header. The finished panel must have one internal visible heading and one Dockview tab instance.

### Non-negotiable boundaries

- Do not modify `CreativeBriefV1`, validators, provider codec, runtime policy, consent version, API routes, project synchronization, or model prompts.
- Do not add Apply, Approve, Execute, Export, or project-mutation controls.
- Do not re-sort recommendations/facts/inferences within their validated arrays; no reliable priority field exists.
- Do not parse or rewrite arbitrary model-authored fact strings. Build the summary only from structured `brief.intelligence` fields.
- Keep facts visibly separate from model inferences.
- Keep the exact opt-in disclosure and free-only/no-paid-fallback policy.
- Use only tokens already defined in `app.css`; no new literal colors and no blue.
- The `.joy-panel-body` provided by `PanelShell` remains the only scrolling container.

## 2. Target information architecture

The content order is fixed and testable:

1. **Request composer** — compact labeled textarea, primary Generate/Improve button, processing status.
2. **Overview** — resolved goal first, confidence badge, original request as supporting copy, and structured metrics for duration, aspect ratio, scene count, destination, and brand readiness when available.
3. **Recommendations** — the most actionable result, shown before diagnostics; preserve server order.
4. **Findings** — Factual findings first, then clearly labeled Model inferences.
5. **Needs attention** — warnings, blockers, and human decisions, rendered only when non-empty.
6. **Assumptions** — secondary/unverified context, rendered only when non-empty.
7. **Technical details** — collapsed `<details>` containing snapshot revision, project ID, adapter, generation time, and processing time.

Use a single visual grammar:

- section eyebrow + concise heading;
- neutral raised cards;
- small code-owned badges for confidence/risk/source/status;
- one-line metadata where possible;
- evidence in a subordinate row, not mixed into the finding sentence;
- `dir="auto"` on request, goals, findings, rationale, benefits, questions, and warning copy;
- no centered long-form body text.

Responsive behavior:

- below `20rem`: one-column composer, full-width CTA, badges wrap, cards have reduced padding;
- `20rem–34rem`: textarea and CTA remain stacked but metrics use two columns;
- above `34rem`: composer becomes `minmax(0, 1fr) auto`; metrics can use four compact cells;
- every text block uses `min-width: 0`, `overflow-wrap: anywhere`, and no horizontal scrolling.

## 3. Implementation tasks

### Task 1: Add DOM-level regression tests for the broken structure

**Objective:** Establish failing tests for shell compliance, section ordering, and accessible result structure.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefPanel.test.tsx`
- Modify: `apps/editor-web/src/CreativeBriefDisplay.test.tsx`

**Step 1: Add `renderToStaticMarkup` coverage**

Add `react-dom/server` rendering and assert that the panel eventually contains:

```tsx
const markup = renderToStaticMarkup(
  <CreativeBriefPanel revisionId="rev-abc123" optedIn runBrief={async () => STATIC_BRIEF} />,
);

expect(markup).toContain('joy-panel-root creative-brief-panel');
expect(markup).toContain('joy-panel-header');
expect(markup).toContain('aria-label="Creative Brief"');
expect(markup).toContain('creative-brief-composer');
```

Render `CreativeBriefDisplay` and assert the fixed order using string indices:

```tsx
expect(markup.indexOf('Creative direction')).toBeLessThan(markup.indexOf('Recommendations'));
expect(markup.indexOf('Recommendations')).toBeLessThan(markup.indexOf('Factual findings'));
expect(markup.indexOf('Factual findings')).toBeLessThan(markup.indexOf('Model inferences'));
expect(markup.indexOf('Technical details')).toBeGreaterThan(markup.indexOf('Assumptions'));
```

Also assert:

- facts and inferences have different aria-labelled groups;
- technical metadata uses `<details>`;
- model-authored text has `dir="auto"`;
- badges have readable labels rather than bracket-only text.

**Step 2: Run tests and verify RED**

```powershell
pnpm exec vitest run apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/CreativeBriefDisplay.test.tsx
```

Expected: failures for missing `PanelShell`, composer class, new hierarchy, badges, and details disclosure.

**Step 3: Commit tests only**

```powershell
git add apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/CreativeBriefDisplay.test.tsx
git commit -m "test(WP-37): Define Creative Brief UI hierarchy"
```

### Task 2: Add pure presentation helpers and formatting tests

**Objective:** Derive compact overview metrics and readable evidence without changing the brief contract.

**Files:**

- Create: `apps/editor-web/src/creative-brief-presentation.ts`
- Create: `apps/editor-web/src/creative-brief-presentation.test.ts`

**Step 1: Write failing unit tests**

Cover:

- `30_000_000` microseconds → `30s`;
- `65_000_000` microseconds → `1m 05s`;
- evidence `{ startUs: 5_000_000, endUs: 8_000_000 }` → `0:05–0:08`, never `0:13`;
- missing duration/destination produces no empty metric;
- project metrics come from `brief.intelligence.project` and brand readiness from `brief.intelligence.brand`;
- Persian strings pass through byte-for-byte.

**Step 2: Run tests and verify RED**

```powershell
pnpm exec vitest run apps/editor-web/src/creative-brief-presentation.test.ts
```

Expected: module-not-found failure.

**Step 3: Implement minimal pure helpers**

The module should expose only presentation data:

```ts
export interface CreativeBriefMetric {
  readonly id: 'duration' | 'aspect-ratio' | 'scenes' | 'destination' | 'brand';
  readonly label: string;
  readonly value: string;
}

export function formatBriefDurationUs(durationUs: number): string;
export function formatBriefEvidence(evidence: readonly EvidenceRefV1[]): string;
export function createCreativeBriefMetrics(brief: CreativeBriefV1): readonly CreativeBriefMetric[];
```

Rules:

- use integer arithmetic and stable English UI copy;
- do not use locale-dependent output in unit assertions;
- omit unavailable metrics instead of showing `undefined`, `0:0`, or empty cards;
- never inspect arbitrary statement text with regex replacement.

**Step 4: Run tests and verify GREEN**

```powershell
pnpm exec vitest run apps/editor-web/src/creative-brief-presentation.test.ts
```

Expected: all focused helper tests pass.

**Step 5: Commit**

```powershell
git add apps/editor-web/src/creative-brief-presentation.ts apps/editor-web/src/creative-brief-presentation.test.ts
git commit -m "joy-media(WP-37): Add Creative Brief presentation helpers"
```

### Task 3: Move Creative Brief onto the shared panel shell

**Objective:** Give the feature one canonical panel header, predictable padding, and one scrolling body.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefPanel.tsx`
- Modify: `apps/editor-web/src/App.tsx`
- Test: `apps/editor-web/src/CreativeBriefPanel.test.tsx`

**Step 1: Add the shell imports**

Use:

```tsx
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
```

**Step 2: Replace the raw root**

The stable outer structure must be:

```tsx
<PanelShell
  title="Creative Brief"
  iconUrl={panelTabIconUrl('creative-brief')}
  className="creative-brief-panel"
>
  {/* consent, composer, states, result */}
</PanelShell>
```

Do not add a second custom header. Keep consent/error/idle/result states inside the shell body so the panel never swaps its structure for a sentence.

**Step 3: Make the Suspense fallback structurally identical**

In `App.tsx`, keep the fallback `PanelShell`, but give it the same icon and class. Confirm the resolved component replaces it rather than nesting another shell.

**Step 4: Diagnose duplicate chrome**

In a live DOM inspection, record:

- number of Dockview panels whose ID is `creative-brief`;
- number of internal `.joy-panel-title` elements;
- whether the apparent duplicate is a Dockview tab label, overflow item, Suspense fallback, or duplicate panel registration.

Fix only the proven source. Acceptance is exactly one registered panel instance and one internal visible title.

**Step 5: Run focused tests**

```powershell
pnpm exec vitest run apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/PanelShell.test.tsx apps/editor-web/src/panel-metadata.test.ts
```

Expected: shell and registry tests pass.

**Step 6: Commit**

```powershell
git add apps/editor-web/src/CreativeBriefPanel.tsx apps/editor-web/src/App.tsx apps/editor-web/src/CreativeBriefPanel.test.tsx
git commit -m "joy-media(WP-37): Align Creative Brief with panel shell"
```

### Task 4: Rebuild the request composer and state messages

**Objective:** Replace browser-default controls with a compact, accessible JOY composer.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefPanel.tsx`
- Modify: `apps/editor-web/src/CreativeBriefPanel.test.tsx`

**Step 1: Write failing markup assertions**

Assert:

- visible `<label>` for the textarea;
- CTA text is `Generate brief` for idle/success and `Generating…` while collecting;
- processing status is `role="status"` with `aria-live="polite"`;
- error/stale/unavailable blocks use one shared state-card class;
- retry and clear are grouped separately from the primary composer CTA;
- consent disclosure and opt-in CTA remain intact.

**Step 2: Run and verify RED**

```powershell
pnpm exec vitest run apps/editor-web/src/CreativeBriefPanel.test.tsx
```

**Step 3: Implement the composer structure**

Use a field wrapper, visible label, optional short hint, textarea, CTA, and status. Keep the existing reducer callbacks and disabled conditions unchanged. Add `dir="auto"` to the textarea.

State cards should use the same DOM shape:

```tsx
<section className="creative-brief-state creative-brief-state-error" role="alert">
  <strong>Couldn’t generate the brief</strong>
  <p dir="auto">{state.error}</p>
  <div className="creative-brief-state-actions">…</div>
</section>
```

Do not hide stale results; show the stale warning above the last brief, as today.

**Step 4: Run and verify GREEN**

```powershell
pnpm exec vitest run apps/editor-web/src/CreativeBriefPanel.test.tsx
```

**Step 5: Commit**

```powershell
git add apps/editor-web/src/CreativeBriefPanel.tsx apps/editor-web/src/CreativeBriefPanel.test.tsx
git commit -m "joy-media(WP-37): Organize Creative Brief request states"
```

### Task 5: Reorder and simplify the result display

**Objective:** Put creative direction and recommendations first while retaining every validated detail.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefDisplay.tsx`
- Modify: `apps/editor-web/src/CreativeBriefDisplay.test.tsx`
- Use: `apps/editor-web/src/creative-brief-presentation.ts`

**Step 1: Implement the overview**

Render a `creative-brief-overview` section containing:

- eyebrow `Creative direction`;
- resolved goal as the strongest line;
- confidence badge;
- original request and inferred goal as supporting rows;
- metrics grid from `createCreativeBriefMetrics()`.

Do not repeat `userIntent` when it is byte-identical to `brief.request`.

**Step 2: Move recommendations directly after overview**

Each recommendation card should have:

- kind badge;
- confidence and risk badges;
- rationale as the card title/body lead;
- expected benefit in a dedicated row;
- optional intent, evidence, and scope in a subordinate metadata block.

Preserve `brief.recommendations` order.

**Step 3: Render facts and inferences as distinct groups**

Use separate aria labels and visual headings. Each item has:

- statement line;
- metadata row for source/confidence;
- rationale/evidence below when present.

Do not show punctuation-generated labels like `[snapshot]` or `(Confidence: High)`; use badge text with accessible labels.

**Step 4: Group secondary content**

- `Needs attention`: warnings → blockers → human decisions.
- `Assumptions`: one neutral list.
- omit empty groups entirely.
- `Technical details`: collapsed `<details>` at the bottom.

**Step 5: Run focused tests**

```powershell
pnpm exec vitest run apps/editor-web/src/CreativeBriefDisplay.test.tsx apps/editor-web/src/creative-brief-presentation.test.ts
```

Expected: hierarchy, conditional sections, evidence formatting, and RTL assertions pass.

**Step 6: Commit**

```powershell
git add apps/editor-web/src/CreativeBriefDisplay.tsx apps/editor-web/src/CreativeBriefDisplay.test.tsx apps/editor-web/src/creative-brief-presentation.ts
git commit -m "joy-media(WP-37): Sort Creative Brief result hierarchy"
```

### Task 6: Add responsive panel styling with JOY tokens

**Objective:** Make the composer and result readable at narrow, standard, and wide dock widths.

**Files:**

- Modify: `apps/editor-web/src/app.css`

**Step 1: Add the panel root to shared surface coverage**

Add `.creative-brief-panel` alongside the other named panel roots only where a named selector is required. Do not repaint the dock surface; `PanelShell` remains transparent inside the gray Dockview tile.

**Step 2: Add component-specific classes**

Define styles for:

- `.creative-brief-panel .joy-panel-body`
- `.creative-brief-composer`
- `.creative-brief-field`
- `.creative-brief-panel-textarea`
- `.creative-brief-primary-action`
- `.creative-brief-state` and semantic variants
- `.creative-brief-overview`
- `.creative-brief-metrics`
- `.creative-brief-metric`
- `.creative-brief-section`
- `.creative-brief-card-list`
- `.creative-brief-card`
- `.creative-brief-badge` variants
- `.creative-brief-item-meta`
- `.creative-brief-technical`

All dimensions use existing spacing, radius, type, control, border, background, and semantic tokens.

**Step 3: Add container queries**

Use the existing `PanelShell` container:

```css
@container (max-width: 20rem) {
  .creative-brief-composer {
    grid-template-columns: minmax(0, 1fr);
  }
  .creative-brief-primary-action {
    width: 100%;
  }
  .creative-brief-metrics {
    grid-template-columns: minmax(0, 1fr);
  }
}

@container (min-width: 34rem) {
  .creative-brief-composer {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .creative-brief-metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
```

Base layout should be two metric columns and stacked composer controls, so the smallest state works without relying on the query.

**Step 4: Check CSS constraints**

```powershell
rg -n "creative-brief" apps/editor-web/src/app.css
rg -n "#[0-9a-fA-F]{3,8}" apps/editor-web/src/app.css
```

Expected: Creative Brief styles exist; no new literal hex values were introduced outside the token source.

**Step 5: Run build**

```powershell
pnpm --filter @joy-media/editor-web build
```

Expected: build succeeds; the existing chunk-size warning is acceptable if unchanged.

**Step 6: Commit**

```powershell
git add apps/editor-web/src/app.css
git commit -m "style(WP-37): Add responsive Creative Brief layout"
```

### Task 7: Close accessibility, RTL, and overflow gaps

**Objective:** Verify the cleaned panel remains operable and readable for keyboard, narrow layouts, long content, and Persian text.

**Files:**

- Modify: `apps/editor-web/src/CreativeBriefPanel.test.tsx`
- Modify: `apps/editor-web/src/CreativeBriefDisplay.test.tsx`
- Modify only if failures require it: `apps/editor-web/src/CreativeBriefPanel.tsx`
- Modify only if failures require it: `apps/editor-web/src/CreativeBriefDisplay.tsx`
- Modify only if failures require it: `apps/editor-web/src/app.css`

**Step 1: Add edge-case fixtures**

Cover:

- a long unbroken asset/scene ID;
- multi-paragraph request text;
- Persian request, resolved goal, inference, and recommendation;
- zero recommendations/facts/inferences;
- all optional secondary sections present;
- large evidence arrays;
- stale/error/processing states.

**Step 2: Assert semantics**

- one `<article aria-label="Creative Brief">` panel shell;
- headings remain in a valid hierarchy;
- status uses live region and error uses alert semantics;
- textarea has a real label;
- all authored prose has `dir="auto"`;
- `<details>` summary is keyboard-focusable by default;
- no action wording implies that the brief mutates the project.

**Step 3: Run focused suite**

```powershell
pnpm exec vitest run \
  apps/editor-web/src/CreativeBriefPanel.test.tsx \
  apps/editor-web/src/CreativeBriefDisplay.test.tsx \
  apps/editor-web/src/creative-brief-presentation.test.ts \
  apps/editor-web/src/creative-brief-controller.test.ts \
  apps/editor-web/src/creative-brief-panel-runner.test.ts
```

Expected: all focused tests pass.

**Step 4: Commit**

```powershell
git add apps/editor-web/src/CreativeBriefPanel.test.tsx apps/editor-web/src/CreativeBriefDisplay.test.tsx apps/editor-web/src/CreativeBriefPanel.tsx apps/editor-web/src/CreativeBriefDisplay.tsx apps/editor-web/src/app.css
git commit -m "test(WP-37): Cover Creative Brief responsive semantics"
```

### Task 8: Browser QA, documentation, and release gate

**Objective:** Prove the sorted UI works in the real docked editor without changing WP-37 behavior.

**Files:**

- Create: `docs/qa/evidence/wp37-creative-brief-ui/README.md`
- Create screenshots under: `docs/qa/evidence/wp37-creative-brief-ui/`
- Modify: `STATE.md`
- Modify: `plan/WP-37-ai-creative-os-foundation.md` only if it has a matching UI-quality checkpoint; do not rewrite historical completion claims.

**Step 1: Run browser matrix**

Test the actual Creative Brief dock panel at:

- narrow: approximately `280–320px` panel width;
- standard: approximately `420–520px`;
- wide: `720px+`;
- English successful brief;
- Persian/RTL successful brief;
- idle, processing, success, stale, provider error, and consent-disabled states.

Record for each width/state:

- no horizontal overflow;
- CTA remains visible and does not overlap the textarea;
- exactly one panel title and one Creative Brief dock tab;
- recommendations appear before findings;
- facts remain distinct from model inferences;
- metadata is collapsed by default;
- no console errors/warnings introduced;
- no Apply/Execute control appears.

**Step 2: Capture evidence**

Minimum screenshots:

- `narrow-success.png`
- `standard-success.png`
- `wide-success.png`
- `persian-rtl.png`
- `consent-disabled.png`
- `provider-error.png`

Document viewport, panel width, commit SHA, test project/revision, and whether provider output was live or fixture-backed. Never include tokens, raw request headers, or secrets.

**Step 3: Run complete gates**

```powershell
pnpm exec vitest run \
  apps/editor-web/src/CreativeBriefPanel.test.tsx \
  apps/editor-web/src/CreativeBriefDisplay.test.tsx \
  apps/editor-web/src/creative-brief-presentation.test.ts \
  apps/editor-web/src/creative-brief-controller.test.ts \
  apps/editor-web/src/creative-brief-panel-runner.test.ts \
  apps/editor-web/src/creative-brief-request-coordinator.test.ts \
  apps/editor-web/src/creative-brief-opt-in-coordinator.test.ts
pnpm --filter @joy-media/editor-web build
pnpm test
git diff --check
git status --short
```

Expected:

- all Creative Brief tests pass;
- editor build passes;
- full test suite has no new failure;
- diff check passes;
- only intended files are changed before the final commit.

**Step 4: Update state honestly**

Record:

- information hierarchy;
- PanelShell compliance;
- responsive widths tested;
- English/RTL evidence;
- focused/full test counts;
- build result;
- confirmation that runtime/provider/consent/data contracts were unchanged.

**Step 5: Commit**

```powershell
git add docs/qa/evidence/wp37-creative-brief-ui STATE.md plan/WP-37-ai-creative-os-foundation.md
git commit -m "docs(WP-37): Record Creative Brief UI cleanup"
```

## 4. Files expected to change

| File                                                      | Intended change                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/editor-web/src/CreativeBriefPanel.tsx`              | Adopt `PanelShell`; organize composer, consent, and state cards.                |
| `apps/editor-web/src/CreativeBriefPanel.test.tsx`         | Replace fixture-only checks with DOM structure and state assertions.            |
| `apps/editor-web/src/CreativeBriefDisplay.tsx`            | Render overview-first sorted hierarchy, badges, details, RTL attributes.        |
| `apps/editor-web/src/CreativeBriefDisplay.test.tsx`       | Assert hierarchy, conditional content, semantics, RTL, and metadata disclosure. |
| `apps/editor-web/src/creative-brief-presentation.ts`      | Pure human-readable duration/evidence/metric helpers.                           |
| `apps/editor-web/src/creative-brief-presentation.test.ts` | Deterministic helper tests.                                                     |
| `apps/editor-web/src/app.css`                             | Token-based responsive Creative Brief layout.                                   |
| `apps/editor-web/src/App.tsx`                             | Structurally matching Suspense fallback and proven duplicate-title fix only.    |
| `docs/qa/evidence/wp37-creative-brief-ui/README.md`       | Browser evidence manifest.                                                      |
| `STATE.md`                                                | Honest completion and verification record.                                      |

Files that should not change: `packages/agent-tools/**`, `packages/adapter-openrouter/**`, `apps/api/**`, controller/runtime/coordinator production behavior, provider configuration, VPS secrets, deployment manifests.

## 5. Acceptance criteria

- Creative Brief renders through `PanelShell` with one internal title and one Dockview panel instance.
- No browser-default textarea or button styling remains.
- Composer never overlaps or overflows at a 280px panel width.
- Section order is Overview → Recommendations → Findings → Needs attention → Assumptions → Technical details.
- Recommendation/fact/inference array order is preserved.
- Facts and model inferences are visually and semantically distinct.
- Duration and evidence ranges are human-readable and mathematically correct.
- Metadata is available but collapsed by default.
- Long IDs and prose wrap without horizontal scrolling.
- Persian/RTL text reads correctly without flipping the entire panel chrome.
- Empty optional sections do not create blank headings/cards.
- Idle, consent, processing, error, stale, and success states use the same panel structure.
- No project mutation or new provider/runtime behavior is introduced.
- Focused tests, editor build, full test suite, browser matrix, and `git diff --check` pass.

## 6. Risks and mitigations

| Risk                                  | Mitigation                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| “Sorting” changes model meaning       | Sort sections only; preserve validated array order.                                                  |
| Duplicate title fix hides all labels  | Inspect Dockview and panel DOM counts first; keep one internal accessible title.                     |
| Nested scrollbars                     | Keep `.joy-panel-body` as the only overflow container; use normal flow or sticky composer inside it. |
| Cards become visually heavy           | Use neutral raised rows, modest padding, and amber only for active/primary state.                    |
| RTL flips icons/chrome                | Apply `dir="auto"` only to authored prose fields.                                                    |
| Evidence formatting changes semantics | Unit-test start/end endpoints; never add them together.                                              |
| UI cleanup leaks into runtime scope   | Limit changes to editor presentation files and QA/docs.                                              |
| Live model output is inconsistent     | Use typed fixture states for layout matrix, then one real opted-in read-only brief as a final smoke. |

## 7. Handoff sequence

Implement in this order: Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Do not start CSS by itself before the shell and hierarchy tests exist. Review after Task 5 for contract compliance, after Task 7 for code/accessibility quality, and after Task 8 for browser evidence and release readiness.

## Implementation status

Tasks 1–7 are implemented in the editor and verified locally. Task 8’s automated gates pass, and the deployed `ab3d9c0` artifact passed a live browser DOM smoke on `joyst.ir`: one Creative Brief shell/title, one labeled composer/textarea, `Generate brief`, no legacy input root, no horizontal overflow, and no console errors. The full narrow/standard/wide screenshot matrix was not captured; no provider request or live model canary is claimed.
