# expression-core

> **Status: WP-10.3 built.** Restricted, sandboxed expression language engine.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §20.3 (expression policy) · [`ADR-0015`](../../docs/adr/0015-p10-scope-camera-and-expressions.md) · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** A hand-written, non-Turing-complete expression parser/interpreter for
binding animatable properties to small formulas (§20.3 "safe expressions").
There is no `eval`/`Function`/`with` anywhere in this package — safety comes
from the grammar itself, not from a runtime sandbox: there is no loop or
user-defined-function syntax, so an expression's evaluation cost is bounded by
its own (limit-checked) AST size, and the interpreter only ever reads values
from an explicitly injected context — never `globalThis`, `window`, `process`,
`Date`, or any Node/browser global.

**What it owns**

- `lexer.ts` / `ast.ts` / `parser.ts` — tokenizer and recursive-descent parser
  for arithmetic, comparisons, logical/ternary, and function calls. Parsing
  enforces a max AST node count and max nesting depth (a genuine
  stack-overflow mitigation against adversarially deep input, not just a
  sanity check).
- `functions.ts` — the allowlisted numeric function set (`sin`, `cos`, `abs`,
  `clamp`, `lerp`, …) plus a **deterministic, referentially transparent**
  `random(seed)` (hash-based, not a stateful stream) so expression results stay
  pure and cacheable.
- `interpreter.ts` — evaluates an AST against an `ExpressionEvalContext`
  (a `variables` map for things like `time`, plus a `resolveReference`
  callback for explicit cross-channel/cross-object references). An
  instruction-count guard aborts runaway evaluation with a diagnostic instead
  of hanging.
- `compile.ts` — ties tokenize → parse → limit-check → static reference
  extraction together. Never throws; returns coded `ExpressionDiagnostic`s
  (matching the project's diagnostic-not-exception convention, e.g.
  `html-scene-runtime`'s `SceneDiagnostic`). `ref("objectId", "property")`
  arguments **must** be string literals — dependencies must be statically
  knowable before any evaluation happens, which is what makes cycle detection
  possible before running anything.
- `cycle.ts` — pure graph-theory cycle detection over a
  `Record<nodeId, references[]>` map; schema-agnostic (durable per-object
  wiring is WP-10.4's job).

**Must not:** `eval`/`Function`/`with`, loops or user-defined functions in the
grammar, wall-clock/unseeded randomness, DOM/network/filesystem/process access,
any renderer or I/O, a dependency on `project-schema` (this package doesn't
know what a `VisualObjectV1` is — WP-10.4 wires it in).
