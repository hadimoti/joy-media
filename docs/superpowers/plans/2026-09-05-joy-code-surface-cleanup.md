# Joy Code Surface Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Joy Code's task-style tabs with one project conversation and move 3D editing into a dedicated workspace panel.

**Architecture:** Conversation persistence is isolated in a small versioned browser-storage module. `AgentPanel` renders only the conversation and its Edit/Creative Brief capabilities. A new `Scene3DPanel` owns the former embedded viewer, while workspace metadata, Dockview seeds, and agent target maps treat `scene3d` as a first-class product panel.

**Tech Stack:** React, TypeScript, Vitest, Dockview, localStorage, Vite.

---

### Task 1: Create project-conversation persistence with safe legacy migration

**Files:**

- Create: `apps/editor-web/src/joy-code-conversation.ts`
- Create: `apps/editor-web/src/joy-code-conversation.test.ts`
- Modify: `apps/editor-web/src/AgentPanel.tsx`

- [ ] **Step 1: Write failing storage tests**

```ts
it('keeps one conversation isolated per project', () => {
  saveJoyCodeConversation(storage, 'project-a', conversation('a'));
  saveJoyCodeConversation(storage, 'project-b', conversation('b'));
  expect(loadJoyCodeConversation(storage, 'project-a')?.messages[0]?.body).toBe('a');
});

it('migrates only the latest legacy thread without rewriting the legacy key', () => {
  storage.setItem(joyCodeHistoryKey('project-a'), JSON.stringify([older, latest]));
  expect(loadJoyCodeConversation(storage, 'project-a')?.messages).toEqual(latest.messages);
  expect(storage.getItem(joyCodeHistoryKey('project-a'))).not.toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm exec vitest run apps/editor-web/src/joy-code-conversation.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `joy-code-conversation.ts` does not exist.

- [ ] **Step 3: Implement a versioned, single-conversation record**

```ts
export interface JoyCodeConversation {
  readonly version: 1;
  readonly messages: readonly JoyCodeMessage[];
  readonly updatedAt: string;
}

export function loadJoyCodeConversation(
  storage: JoyCodeConversationStorage,
  projectId: string,
): JoyCodeConversation | undefined {
  // Read v1 first. If absent, read legacy threads, select the newest, and
  // return it without altering the legacy record.
}
```

Use bounded message validation equivalent to the existing Joy Code history
validators. Persist only the new conversation key. Keep provider settings,
attached assets, project documents, and exports out of this module.

- [ ] **Step 4: Replace AgentPanel's thread state with the conversation state**

Replace `JoyCodeState`, `activeThread`, `startNewTask`, thread switching, and
thread status writes with one project-loaded conversation. Keep all message,
plan, approval, cancellation, and Creative Brief behavior on that conversation.

- [ ] **Step 5: Run focused persistence and panel tests**

Run: `pnpm exec vitest run apps/editor-web/src/joy-code-conversation.test.ts apps/editor-web/src/TimelinePanel.interaction.test.ts --pool=threads --maxWorkers=1`

Expected: PASS.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add apps/editor-web/src/joy-code-conversation.ts apps/editor-web/src/joy-code-conversation.test.ts apps/editor-web/src/AgentPanel.tsx
git commit -m "feat(agent): use one Joy Code conversation per project"
```

### Task 2: Remove redundant Joy Code navigation

**Files:**

- Modify: `apps/editor-web/src/AgentPanel.tsx`
- Modify: `apps/editor-web/src/app-menu.ts`
- Modify: `tests/e2e/wp35-universal-timeline.spec.ts`
- Create: `apps/editor-web/src/AgentPanel.test.tsx`

- [ ] **Step 1: Write the failing Joy Code surface test**

