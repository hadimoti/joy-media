import { EyeIcon, EyeOffIcon } from './icons.js';

/** `trackLabel` is the track's code or name (V1, A1), never its id. */
export function TimelineTrackVisibilityButton({
  trackLabel,
  visible,
  onToggle,
}: {
  readonly trackLabel: string;
  readonly visible: boolean;
  readonly onToggle: (visible: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-pressed={visible}
      aria-label={visible ? `Hide ${trackLabel}` : `Show ${trackLabel}`}
      title={visible ? 'Hide track' : 'Show track'}
      onClick={() => onToggle(!visible)}
    >
      {visible ? <EyeIcon /> : <EyeOffIcon />}
    </button>
  );
}
