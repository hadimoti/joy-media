import type { ReactNode } from 'react';
import {
  AudioIcon,
  AutoCaptionIcon,
  EffectsUiIcon,
  FilterIcon,
  LayersIcon,
  LibraryIcon,
  SlidersIcon,
  TextTabIcon,
  TransitionUiIcon,
  VideoIcon,
  WorkflowPathIcon,
} from './icons.js';
import { FEATURE_HUBS, type FeatureHubId, type FeatureToolId } from './feature-architecture.js';

function FeatureGlyph({ id }: { readonly id: FeatureToolId }) {
  switch (id) {
    case 'media':
      return <VideoIcon />;
    case 'text':
      return <TextTabIcon />;
    case 'captions':
      return <AutoCaptionIcon />;
    case 'audio':
      return <AudioIcon />;
    case 'templates':
      return <LibraryIcon />;
    case 'motion':
      return <WorkflowPathIcon />;
    case 'transitions':
      return <TransitionUiIcon />;
    case 'effects':
      return <EffectsUiIcon />;
    case 'filters':
      return <FilterIcon />;
    case 'adjust':
      return <SlidersIcon />;
    default:
      return <LayersIcon />;
  }
}

/** Compact primary navigation above the mature feature panels. */
export function FeatureHub({
  hub,
  activeTool,
  onToolChange,
  children,
}: {
  readonly hub: FeatureHubId;
  readonly activeTool: FeatureToolId;
  readonly onToolChange: (id: FeatureToolId) => void;
  readonly children: ReactNode;
}) {
  const definition = FEATURE_HUBS[hub];
  return (
    <section className={`feature-hub feature-hub--${hub}`} aria-label={`${definition.label} tools`}>
      <nav className="feature-hub-nav" role="tablist" aria-label={`${definition.label} tools`}>
        {definition.tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            role="tab"
            aria-selected={activeTool === tool.id}
            aria-label={tool.label}
            title={tool.label}
            data-feature-tool={tool.id}
            onClick={() => onToolChange(tool.id)}
          >
            <span className="feature-hub-icon" aria-hidden="true">
              <FeatureGlyph id={tool.id} />
            </span>
            <span>{tool.shortLabel}</span>
          </button>
        ))}
      </nav>
      <div className="feature-hub-content">{children}</div>
    </section>
  );
}
