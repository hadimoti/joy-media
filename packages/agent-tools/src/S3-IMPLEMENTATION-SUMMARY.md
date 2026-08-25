# S3 Implementation Summary — Creative Brief and Read-Only Critique

## Overview

S3 provides a **strictly read-only** contract for generating creative briefs from project snapshots and semantic intelligence. It is the third stage of the AI Creative OS foundation (WP-37), building on:

- **S1**: Semantic Snapshot types (bounded project state capture)
- **S2**: Semantic Intelligence types and rules (deterministic project analysis)

S3 **only interprets** — it does not mutate projects, create plans, execute commands, or access external models.

---

## Public Schema

### 1. Request Type: `CreativeBriefRequestV1`

Bounded user request with exact revision references and policy-safe inputs.

```typescript
interface CreativeBriefRequestV1 {
  // Exact references for parity validation
  projectId: string;
  snapshotRevision: number;
  intelligenceRevision: number;

  // Bounded user request
  goal: string; // Max 1000 chars
  scope: CreativeBriefScopeV1;
  focusAreas: readonly CreativeFocusAreaV1[]; // Max 10

  // Policy-safe inputs (no commands, paths, URLs, credentials)
  constraints: readonly CreativeConstraintV1[]; // Max 20
  referenceMaterials: readonly ReferenceMaterialV1[]; // Max 5

  // Audit fields
  requestId: string;
  createdAt: string;
}
```

### 2. Result Type: `CreativeBriefV1`

Structured creative brief with **explicit distinction** between deterministic S2 facts and model inferences.

```typescript
interface CreativeBriefV1 {
  // Revision parity
  snapshotRevision: number;
  intelligenceRevision: number;
  requestId: string;

  // Interpreted goal (from user request)
  interpretedGoal: string;

  // **Deterministic S2 facts** - these are verifiable from snapshot/intelligence
  factualFindings: readonly CreativeFactV1[];

  // **Model inferences** - these are AI interpretations, clearly labeled
  modelInferences: readonly CreativeInferenceV1[];

  // Assumptions the model had to make
  assumptions: readonly CreativeAssumptionV1[];

  // Recommendations with evidence references
  recommendations: readonly CreativeRecommendationV1[];

  // Blockers preventing automatic application
  blockers: readonly CreativeBlockerV1[];

  // Decisions requiring human input
  humanDecisions: readonly HumanDecisionV1[];

  // Metadata
  confidenceSummary: ConfidenceSummaryV1;
  generatedAt: string;
}
```

### 3. Recommendation Type: `CreativeRecommendationV1`

Stable, evidence-backed recommendation with risk classification.

```typescript
interface CreativeRecommendationV1 {
  id: string; // UUID v4 format
  kind: CreativeRecommendationKindV1;
  confidence: ConfidenceLevelV1; // 'low' | 'medium' | 'high'

  // Evidence references to canonical S1 evidence IDs
  evidenceReferences: readonly string[]; // Must reference valid snapshot evidence

  rationale: string; // Max 2000 chars
  expectedBenefit: string; // Max 500 chars
  riskClassification: RiskClassificationV1; // 'none' | 'low' | 'medium' | 'high'

  // Non-executable intent (never a command payload)
  proposedIntent?: ProposedIntentV1;
}
```

### 4. Recommendation Kinds: `CreativeRecommendationKindV1`

```typescript
type CreativeRecommendationKindV1 =
  | 'pacing-adjustment'
  | 'caption-improvement'
  | 'audio-enhancement'
  | 'visual-refinement'
  | 'color-correction'
  | 'composition-improvement'
  | 'content-addition'
  | 'content-removal'
  | 'style-suggestion'
  | 'accessibility-improvement'
  | 'export-optimization';
```

### 5. Evidence Types

All evidence must reference canonical S1 snapshot evidence:

```typescript
// S1 Evidence IDs reference:
// - Clip IDs from snapshot
// - Asset IDs from snapshot
// - Caption document IDs from snapshot
// - Marker IDs from snapshot
// - Workflow artifact IDs from snapshot

type EvidenceReference = string; // Must be a valid canonical ID from S1
```

---

## Model Boundary Contract

### Adapter Interface: `CreativeModelAdapter`

```typescript
interface CreativeModelAdapter {
  // Accepts only bounded, validated input
  createBrief(input: BoundedModelInputV1): Promise<StructuredModelOutputV1>;
}

interface BoundedModelInputV1 {
  snapshot: S1SemanticSnapshotV1;
  intelligence: S2SemanticIntelligenceV1;
  request: CreativeBriefRequestV1;
}

interface StructuredModelOutputV1 {
  brief: CreativeBriefV1;
}
```

### Security Constraints (Rejected Inputs)

The adapter **MUST reject** any input containing:

1. **Browser DOM references**: `window`, `document`, `HTMLElement`, etc.
2. **Raw project objects**: Unbounded project data
3. **Private URLs/paths**: `file://`, `C:\`, `/tmp/`, internal network paths
4. **Object-store references**: S3 buckets, blob storage URLs, etc.
5. **Credentials/secrets**: API keys, tokens, passwords, provider secrets
6. **Unrestricted tool access**: Command execution capabilities
7. **Command payloads**: Any executable command structures
8. **Agent execution access**: Direct agent invocation

### Output Validation

The adapter **MUST validate** that output:

1. Contains only valid canonical S1 evidence references
2. Has no command/tool payloads
3. Has no secrets, paths, URLs, or credentials
4. Uses only allowed recommendation kinds
5. Has valid IDs (UUID v4)
6. Has valid confidence levels
7. Has valid risk classifications
8. Arrays are within bounds (max lengths)
9. Strings are within bounds (max lengths)

---

## Fake/Planned Model Adapter

### `createFakeModelAdapter()`

A **deterministic, test-only** adapter that produces valid examples.

**Features:**

- No OpenRouter, no network, no real model credentials
- Fixture-safe: produces consistent outputs for given inputs
- **Modes for testing:**
  - `mode: 'valid'` - produces valid, well-formed briefs
  - `mode: 'malformed'` - produces structurally invalid outputs for parser tests
  - `mode: 'unsafe'` - produces outputs with security violations for rejection tests
  - `mode: 'excessive'` - produces oversized outputs for size limit tests
  - `mode: 'empty'` - produces minimal/empty outputs for edge case tests
  - `mode: 'timeout'` - simulates timeout/failure

**Implementation guarantee:** Clearly marked as development-only, cannot be mistaken for a real AI provider.

---

## Orchestration: `createCreativeBrief()`

### Validation Pipeline

```
CreativeBriefRequestV1
    ↓
