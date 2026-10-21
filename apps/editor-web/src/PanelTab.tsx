import { useEffect, useRef } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { panelLabel, panelTabIconUrl, panelTabSvgIcon } from './panel-tab-icons.js';
import { useAgentPanelPresence } from './agent-presence.js';
import type { PanelId } from './workspace.js';

export interface DockviewTabAccessibility {
  setActive(isActive: boolean): void;
  dispose(): void;
}

/** Adds keyboard and ARIA behavior to Dockview's focusable tab wrapper. */
export function attachDockviewTabAccessibility(
  content: HTMLElement,
  label: string,
  panelId: string,
  initiallyActive: boolean,
  activatePanel: (panelId: string) => void,
): DockviewTabAccessibility | undefined {
  const tab = content.closest<HTMLElement>('.dv-tab');
  const tabList = tab?.closest<HTMLElement>('.dv-tabs-container, .dv-tabs-overflow-container');
  if (tab === null || tab === undefined || tabList === null || tabList === undefined) {
    return undefined;
  }

  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Workspace panels');
  tabList.setAttribute('aria-orientation', 'horizontal');

  const setActive = (isActive: boolean) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-label', label);
    tab.setAttribute('aria-selected', String(isActive));
    tab.setAttribute('data-joy-panel-id', panelId);
    tab.tabIndex = isActive ? 0 : -1;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      activatePanel(panelId);
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(tabList.querySelectorAll<HTMLElement>('.dv-tab[role="tab"]'));
    if (tabs.length === 0) return;
    const currentIndex = tabs.indexOf(tab);
    if (currentIndex < 0) return;

    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (nextTab === undefined) return;
    const nextPanelId = nextTab.getAttribute('data-joy-panel-id');
    if (nextPanelId === null) return;
    nextTab.focus();
    activatePanel(nextPanelId);
  };

  setActive(initiallyActive);
  tab.addEventListener('keydown', onKeyDown);
  return {
    setActive,
    dispose() {
      tab.removeEventListener('keydown', onKeyDown);
      tab.removeAttribute('role');
      tab.removeAttribute('aria-label');
      tab.removeAttribute('aria-selected');
      tab.removeAttribute('data-joy-panel-id');
      tab.removeAttribute('tabindex');
    },
  };
}

/** Icon-only dock tab; the label becomes visible in Dockview's overflow menu. */
export function PanelTab({ api, containerApi }: IDockviewPanelHeaderProps) {
  const label = panelLabel(api.id);
  const SvgIcon = panelTabSvgIcon(api.id);
  const iconUrl = panelTabIconUrl(api.id);
  const presence = useAgentPanelPresence(api.id as PanelId);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const accessibility = attachDockviewTabAccessibility(
      content,
      label,
      api.id,
      api.isActive,
      (panelId) => {
        if (panelId === api.id) {
          api.setActive();
          return;
        }
        containerApi.getPanel(panelId)?.api.setActive();
      },
    );
    if (accessibility === undefined) return;
    const activeChange = api.onDidActiveChange((event) => accessibility.setActive(event.isActive));
    return () => {
      activeChange.dispose();
      accessibility.dispose();
    };
  }, [api, containerApi, label]);

  return (
    <div
      ref={contentRef}
      className={`panel-tab${presence.active ? ' is-agent-active' : ''}${presence.awaitingApproval ? ' is-agent-awaiting' : ''}`}
      title={label}
      data-agent-active={presence.active ? 'true' : undefined}
      data-agent-phase={presence.active ? presence.phase : undefined}
    >
      {SvgIcon !== undefined ? (
        <span className="panel-tab-svg" aria-hidden>
          <SvgIcon />
        </span>
      ) : iconUrl !== undefined ? (
        <span
          className="panel-tab-icon"
          style={{
            WebkitMaskImage: `url(${iconUrl})`,
            maskImage: `url(${iconUrl})`,
          }}
          aria-hidden
        />
      ) : (
        <span className="panel-tab-fallback">{label}</span>
      )}
      <span className="panel-tab-label">{label}</span>
      {presence.active && (
        <span className="panel-tab-agent-marker" aria-hidden="true">
          <span aria-hidden="true" />
        </span>
      )}
    </div>
  );
}
