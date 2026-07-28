import type { ReactNode } from 'react';

function Svg({ children, size = 14 }: { readonly children: ReactNode; readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {children}
    </svg>
  );
}

export function KeyframeDiamondIcon() {
  return (
    <Svg size={12}>
      <path d="M8 2 14 8 8 14 2 8Z" />
    </Svg>
  );
}

export function StrokeIcon() {
  return (
    <Svg size={12}>
      <rect x="2" y="7" width="12" height="2" rx="0.5" />
    </Svg>
  );
}

export function ShadowIcon() {
  return (
    <Svg size={12}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="6" y="6" width="7" height="7" rx="1" opacity="0.45" />
    </Svg>
  );
}

export function FilterIcon() {
  return (
    <Svg size={12}>
      <path d="M2 3h12v2l-4 4v5H6V9L2 5Z" />
    </Svg>
  );
}
