import type { ReactNode } from 'react';

/** Shared inline SVG icon set for common editor buttons (WP-16 UI pass). */

function Svg({ children, size = 14 }: { readonly children: ReactNode; readonly size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PlayIcon() {
  return (
    <Svg>
      <path d="M4 2.5 13 8 4 13.5Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function PauseIcon() {
  return (
    <Svg>
      <rect x="3.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
      <rect x="9.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function SkipBackIcon() {
  return (
    <Svg>
      <path d="M4 3v10" />
      <path d="M13 3.5 6 8l7 4.5Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function SkipForwardIcon() {
  return (
    <Svg>
      <path d="M12 3v10" />
      <path d="M3 3.5 10 8l-7 4.5Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function UndoIcon() {
  return (
    <Svg>
      <path d="M6.5 3 3 6.5 6.5 10" />
      <path d="M3 6.5h6a4 4 0 0 1 0 8H7" />
    </Svg>
  );
}

export function RedoIcon() {
  return (
    <Svg>
      <path d="M9.5 3 13 6.5 9.5 10" />
      <path d="M13 6.5H7a4 4 0 0 0 0 8h2" />
    </Svg>
  );
}

export function ScissorsIcon() {
  return (
    <Svg>
      <circle cx="4" cy="4" r="1.8" />
      <circle cx="4" cy="12" r="1.8" />
      <path d="m5.5 5.2 8 7.3M5.5 10.8l8-7.3" />
    </Svg>
  );
}

export function TrashIcon() {
  return (
    <Svg>
      <path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.8 9h6.4l.8-9" />
      <path d="M6.5 7v4M9.5 7v4" />
    </Svg>
  );
}

export function TrimIcon() {
  return (
    <Svg>
      <path d="M13 2.5v11" />
      <rect x="2.5" y="5.5" width="8" height="5" rx="0.5" />
      <path d="m10.5 8 2.5 0" />
    </Svg>
  );
}

export function ExportIcon() {
  return (
    <Svg>
      <path d="M8 10V2.5M5 5l3-3 3 3" />
      <path d="M2.5 9.5v4h11v-4" />
    </Svg>
  );
}

export function CommandIcon() {
  return (
    <Svg>
      <path d="M5.5 5.5h5v5h-5Z" />
      <path d="M5.5 5.5H4a1.5 1.5 0 1 1 1.5-1.5Zm5 0H12a1.5 1.5 0 1 0-1.5-1.5Zm0 5H12a1.5 1.5 0 1 1-1.5 1.5Zm-5 0H4a1.5 1.5 0 1 0 1.5 1.5Z" />
    </Svg>
  );
}

export function LockIcon() {
  return (
    <Svg>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

export function MuteIcon() {
  return (
    <Svg>
      <path d="M2.5 6v4h2.5L9 13V3L5 6Z" fill="currentColor" stroke="none" />
      <path d="m11 6 3.5 4M14.5 6 11 10" />
    </Svg>
  );
}

export function SoloIcon() {
  return (
    <Svg>
      <path d="M3 9.5V8a5 5 0 0 1 10 0v1.5" />
      <rect x="2" y="9.5" width="3" height="4" rx="1" />
      <rect x="11" y="9.5" width="3" height="4" rx="1" />
    </Svg>
  );
}

export function SaveIcon() {
  return (
    <Svg>
      <path d="M2.5 2.5h9l2 2v9h-11Z" />
      <path d="M5 2.5V6h6V2.5M5 13.5V9.5h6v4" />
    </Svg>
  );
}
