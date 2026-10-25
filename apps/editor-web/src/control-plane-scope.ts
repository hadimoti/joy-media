/** The owner, project and stored session token that a long control-plane operation started under. */
export interface ControlPlaneScope {
  /** The ready owner's key, or undefined while no ready owner is signed in. */
  readonly ownerKey: string | undefined;
  readonly projectId: string;
  /** Increases on every change of owner or project, so a return to the same scope is a new one. */
  readonly generation: number;
  /** The stored session token. Each request sends whatever token is stored when it starts. */
  readonly token: string | undefined;
}

export const SESSION_LEFT_PROJECT_MESSAGE =
  'The session left this project before the operation finished. Nothing more was sent for it.';

/** The message a control-plane request gives when no signed-in session is stored. */
export const SESSION_REQUIRED_MESSAGE = 'JOY Media session required';

/**
 * Captures the scope that an operation starts under and returns the check that its later
 * project-scoped requests run first. An await can end after the session has signed out, changed
 * owner, moved to another project, or stored a different token. The check therefore reads the
 * live scope through `current`, not through the closure that started the operation.
 */
export function captureControlPlaneScope(current: () => ControlPlaneScope): () => void {
  const started = current();
  return () => {
    // An operation that began without a ready owner never held a session to leave.
    if (started.ownerKey === undefined || started.token === undefined)
      throw new Error(SESSION_REQUIRED_MESSAGE);
    const now = current();
    if (
      now.token !== started.token ||
      now.generation !== started.generation ||
      now.ownerKey !== started.ownerKey ||
      now.projectId !== started.projectId
    )
      throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
  };
}

/**
 * Runs a scope check and reports whether the scope still holds. Cleanup uses it to skip a request
 * for a project the session has left, where throwing would hide the outcome it has to report.
 */
export function scopeStillHeld(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the check that a panel or a long operation runs before each project-scoped request. A
 * capture that fails, because the session does not hold the project, leaves a check that always
 * throws, so the operation fails closed rather than missing its own failure.
 */
export function startProjectScopeCheck(
  capture: ((projectId: string) => () => void) | undefined,
  projectId: string,
): () => void {
  try {
    if (capture !== undefined) return capture(projectId);
  } catch {
    // The editor no longer holds this project, so the check below refuses every request.
  }
  return () => {
    throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
  };
}
