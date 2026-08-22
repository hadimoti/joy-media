import { useState } from 'react';

export function ThreeDStudioChat({
  sceneId,
  onDraftProposal,
}: {
  readonly sceneId?: string;
  readonly onDraftProposal?: (proposal: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [proposal, setProposal] = useState<string | undefined>(undefined);
  return (
    <aside className="three-d-studio-chat" aria-label="3D Studio chat">
      <div className="three-d-studio-section-title">Joy Code 3D</div>
      <p className="three-d-studio-chat-note">
        Chat drafts proposals only. Apply changes from the inspector or an approved tool plan.
      </p>
      {sceneId !== undefined && <small>Bound scene: {sceneId}</small>}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Describe a 3D edit…"
      />
      <button
        type="button"
        onClick={() => {
          if (draft.trim()) {
            const nextProposal = `Proposal: ${draft.trim()}`;
            setProposal(nextProposal);
            onDraftProposal?.(nextProposal);
          }
        }}
      >
        Draft proposal
      </button>
      {proposal !== undefined && (
        <div role="status" className="three-d-studio-proposal">
          {proposal}
        </div>
      )}
    </aside>
  );
}
