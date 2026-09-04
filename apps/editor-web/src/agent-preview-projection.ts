import type { JoyAgentPreviewBundle } from './joy-agent/preview-controller.js';

export interface AgentPreviewProjection<T = unknown> {
  readonly visible: boolean;
  readonly bundle: JoyAgentPreviewBundle<T> | undefined;
  readonly label: 'AGENT PREVIEW — NOT APPLIED' | 'CANONICAL';
}

export function projectAgentPreview<T>(
  bundle: JoyAgentPreviewBundle<T> | undefined,
  phase: string,
  showCanonical = false,
): AgentPreviewProjection<T> {
  const visible = bundle !== undefined && (phase === 'previewing' || phase === 'awaiting-approval');
  return {
    visible,
    bundle: visible && !showCanonical ? bundle : undefined,
    label: visible && !showCanonical ? 'AGENT PREVIEW — NOT APPLIED' : 'CANONICAL',
  };
}
