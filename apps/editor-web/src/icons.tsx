import type { ReactNode } from 'react';
import { UI_ICONS } from './ui-icons.js';

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

/** 24×24 PNG masked to currentColor (matches dockview panel tabs). */
function PngMaskIcon({ src, size = 14 }: { readonly src: string; readonly size?: number }) {
  return (
    <span
      className="png-mask-icon"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
      }}
      aria-hidden="true"
    />
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
      <path d="M2.5 6.2h2.2L8.2 3.5v9L4.7 9.8H2.5Z" />
      <path d="m10.2 6.2 4.1 4.1M14.3 6.2l-4.1 4.1" />
    </Svg>
  );
}

export function SpeakerOnIcon() {
  return (
    <Svg>
      <path d="M2.5 6.2h2.2L8.2 3.5v9L4.7 9.8H2.5Z" />
      <path d="M10.5 6.2a2.6 2.6 0 0 1 0 3.6" />
      <path d="M12.2 4.6a4.8 4.8 0 0 1 0 6.8" />
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

export function CheckIcon() {
  return (
    <Svg>
      <path d="m2.5 8.5 3.5 3.5 7.5-8" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg>
      <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
    </Svg>
  );
}

export function InfoIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2V11.5" />
      <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function PlusIcon() {
  return <PngMaskIcon src={UI_ICONS.add} />;
}

export function LibraryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <path d="M7 3v18M17 3v18M2 9h20" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <Svg>
      <path d="M8 2.5V10M5 7l3 3 3-3" />
      <path d="M2.5 11.5v2h11v-2" />
    </Svg>
  );
}

export function UploadIcon() {
  return (
    <Svg>
      <path d="M8 10.5V3M5 6l3-3 3 3" />
      <path d="M2.5 11.5v2h11v-2" />
    </Svg>
  );
}

export function MicIcon() {
  return <PngMaskIcon src={UI_ICONS.mic} />;
}

export function VoiceIcon() {
  return <SpeakerOnIcon />;
}

export function EffectsUiIcon() {
  return <PngMaskIcon src={UI_ICONS.effects} />;
}

export function TransitionUiIcon() {
  return <PngMaskIcon src={UI_ICONS.transition} />;
}

export function AiEffectIcon() {
  return <PngMaskIcon src={UI_ICONS.agentAi} />;
}

export function SettingsGearIcon() {
  return <PngMaskIcon src={UI_ICONS.settings} />;
}

export function CameraUiIcon() {
  return <PngMaskIcon src={UI_ICONS.camera} />;
}

export function GridUiIcon() {
  return <PngMaskIcon src={UI_ICONS.grid} />;
}

export function ImageIcon() {
  return (
    <Svg>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <circle cx="5.7" cy="6.2" r="1.1" />
      <path d="m2.5 11 3.3-3 2.7 2.5L11 8l2.5 3" />
    </Svg>
  );
}

export function VideoIcon() {
  return (
    <Svg>
      <rect x="2.5" y="3.5" width="8" height="9" rx="1" />
      <path d="M10.5 6.5 13.5 4.5v7L10.5 9.5Z" />
    </Svg>
  );
}

/** Speaker cone + waves — used for Audio category / audio affordances. */
export function AudioIcon() {
  return <SpeakerOnIcon />;
}

export function RefreshIcon() {
  return (
    <Svg>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5V5h-2.5" />
    </Svg>
  );
}

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.2 10.2 3.3 3.3" />
    </Svg>
  );
}

export function FilterIcon() {
  return (
    <Svg>
      <path d="M2.5 3.5h11l-4 4.5V12.5l-3 1.5V8Z" />
    </Svg>
  );
}

export function UserIcon() {
  return (
    <Svg>
      <circle cx="8" cy="5" r="2.8" />
      <path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0" />
    </Svg>
  );
}

export function LogoutIcon() {
  return (
    <Svg>
      <path d="M6.5 2.5H3v11h3.5" />
      <path d="M10 5l3 3-3 3M13 8H6" />
    </Svg>
  );
}

export function ListIcon() {
  return (
    <Svg>
      <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
      <path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" strokeWidth="2" />
    </Svg>
  );
}

export function CloudIcon() {
  return (
    <Svg>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12 7.6a2.5 2.5 0 0 1-.5 4.9Z" />
    </Svg>
  );
}

export function BadgeIcon() {
  return (
    <Svg>
      <path d="M13.5 2.5H2.5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Z" />
      <path d="M5.5 5h5M5.5 8h5M5.5 11h5" />
    </Svg>
  );
}

export function ZoomInIcon() {
  return (
    <Svg>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3M7 5v4M5 7h4" />
    </Svg>
  );
}

export function ZoomOutIcon() {
  return (
    <Svg>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3M5 7h4" />
    </Svg>
  );
}

