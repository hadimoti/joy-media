### Task 31 — Make content templates crash-consistent and complete the surface

**Files**

- Modify: `apps/editor-web/src/content-template-transaction.ts` and
  `apps/editor-web/src/content-template-transaction.test.ts`
- Modify: `apps/editor-web/src/editor-session.ts` and `editor-session.test.ts`
- Modify: `apps/editor-web/src/TemplatesPanel.tsx`, `template-catalog.ts`, and
  `content-template-catalog.ts`
- Create: `apps/editor-web/src/TemplatesPanel.test.tsx`

**Red**

Test one history entry, total rollback on injected failure, undo/redo of clips/objects/bindings,
deterministic caller-supplied seed, list/search/filter/loading/error, duplicate/delete, and save
current selection as Mine.

**Green**

1. Extend/use `EditorSession.dispatchCompound` so all domains validate before durable write and
   commit as one logical item.
2. Remove `Date.now()` from transaction identity; UI creates an explicit operation id.
3. Complete discoverable Templates states and RTL-safe copy.
4. Keep first-party payloads grounded in existing HTML scenes until new payload types pass the same
   transaction contract.

**Verify**

```powershell
pnpm exec vitest run apps/editor-web/src/content-template-transaction.test.ts apps/editor-web/src/TemplatesPanel.test.tsx apps/editor-web/src/editor-session.test.ts
```

**Commit:** `feat(templates): apply and manage templates atomically`

