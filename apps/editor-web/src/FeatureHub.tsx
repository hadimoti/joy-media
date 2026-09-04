import type { ReactNode } from 'react';
import {
  AudioIcon,
  AutoCaptionIcon,
  ColorWheelIcon,
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
import { useAgentPanelPresence, useAgentSectionPresence } from './agent-presence.js';

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
    case 'color':
      return <ColorWheelIcon />;
    case 'adjust':
      return <SlidersIcon />;
    default:
      return <LayersIcon />;
  }
}

function FeatureToolPresence({
  hub,
  toolId,
}: {
  readonly hub: FeatureHubId;
  readonly toolId: FeatureToolId;
}) {
  const panelId = hub === 'create' ? 'media' : 'effects';
  const presence = useAgentSectionPresence(panelId, toolId);
  if (!presence.active) return null;
  return (
    <span
      className="feature-hub-agent-marker"
      aria-label={presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`}
      title={presence.awaitingApproval ? 'Agent needs approval' : `Agent ${presence.phase}`}
    >
      <span aria-hidden="true" />
    </span>
  );
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
  const contentId = `feature-hub-${hub}-content`;
  const hasActiveTool = definition.tools.some((tool) => tool.id === activeTool);
  const panelPresence = useAgentPanelPresence(hub === 'create' ? 'media' : 'effects');
  return (
    <section
      className={`feature-hub feature-hub--${hub}${panelPresence.active ? ' is-agent-active' : ''}`}
      aria-label={`${definition.label} tools`}
      data-agent-active={panelPresence.active ? 'true' : undefined}
      data-agent-phase={panelPresence.active ? panelPresence.phase : undefined}
    >
      <nav className="feature-hub-nav" role="tablist" aria-label={`${definition.label} tools`}>
        {definition.tools.map((tool, index) => (
          <button
            key={tool.id}
            type="button"
            role="tab"
            aria-selected={activeTool === tool.id}
            aria-controls={contentId}
            tabIndex={activeTool === tool.id || (!hasActiveTool && index === 0) ? 0 : -1}
            aria-label={tool.label}
            title={tool.label}
            data-feature-tool={tool.id}
            onClick={() => onToolChange(tool.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              const buttons = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]:not(:disabled)',
                ) ?? [],
              );
              if (buttons.length === 0) return;
              event.preventDefault();
              const current = buttons.indexOf(event.currentTarget);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : (current + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) %
                      buttons.length;
              buttons[next]?.focus();
              const nextId = buttons[next]?.dataset.featureTool;
              if (nextId !== undefined) onToolChange(nextId as FeatureToolId);
            }}
          >
            <span className="feature-hub-icon" aria-hidden="true">
              <FeatureGlyph id={tool.id} />
            </span>
            <span>{tool.shortLabel}</span>
            <FeatureToolPresence hub={hub} toolId={tool.id} />
          </button>
        ))}
      </nav>
      <div
        id={contentId}
        role="tabpanel"
        aria-label={`${definition.label} tools`}
        className="feature-hub-content"
      >
        {children}
      </div>
    </section>
  );
}
