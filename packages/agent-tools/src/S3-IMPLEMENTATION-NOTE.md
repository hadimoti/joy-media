# S3 Implementation Note — Package Ownership Decision

## Decision

**S3 (Creative Brief and Read-Only Critique) belongs in `@joy-media/agent-tools`.**

### Rationale

1. **Dependency safety**: `@joy-media/agent-tools` already depends on `@joy-media/project-schema` per its `package.json`. This means S3 can safely import and use S1 (semantic-snapshot) and S2 (semantic-intelligence) types from `project-schema` without introducing circular dependencies.

2. **Architectural alignment**: S3 is fundamentally an **agent capability** — it accepts bounded snapshots and intelligence, runs a read-only model interpretation, and returns a structured creative brief. This fits the pattern of other agent tools in this package (queries, edit-tools, specialists, etc.).

3. **Contract boundary**: S3 defines the model boundary/orchestration contract. The agent-tools package is the correct layer for defining how external models (real or fake) integrate with the JOY Media system.

4. **No new package needed**: Introducing a new package for S3 would add unnecessary indirection. The dependency graph proves that `agent-tools` is the appropriate home.

### Ownership Split

- **S1 (Semantic Snapshot types)** → `@joy-media/project-schema` (inner core, no dependencies)
- **S2 (Semantic Intelligence types/rules)** → `@joy-media/project-schema` (depends only on S1)
- **S3 (Creative Brief model boundary/orchestration)** → `@joy-media/agent-tools` (depends on S1, S2, and project-schema)

This keeps the schema pure data, and the creative interpretation in the agent layer where it belongs.
