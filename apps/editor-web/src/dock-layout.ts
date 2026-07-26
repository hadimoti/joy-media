/**
 * Default Dockview arrangement (DESIGN.md §3 seed).
 *
 * Owner layout, 2026-07-26 — tuned for short-form edits and agent work:
 *
 *   ┌──────────┬──────────┬──────────┬─────────┐
 *   │ Assets   │ Inspector│ Agent    │         │
 *   │ Effects  │ Motion   │          │ Program │
 *   │ Trans.   │ History  │          │ Monitor │
 *   │ Captions │ Jobs     │          │         │
 *   │ Audio    │ Diagnost.│          │ (full   │
 *   │ Color    │ Workflows│          │  height)│
 *   │ Plugins  │ Camera   │          │         │
 *   ├──────────┴──────────┴──────────┤         │
 *   │ Timeline · Dual Lens           │         │
 *   └────────────────────────────────┴─────────┘
 *
 * Monitor is a full-height right column because the default composition is
 * 1080×1920 — a portrait preview needs the height far more than the width.
 * Agent gets its own column so a plan stays visible while you work the other
 * two groups, instead of being a tab you have to leave to see anything.
 *
 * Seeded as JSON rather than sequential `addPanel` splits so the proportions
 * survive: building it by splitting would leave Monitor at ~50% instead of the
 * ~23% it wants. Sizes are relative — Dockview rescales them to the real
 * container against `grid.width` / `grid.height`.
 */

import { PANEL_IDS } from './workspace.js';
import { panelLabel } from './panel-tab-icons.js';

/** Bump when the seed changes; older keys are purged in App's `onReady`. */
export const DOCK_LAYOUT_KEY = 'joy-media.dockview.v8';

export const SUPERSEDED_DOCK_LAYOUT_KEYS: readonly string[] = [
  'joy-media.dockview.v1',
  'joy-media.dockview.v2',
  'joy-media.dockview.v3',
  'joy-media.dockview.v4',
  'joy-media.dockview.v5',
  'joy-media.dockview.v6',
  'joy-media.dockview.v7',
];

const BROWSER_GROUP = [
  'media',
  'effects',
  'transitions',
  'captions',
  'audio',
  'color',
  'plugins',
] as const;

const CONTEXT_GROUP = [
  'inspector',
  'motion',
  'history',
  'jobs',
  'diagnostics',
  'workflows',
  'camera',
] as const;

/** Dockview serialises every panel the same way; derive it so nothing drifts. */
function panelEntries(): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const id of PANEL_IDS) {
    entries[id] = {
      id,
      contentComponent: 'editor-panel',
      tabComponent: 'props.defaultTabComponent',
      title: panelLabel(id),
    };
  }
  return entries;
}

export function defaultDockLayout(): unknown {
  return {
    grid: {
      orientation: 'HORIZONTAL',
      width: 2200,
      height: 1000,
      root: {
        type: 'branch',
        size: 1000,
        data: [
          {
            // Everything except the monitor, stacked: tool row above timeline.
            type: 'branch',
            size: 1700,
            data: [
              {
                type: 'branch',
                size: 524,
                data: [
                  {
                    type: 'leaf',
                    size: 566,
                    data: { views: [...BROWSER_GROUP], activeView: 'media', id: 'browser' },
                  },
                  {
                    type: 'leaf',
                    size: 567,
                    data: { views: [...CONTEXT_GROUP], activeView: 'inspector', id: 'context' },
                  },
                  {
                    type: 'leaf',
                    size: 567,
                    data: { views: ['agent'], activeView: 'agent', id: 'agent-col' },
                  },
                ],
              },
              {
                type: 'leaf',
                size: 476,
                data: { views: ['timeline', 'flow'], activeView: 'timeline', id: 'timeline-row' },
              },
            ],
          },
          {
            type: 'leaf',
            size: 500,
            data: { views: ['monitor'], activeView: 'monitor', id: 'monitor-col' },
          },
        ],
      },
    },
    panels: panelEntries(),
    activeGroup: 'monitor-col',
  };
}
