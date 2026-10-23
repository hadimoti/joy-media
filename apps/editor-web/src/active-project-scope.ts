/** The editor project the session holds, and a counter that rises on every change of it. */
export interface ActiveProjectScope {
  readonly projectId: string | null;
  /** Rises on each change, so leaving a project and returning to it is a new scope. */
  readonly generation: number;
}

/**
 * Records the active project in a ref that outlives one editor mount. Switching projects remounts
 * the editor, so an operation started in the old mount reads this ref, not the state of its own
 * instance, which no longer changes once that instance has unmounted.
 */
export function advanceActiveProjectScope(
  scope: { current: ActiveProjectScope },
  projectId: string | null,
): void {
  if (scope.current.projectId === projectId) return;
  scope.current = { projectId, generation: scope.current.generation + 1 };
}
