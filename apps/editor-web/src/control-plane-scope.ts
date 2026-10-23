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

/**
 * Captures the scope that an operation starts under and returns the check that its later
 * project-scoped requests run first. An await can end after the session has signed out, changed
 * owner, moved to another project, or stored a different token. The check therefore reads the
 * live scope through `current`, not through the closure that started the operation.
 */
export function captureControlPlaneScope(current: () => ControlPlaneScope): () => void {
  const started = current();
  return () => {
    const now = current();
    if (
      started.ownerKey === undefined ||
      started.token === undefined ||
      now.token !== started.token ||
      now.generation !== started.generation ||
      now.ownerKey !== started.ownerKey ||
      now.projectId !== started.projectId
    )
      throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
  };
}
