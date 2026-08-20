import type { EditorSession } from './editor-session.js';
import type { JoyCodeCompoundDraft } from './joy-code-compound-compiler.js';

export interface JoyCodeCompoundApproval {
  readonly planId: string;
  readonly proposalHash: string;
  readonly baseRevision: string;
  readonly approvedAt: string;
}

export type JoyCodeCompoundApplyResult =
  | { readonly applied: true; readonly replayed: false; readonly revisionId: string }
  | { readonly applied: false; readonly replayed: true; readonly revisionId: string };

export class JoyCodeCompoundRunner {
  readonly #applied = new Set<string>();

  apply(
    session: EditorSession,
    draft: JoyCodeCompoundDraft,
    approval: JoyCodeCompoundApproval,
  ): JoyCodeCompoundApplyResult {
    const replayKey = `${draft.planId}:${draft.proposalHash}`;
    if (this.#applied.has(replayKey))
      return { applied: false, replayed: true, revisionId: session.projectRevisionId };
    if (
      approval.planId !== draft.planId ||
      approval.proposalHash !== draft.proposalHash ||
      approval.baseRevision !== draft.baseRevision
    )
      throw new Error(
        'JOY_CODE_APPROVAL_MISMATCH: approval is not bound to this plan, proposal, and base revision',
      );
    if (session.projectRevisionId !== draft.baseRevision)
      throw new Error(
        `JOY_CODE_STALE_REVISION: expected ${draft.baseRevision}, got ${session.projectRevisionId}`,
      );
    const document = draft.document === session.visualProject ? undefined : draft.document;
    session.dispatchCompound(`Joy Code plan ${draft.planId}`, {
      ...(draft.timeline === undefined ? {} : { timeline: draft.timeline }),
      ...(document === undefined ? {} : { document }),
    });
    this.#applied.add(replayKey);
    return { applied: true, replayed: false, revisionId: session.projectRevisionId };
  }
}
