import joyCodeHorizontalUrl from './brand-assets/joy-code-horizontal.png';
import joyCodeMarkUrl from './brand-assets/joy-code-mark.png';

export function JoyCodeLogo({
  variant,
  thinking = false,
  label,
}: {
  readonly variant: 'mark' | 'horizontal';
  readonly thinking?: boolean;
  readonly label?: string;
}) {
  return (
    <img
      className={`joy-code-logo is-${variant}${thinking ? ' is-thinking' : ''}`}
      src={variant === 'mark' ? joyCodeMarkUrl : joyCodeHorizontalUrl}
      alt={label ?? ''}
      aria-hidden={label === undefined ? 'true' : undefined}
      draggable={false}
    />
  );
}