export function FitWidthIcon() {
  return (
    <Svg>
      <path d="M2.5 3.5v9M13.5 3.5v9M5.5 8H10.5M5.5 8l2-2M5.5 8l2 2M10.5 8l-2-2M10.5 8l-2 2" />
    </Svg>
  );
}

export function DuplicateIcon() {
  return (
    <Svg>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5V3.5H2.5v8h2" />
    </Svg>
  );
}

export function SpeedIcon() {
  return (
    <Svg>
      <path d="M3 12.5a6.5 6.5 0 1 1 10 0" />
      <path d="M8 12.5 10.5 7" />
      <circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FreezeIcon() {
  return (
    <Svg>
      <path d="M8 2.5v11M4.5 4.5 8 8l3.5-3.5M4.5 11.5 8 8l3.5 3.5M2.5 8h11" />
    </Svg>
  );
}

export function SelectIcon() {
  return (
    <Svg>
      <path d="M3.5 2.5 7 13.5l2-4 4-2Z" />
    </Svg>
  );
}

/** Alias for cut/split affordances (scissors remain the primary glyph). */
export function CutIcon() {
  return <ScissorsIcon />;
}

export function ProjectsIcon() {
  return <PngMaskIcon src={UI_ICONS.assets} />;
}

export function MarkerIcon() {
  return <PngMaskIcon src={UI_ICONS.marker} />;
}

export function TimelineMarkerIcon() {
  return <PngMaskIcon src={UI_ICONS.markerTimeline} size={16} />;
}

export function TimelineVideoTrackIcon() {
  return <PngMaskIcon src={UI_ICONS.timelineVideo} size={14} />;
}

export function TimelineAudioTrackIcon() {
  return <PngMaskIcon src={UI_ICONS.timelineAudio} size={14} />;
}

export function TimelineScriptTrackIcon() {
  return <PngMaskIcon src={UI_ICONS.timelineScript} size={14} />;
}

export function CopyIcon() {
  return (
    <Svg>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M10.5 5.5V3.5H2.5v8h2" />
    </Svg>
  );
}

export function PasteIcon() {
  return (
    <Svg>
      <path d="M5.5 3.5h5v2h-5Z" />
      <path d="M4 4.5h8v10H4Z" />
      <path d="M6.5 8.5h3M6.5 11h3" />
    </Svg>
  );
}

export function KeyPrevIcon() {
  return (
    <Svg>
      <path d="M13 8H5.5M8 4.5 4.5 8 8 11.5" />
      <rect
        x="2"
        y="6.5"
        width="2.2"
        height="3"
        transform="rotate(45 3.1 8)"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function KeyNextIcon() {
  return (
    <Svg>
      <path d="M3 8h7.5M8 4.5 11.5 8 8 11.5" />
      <rect
        x="11.5"
        y="6.5"
        width="2.2"
        height="3"
        transform="rotate(45 12.6 8)"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function InterpHoldIcon() {
  return (
    <Svg>
      <path d="M2.5 11.5h5V4.5h5.5" />
    </Svg>
  );
}

export function InterpLinearIcon() {
  return (
    <Svg>
      <path d="M2.5 12.5 13.5 3.5" />
      <circle cx="2.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="3.5" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function InterpEasedIcon() {
  return (
    <Svg>
      <path d="M2.5 12.5C5 12.5 5 3.5 8 3.5s3 9 5.5 9" />
      <circle cx="2.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function InterpBezierIcon() {
  return (
    <Svg>
      <path d="M2.5 12.5C5 4 11 12 13.5 3.5" />
      <path d="M2.5 12.5 5 6M13.5 3.5 11 9" />
      <circle cx="2.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function GainIcon() {
  return <PngMaskIcon src={UI_ICONS.gain} />;
}

export function LiftIcon() {
  return <PngMaskIcon src={UI_ICONS.lift} />;
}

export function GammaIcon() {
  return <PngMaskIcon src={UI_ICONS.gamma} />;
}

export function BrightnessIcon() {
  return <PngMaskIcon src={UI_ICONS.brightness} />;
}

export function SaturationIcon() {
  return <PngMaskIcon src={UI_ICONS.saturation} />;
}

export function ContrastIcon() {
  return <PngMaskIcon src={UI_ICONS.contrast} />;
}

export function InvertColorIcon() {
  return <PngMaskIcon src={UI_ICONS.invertColor} />;
}

export function BlendIcon() {
  return <PngMaskIcon src={UI_ICONS.blend} />;
}

export function CropIcon() {
  return <PngMaskIcon src={UI_ICONS.crop} />;
}

export function FullscreenIcon() {
  return <PngMaskIcon src={UI_ICONS.fullscreen} />;
}

export function PanIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 8h5.5M8 2.5v5.5" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function FadeInIcon() {
  return (
    <Svg>
      <path
        d="M2.5 12.5 13.5 12.5 13.5 3.5Z"
        fill="currentColor"
        fillOpacity="0.35"
        stroke="currentColor"
      />
    </Svg>
  );
}

export function FadeOutIcon() {
  return (
    <Svg>
      <path
        d="M13.5 12.5 2.5 12.5 2.5 3.5Z"
        fill="currentColor"
        fillOpacity="0.35"
        stroke="currentColor"
      />
    </Svg>
  );
}

export function BlurIcon() {
  return <PngMaskIcon src={UI_ICONS.blur} />;
}

export function GlowIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
      <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4l-1.4 1.4" />
    </Svg>
  );
}

export function ShadowIcon() {
  return (
    <Svg>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <path d="M7 10.5h5.5v5.5H7Z" opacity="0.45" />
    </Svg>
  );
}

export function VignetteIcon() {
  return (
    <Svg>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <ellipse cx="8" cy="8" rx="3.2" ry="2.6" />
    </Svg>
  );
}

export function SharpenIcon() {
  return (
    <Svg>
      <path d="M8 2.5 13.5 13.5h-11Z" />
      <path d="M8 6.5v4" />
    </Svg>
  );
}

export function GrainIcon() {
  return (
    <Svg>
      <path
        d="M3.5 4.5h.01M6.5 5.5h.01M10 4h.01M13 5.5h.01M4.5 8h.01M8 8.5h.01M11.5 7.5h.01M3.5 11.5h.01M7 12h.01M10.5 11h.01M13 12.5h.01"
        strokeWidth="2"
      />
    </Svg>
  );
}

export function ColorWheelIcon() {
  return <PngMaskIcon src={UI_ICONS.colors} />;
}

export function TrackAddIcon() {
  return (
    <Svg>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
      <path d="M12 10v4M10 12h4" />
    </Svg>
  );
}

export function AutoCaptionIcon() {
  return (
    <Svg>
      <rect x="2.5" y="4" width="11" height="7" rx="1" />
      <path d="M5 7.5h6M5.5 10h3" />
      <path d="M6 13.5 8 11l2 2.5" />
    </Svg>
  );
}

/** Burn-in captions into program/export frames. */
export function BurnInIcon() {
  return (
    <Svg>
      <rect x="2.5" y="3" width="11" height="8" rx="1" />
      <path d="M4.5 12.5h7" />
      <path d="M5 6.5h6M5.5 9h4" />
    </Svg>
  );
}

/** JOY Clean caption preset. */
export function CaptionCleanIcon() {
  return (
    <Svg>
      <path d="M3 11.5h10" />
      <path d="M5 8.5h6" />
    </Svg>
  );
}

/** JOY Karaoke Pop caption preset. */
export function CaptionKaraokeIcon() {
  return (
    <Svg>
      <path d="M3 11.5h10" />
      <path d="M5 8.5h3.5" strokeWidth="2" />
      <path d="M9 8.5h2" />
    </Svg>
  );
}

/** JOY RTL Classic caption preset. */
export function CaptionRtlIcon() {
  return (
    <Svg>
      <path d="M13 11.5H3" />
      <path d="M11 8.5H5" />
      <path d="M12.5 5.5 10 8l2.5 2.5" />
    </Svg>
  );
}

export function LanguageIcon({ label }: { readonly label: string }) {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M3.5 8h9M8 2.5c1.8 1.8 2.7 3.6 2.7 5.5S9.8 11.7 8 13.5C6.2 11.7 5.3 9.9 5.3 8S6.2 4.3 8 2.5Z" />
      <title>{label}</title>
    </Svg>
  );
}

export function ReelsIcon() {
  return (
    <Svg>
      <rect x="5" y="2.5" width="6" height="11" rx="1" />
      <path d="M6.5 4.5h3M6.5 11.5h3" />
    </Svg>
  );
}

export function YoutubeIcon() {
  return (
    <Svg>
      <rect x="2.5" y="4.5" width="11" height="7" rx="1.5" />
      <path d="M7 6.5 10.5 8 7 9.5Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function HighBitrateIcon() {
  return (
    <Svg>
      <path d="M2.5 11.5 5.5 4.5 8 11.5 10.5 4.5 13.5 11.5" />
    </Svg>
  );
}

export function MasterBusIcon() {
  return (
    <Svg>
      <path d="M8 2.5v6.5" />
      <circle cx="8" cy="11.5" r="2" />
      <path d="M4 5.5h8" />
    </Svg>
  );
}

export function DissolveIcon() {
  return (
    <Svg>
      <path d="M2.5 13.5 7 3.5h4.5L13.5 13.5Z" />
    </Svg>
  );
}

export function WipeIcon() {
  return (
    <Svg>
      <path d="M2.5 3.5h9v9h-9Z" />
      <path
        d="M13.5 3.5v9h-3.5l3.5-9Z"
        fill="currentColor"
        fillOpacity="0.35"
        stroke="currentColor"
      />
    </Svg>
  );
}

export function SlideIcon() {
  return (
    <Svg>
      <path d="M2.5 8h9M8 2.5v9" />
      <path d="M7 4.5 4.5 7 7 9.5ZM11 10.5 13.5 8 11 5.5Z" />
    </Svg>
  );
}

export function KeyframeNoneIcon() {
  return (
    <Svg size={14}>
      <circle cx="8" cy="8" r="4" />
    </Svg>
  );
}

export function KeyframeActiveIcon() {
  return (
    <Svg size={14}>
      <path d="M8 3 13 8 8 13 3 8Z" fill="currentColor" stroke="currentColor" strokeWidth="1" />
    </Svg>
  );
}

export function KeyframeBetweenIcon() {
  return (
    <Svg size={14}>
      <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="currentColor" strokeWidth="0.5" />
    </Svg>
  );
}

export function StarIcon() {
  return (
    <Svg size={14}>
      <path d="M8 1.5 10.2 6l5 .7-3.6 3.5.9 5L8 12.5 3.5 15.2l.9-5L.8 6.7l5-.7Z" />
    </Svg>
  );
}

export function StarFilledIcon() {
  return (
    <Svg size={14}>
      <path
        d="M8 1.5 10.2 6l5 .7-3.6 3.5.9 5L8 12.5 3.5 15.2l.9-5L.8 6.7l5-.7Z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function ChevronLeftIcon() {
  return (
    <Svg size={16}>
      <path d="M10.5 3.5 5 8l5.5 4.5" />
    </Svg>
  );
}

export function ChevronRightIcon() {
  return (
    <Svg size={16}>
      <path d="M5.5 3.5 11 8l-5.5 4.5" />
    </Svg>
  );
}

export function EyeIcon() {
  return (
    <Svg size={14}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5 6.5 4.5 6.5 4.5-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.5" />
    </Svg>
  );
}

export function EyeOffIcon() {
  return (
    <Svg size={14}>
      <path d="M2.5 2.5 13.5 13.5M6 6l.5-.5a3 3 0 0 1 4.7 3.7" />
      <path d="M1.5 8s2.5-4.5 6.5-4.5h.5m4 1.5.5.5s-2.5 4.5-6.5 4.5h-.5m-1-1.5-.5-.5" />
    </Svg>
  );
}

export function UnlockIcon() {
  return (
    <Svg size={14}>
      <rect x="3.5" y="6.5" width="9" height="7" rx="1" />
      <path d="M5.5 6.5v-2a2.5 2.5 0 0 1 5 0v1M9.5 10.5v-1" />
    </Svg>
  );
}

export function LayersIcon() {
  return (
    <Svg size={14}>
      <rect x="2.5" y="2.5" width="11" height="7" rx="0.5" />
      <path d="m4 5 4-2 4 2" />
      <rect
        x="2.5"
        y="9.5"
        width="11"
        height="4"
        rx="0.5"
        fill="currentColor"
        fillOpacity="0.3"
        stroke="currentColor"
      />
    </Svg>
  );
}

export function SlidersIcon() {
  return (
    <Svg size={14}>
      <path d="M2.5 5.5h6" strokeWidth="2" />
      <circle cx="8.5" cy="5.5" r="1.5" />
      <path d="M7.5 10.5h4" strokeWidth="2" />
      <circle cx="7.5" cy="10.5" r="1.5" fill="currentColor" />
    </Svg>
  );
}

export function CanvasIcon() {
  return (
    <Svg size={14}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 8h5l3.5 5.5" />
      <circle cx="10" cy="5.5" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function TimelineIcon() {
  return (
    <Svg size={14}>
      <rect x="2.5" y="2.5" width="11" height="3" rx="1" />
      <path d="M5 13.5V5.5m5 8V5.5" />
    </Svg>
  );
}

export function CodeIcon() {
  return (
    <Svg size={14}>
      <path d="M4.5 4.5 1 8l3.5 3.5M11.5 4.5 15 8l-3.5 3.5M9.5 3 6 13" />
    </Svg>
  );
}

export function ChevronUpIcon() {
  return (
    <Svg size={12}>
      <path d="M3.5 10.5 8 6l4.5 4.5" />
    </Svg>
  );
}

export function ChevronDownIcon() {
  return (
    <Svg size={12}>
      <path d="M3.5 5.5 8 10l4.5-4.5" />
    </Svg>
  );
}
