import { EyeIcon, EyeOffIcon } from './icons.js';

export function TimelineTrackVisibilityButton({
  trackId,
  visible,
  onToggle,
}: {
  readonly trackId: string;
  readonly visible: boolean;
  readonly onToggle: (visible: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-pressed={visible}
      aria-label={visible ? `Hide ${trackId}` : `Show ${trackId}`}
      title={visible ? 'Hide track' : 'Show track'}
      onClick={() => onToggle(!visible)}
    >
      {visible ? <EyeIcon /> : <EyeOffIcon />}
    </button>
  );
}