```tsx
render(<AgentPanel {...props} />);
expect(screen.queryByRole('tablist', { name: 'Joy Code sections' })).toBeNull();
expect(screen.queryByRole('button', { name: 'New Joy Code task' })).toBeNull();
expect(screen.getByRole('toolbar', { name: 'Composer capabilities' })).toBeVisible();
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm exec vitest run apps/editor-web/src/AgentPanel.test.tsx --pool=threads --maxWorkers=1`

Expected: FAIL because the tab list and new-task action still render.

- [ ] **Step 3: Simplify AgentPanel header and content**

Remove `TABS`, `tab`, the `PanelShell` header action, and conditional History/
Composer/3D rendering. Render the composer section unconditionally. Retain
the capability toolbar, attached brief card, message feed, file drop target,
live state, and composer input.

Remove the obsolete `agent.activity` menu command or route it to the Joy Code
panel without inventing a hidden History tab.

- [ ] **Step 4: Update browser expectations**

Replace the old Joy Code tab assertions in
`tests/e2e/wp35-universal-timeline.spec.ts` with assertions that Joy Code has
the Edit and Creative Brief controls and that 3D Scene exists as a workspace
panel after Task 3.

- [ ] **Step 5: Run focused UI tests**

Run: `pnpm exec vitest run apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/joy-code-conversation.test.ts --pool=threads --maxWorkers=1`

Expected: PASS.

- [ ] **Step 6: Commit the surface slice**

```bash
git add apps/editor-web/src/AgentPanel.tsx apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/app-menu.ts tests/e2e/wp35-universal-timeline.spec.ts
git commit -m "refactor(agent): simplify Joy Code to one conversation surface"
```

### Task 3: Extract 3D into a dedicated Dockview panel

**Files:**

- Create: `apps/editor-web/src/Scene3DPanel.tsx`
- Modify: `apps/editor-web/src/AgentPanel.tsx`
- Modify: `apps/editor-web/src/App.tsx`
- Modify: `apps/editor-web/src/workspace.ts`
- Modify: `apps/editor-web/src/panel-tab-icons.ts`
- Modify: `apps/editor-web/src/panel-metadata.ts`
- Modify: `apps/editor-web/src/dock-layout.ts`
- Modify: `apps/editor-web/src/workspace.test.ts`
- Modify: `apps/editor-web/src/dock-layout.test.ts`

- [ ] **Step 1: Write failing workspace and layout tests**

```ts
expect(PANEL_IDS).toContain('scene3d');
expect(PANEL_LABELS.scene3d).toBe('3D Scene');
expect(contextViews(verticalDockLayout())).toEqual(
  expect.arrayContaining(['inspector', 'scene3d', 'motion', 'audio', 'jobs']),
);
```

Add a saved-layout migration fixture that lacks `scene3d` and assert the
migrated layout retains every existing view while adding `scene3d` to the
Inspector context group.

- [ ] **Step 2: Run the workspace/layout tests and confirm failure**