Validate request structure and bounds
    ↓
Validate snapshot revision exists and matches
    ↓
Validate intelligence revision exists and matches
    ↓
Validate evidence parity (all recommendation evidence IDs exist in snapshot)
    ↓
Validate no mutation payloads in request
    ↓
Pass to model adapter
    ↓
Validate model output structure
    ↓
Validate model output security (no secrets, paths, URLs, commands)
    ↓
Validate model output evidence references
    ↓
Return CreativeBriefV1
```

### Read-Only Guarantee

- **Input snapshot**: Never mutated (readonly)
- **Input intelligence**: Never mutated (readonly)
- **No project writes**: No saves, no history entries, no telemetry
- **No command creation**: No AgentEditPlan, no jobs, no approvals
- **No cache writes**: No persistent storage of briefs
- **No UI state**: No UI integration (S4 scope)

---

## Persian/RTL Preservation

### Requirements

- Preserve Persian/RTL text **byte-for-byte** through:
  1. Request envelope (`goal`, `constraints`, `referenceMaterials`)
  2. Fake model response (inferred content, recommendations)
  3. Parser validation
  4. Returned brief (`interpretedGoal`, `factualFindings`, `modelInferences`, `recommendations`, etc.)

### Implementation

- No directionality enforcement
- No translation
- No normalization that changes bytes
- String validation checks length, not content

---

## Required Tests (13 Categories)

| #   | Category                           | Description                                                  |
| --- | ---------------------------------- | ------------------------------------------------------------ |
| 1   | Valid factual + inferred brief     | End-to-end with valid inputs produces valid brief            |
| 2   | Stale/mismatched snapshot revision | Rejects when snapshot revision doesn't match                 |
| 3   | Evidence reference validation      | Every recommendation must reference valid S1 evidence        |
| 4   | Fact vs inference distinction      | Facts cannot be misrepresented as inferences and vice versa  |
| 5   | Command/tool payload rejection     | No command structures can enter or leave the contract        |
| 6   | Malformed JSON                     | Rejects invalid JSON inputs                                  |
| 7   | Unknown fields                     | Rejects inputs with extra/extraneous fields                  |
| 8   | Invalid recommendation kind        | Rejects unknown recommendation kinds                         |
| 9   | Invalid ID format                  | Rejects non-UUID v4 IDs                                      |
| 10  | Invalid range/array                | Rejects oversized arrays and strings                         |
| 11  | Secret/credential leakage          | Rejects any output containing secrets, paths, URLs           |
| 12  | Unavailable capability             | Unavailable capabilities become blockers, never fake success |
| 13  | Persian/RTL preservation           | Persian text preserved byte-for-byte through entire pipeline |
| 14  | Fake adapter success               | Valid mode produces valid briefs                             |
| 15  | Fake adapter malformed             | Malformed mode produces catchable errors                     |
| 16  | Fake adapter unsafe                | Unsafe mode produces rejectable outputs                      |
| 17  | Fake adapter timeout               | Timeout mode handles gracefully                              |
| 18  | Pure/no-side-effect                | Inputs unchanged, no network, no mutations                   |
| 19  | S1/S2 suites remain green          | Existing tests still pass                                    |

---

## File Structure

```
packages/
├── project-schema/
│   └── src/
│       ├── semantic-snapshot.ts    # S1
│       ├── semantic-snapshot.test.ts
│       ├── semantic-intelligence.ts  # S2
│       └── semantic-intelligence.test.ts
│
└── agent-tools/
    └── src/
        ├── S3-IMPLEMENTATION-NOTE.md
        ├── S3-IMPLEMENTATION-SUMMARY.md
        ├── semantic-snapshot.ts       # Re-export S1 types
        ├── semantic-intelligence.ts    # Re-export S2 types
        ├── creative-brief.ts           # S3 types + createCreativeBrief
        ├── model-adapter.ts           # CreativeModelAdapter + createFakeModelAdapter
        ├── creative-brief.test.ts      # All S3 tests
        └── index.ts                    # Exports S3 types/functions
```

---

## Hard Boundaries (Never Violate)

1. ✅ **No actual LLM**: No OpenRouter, no real provider calls
2. ✅ **No UI/Agent Panel**: That is S4 scope
3. ✅ **No plan creation**: No AgentEditPlan, commands, jobs, approvals
4. ✅ **No command translation**: No dry-run, execution, provider jobs
5. ✅ **No caching**: No telemetry writes, caches, project saves
6. ✅ **No deployment**: No GBrain mutation, no pushes
7. ✅ **No S2 rules**: S3 only interprets; subjective language must be framed as inference

---

## Type Safety Notes

- All arrays are `readonly`
- All strings have maximum lengths
- All IDs are validated as UUID v4
- All evidence references must resolve to S1 canonical IDs
- All enums are closed (no string unions that allow arbitrary values)
- No `any` types in public API
