# Review package: 13e48de..4c5a2a1

## Commits
4c5a2a1 test(ui): keep finalization accessibility checks type-safe

## Files changed
 apps/editor-web/src/finalization-a11y.test.tsx | 11 +++++++----
 1 file changed, 7 insertions(+), 4 deletions(-)

## Diff
diff --git a/apps/editor-web/src/finalization-a11y.test.tsx b/apps/editor-web/src/finalization-a11y.test.tsx
index ed73a0d..a12040d 100644
--- a/apps/editor-web/src/finalization-a11y.test.tsx
+++ b/apps/editor-web/src/finalization-a11y.test.tsx
@@ -10,23 +10,20 @@ import { SpecialistReviewPanel } from './SpecialistReviewPanel.js';
 import { isTimelineEmptyStateActivationKey, TimelineEmptyState } from './TimelineEmptyState.js';
 import { upsertCatalogProject } from './project-catalog.js';
 
 function createStorage(): BrowserKeyValueStore {
   const values = new Map<string, string>();
   return {
     getItem: (key) => values.get(key) ?? null,
     setItem: (key, value) => {
       values.set(key, value);
     },
-    removeItem: (key) => {
-      values.delete(key);
-    },
   };
 }
 
 function emptyTimelineProject(): SpikeProject {
   return {
     id: 'timeline-project',
     rootCompositionId: 'root',
     compositions: {
       root: { id: 'root', tracks: [] },
     },
@@ -77,21 +74,27 @@ function contrastRatio(leftHex: string, rightHex: string): number {
   const left = luminance(cssColorToRgb(leftHex));
   const right = luminance(cssColorToRgb(rightHex));
   const lighter = Math.max(left, right);
   const darker = Math.min(left, right);
   return (lighter + 0.05) / (darker + 0.05);
 }
 
 function rootCssVariables(css: string): Record<string, string> {
   const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/u)?.[1] ?? '';
   const matches = [...rootBlock.matchAll(/(--joy-[\w-]+):\s*([^;]+);/gu)];
-  return Object.fromEntries(matches.map((match) => [match[1], match[2].trim()]));
+  return Object.fromEntries(
+    matches.flatMap((match) =>
+      match[1] === undefined || match[2] === undefined
+        ? []
+        : [[match[1], match[2].trim()] as const],
+    ),
+  );
 }
 
 describe('Task 28 finalization accessibility and localization', () => {
   it('chooses initial dialog focus and wraps focus traversal', () => {
     expect(resolveDialogInitialFocusIndex([{ disabled: true }, { autoFocus: true }, {}])).toBe(1);
     expect(
       resolveDialogKeyAction({
         key: 'Tab',
         shiftKey: false,
         activeIndex: 2,
