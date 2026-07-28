import type { ReactNode } from 'react';

/** Panel / section title with a 24×24 PNG masked to currentColor. */
export function MsTitle({
  iconSrc,
  children,
  as: Tag = 'h3',
  className,
}: {
  readonly iconSrc: string;
  readonly children: ReactNode;
  readonly as?: 'h3' | 'h4';
  readonly className: string;
}) {
  return (
    <Tag className={`${className} ms-title-with-icon`}>
      <span
        className="ms-title-icon"
        style={{
          WebkitMaskImage: `url(${iconSrc})`,
          maskImage: `url(${iconSrc})`,
        }}
        aria-hidden="true"
      />
      <span className="ms-title-text">{children}</span>
    </Tag>
  );
}