Run: `pnpm exec vitest run apps/editor-web/src/workspace.test.ts apps/editor-web/src/dock-layout.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `scene3d` is not registered.

- [ ] **Step 3: Create Scene3DPanel**

```tsx
export function Scene3DPanel({ onAdd3DRender }: Scene3DPanelProps) {
  return (
    <PanelShell title="3D Scene" iconUrl={iconUrl('24_3d.png')} className="scene-3d-panel">
      <Suspense fallback={<p>Loading 3D Scene…</p>}>
        <JoyCode3DViewer onAddToTimeline={onAdd3DRender} />
      </Suspense>
    </PanelShell>
  );
}
```

Move the lazy import from `AgentPanel` into `Scene3DPanel`. Do not duplicate
viewer behavior or its Add to timeline callback.

- [ ] **Step 4: Register and place the new panel**

Add `scene3d` to the durable panel IDs, labels, icon map, metadata, and core
workspace requirements. Add it after Inspector in `CONTEXT_GROUP`. Bump the
Dockview layout version and migrate previously saved layouts by inserting the
missing panel into the context group rather than resetting the whole layout.

Render `Scene3DPanel` from `App.tsx` and remove 3D props/imports/rendering
from `AgentPanel`.

- [ ] **Step 5: Run focused panel/layout tests**

Run: `pnpm exec vitest run apps/editor-web/src/workspace.test.ts apps/editor-web/src/dock-layout.test.ts apps/editor-web/src/panel-metadata.test.ts apps/editor-web/src/panel-tab-icons.test.ts --pool=threads --maxWorkers=1`

Expected: PASS.

- [ ] **Step 6: Commit the panel slice**

```bash
git add apps/editor-web/src/Scene3DPanel.tsx apps/editor-web/src/AgentPanel.tsx apps/editor-web/src/App.tsx apps/editor-web/src/workspace.ts apps/editor-web/src/panel-tab-icons.ts apps/editor-web/src/panel-metadata.ts apps/editor-web/src/dock-layout.ts apps/editor-web/src/workspace.test.ts apps/editor-web/src/dock-layout.test.ts
git commit -m "feat(editor): move 3D Scene into workspace panels"
```

### Task 4: Route agent activity to 3D Scene and verify the cleanup

**Files:**

- Modify: `apps/editor-web/src/agent-ui-targets.ts`
- Modify: `apps/editor-web/src/agent-ui-targets.test.ts`
- Modify: `apps/editor-web/src/joy-agent/entry-points.ts`
- Modify: `apps/editor-web/src/AgentActivityIndicator.tsx`
- Modify: `apps/editor-web/src/agent-presence.ts` only if `PanelId` exhaustiveness requires it

- [ ] **Step 1: Write failing target-map tests**

```ts
expect(mapAgentToolToTargets({ tool: 'read_scene_3d' })).toEqual([
  { panelId: 'scene3d', sectionId: 'scene' },
]);
expect(targetForJoyAgentTask('3d')).toEqual({ panelId: 'scene3d', sectionId: 'scene' });
```

- [ ] **Step 2: Run the target-map test and confirm failure**

Run: `pnpm exec vitest run apps/editor-web/src/agent-ui-targets.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because 3D still points at the removed AgentPanel section.

- [ ] **Step 3: Update all trusted 3D routes**

Map `read_scene_3d`, `scene_3d`, and `propose_scene_3d` to
`{ panelId: 'scene3d', sectionId: 'scene' }`. Keep the task kind and existing
capability unchanged. Ensure the activity indicator calls the surface **3D
Scene** and still honors Follow behavior without moving focus when Follow is
off.

- [ ] **Step 4: Run the complete relevant verification set**

Run: `pnpm exec vitest run apps/editor-web/src/joy-code-conversation.test.ts apps/editor-web/src/AgentPanel.test.tsx apps/editor-web/src/agent-ui-targets.test.ts apps/editor-web/src/workspace.test.ts apps/editor-web/src/dock-layout.test.ts apps/editor-web/src/panel-metadata.test.ts apps/editor-web/src/panel-tab-icons.test.ts --pool=threads --maxWorkers=1`

Run: `pnpm typecheck`

Run: `pnpm --filter @joy-media/editor-web build`

Expected: all tests, TypeScript, and the Vite production build pass.

- [ ] **Step 5: Run browser acceptance**

Reload `https://joyst.ir/` after deployment and verify:

1. Joy Code has no History, Composer, 3D, or plus header controls.
2. Edit and Creative Brief remain visible and operable.
3. 3D Scene is adjacent to Inspector in the specialist tab group.
4. A 3D agent target marks 3D Scene, not Joy Code.
5. Existing browser layout restores without a blank or duplicate panel.

- [ ] **Step 6: Commit the routing and verification slice**

```bash
git add apps/editor-web/src/agent-ui-targets.ts apps/editor-web/src/agent-ui-targets.test.ts apps/editor-web/src/joy-agent/entry-points.ts apps/editor-web/src/AgentActivityIndicator.tsx
git commit -m "fix(agent): target 3D activity at 3D Scene panel"
```
