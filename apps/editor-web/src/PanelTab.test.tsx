// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { attachDockviewTabAccessibility, PanelTab } from './PanelTab.js';

describe('PanelTab', () => {
  it('keeps the panel name in the custom tab content', () => {
    const props = { api: { id: 'media' } } as unknown as IDockviewPanelHeaderProps;
    const markup = renderToStaticMarkup(<PanelTab {...props} />);

    expect(markup).toContain('title="Create"');
    expect(markup).toContain('class="panel-tab-label">Create</span>');
    expect(markup).not.toContain('aria-label="Create"');
  });

  it('makes Dockview focusable tabs named and updates their selected state', () => {
    const tabList = document.createElement('div');
    tabList.className = 'dv-tabs-container';
    const createTab = () => {
      const dockviewTab = document.createElement('div');
      dockviewTab.className = 'dv-tab';
      dockviewTab.tabIndex = 0;
      const reactPart = document.createElement('div');
      reactPart.className = 'dv-react-part';
      const content = document.createElement('div');
      content.className = 'panel-tab';
      reactPart.append(content);
      dockviewTab.append(reactPart);
      tabList.append(dockviewTab);
      return { dockviewTab, content };
    };
    const firstFixture = createTab();
    const secondFixture = createTab();
    document.body.append(tabList);

    const activatedPanels: string[] = [];
    const tabs: {
      first?: ReturnType<typeof attachDockviewTabAccessibility>;
      second?: ReturnType<typeof attachDockviewTabAccessibility>;
    } = {};
    const activatePanel = (panelId: string) => {
      activatedPanels.push(panelId);
      tabs.first?.setActive(panelId === 'media');
      tabs.second?.setActive(panelId === 'audio');
    };
    tabs.first = attachDockviewTabAccessibility(
      firstFixture.content,
      'Create',
      'media',
      true,
      activatePanel,
    );
    tabs.second = attachDockviewTabAccessibility(
      secondFixture.content,
      'Audio',
      'audio',
      false,
      activatePanel,
    );
    expect(tabs.first).toBeDefined();
    expect(tabs.second).toBeDefined();

    expect(firstFixture.dockviewTab.getAttribute('role')).toBe('tab');
    expect(firstFixture.dockviewTab.getAttribute('aria-label')).toBe('Create');
    expect(firstFixture.dockviewTab.getAttribute('aria-selected')).toBe('true');
    expect(firstFixture.content.hasAttribute('aria-label')).toBe(false);
    expect(tabList.getAttribute('role')).toBe('tablist');
    expect(tabList.getAttribute('aria-label')).toBe('Workspace panels');

    firstFixture.dockviewTab.focus();
    const arrowRight = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    firstFixture.dockviewTab.dispatchEvent(arrowRight);
    expect(arrowRight.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(secondFixture.dockviewTab);
    expect(activatedPanels).toEqual(['audio']);
    expect(firstFixture.dockviewTab.getAttribute('aria-selected')).toBe('false');
    expect(secondFixture.dockviewTab.getAttribute('aria-selected')).toBe('true');

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    secondFixture.dockviewTab.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(activatedPanels).toEqual(['audio', 'audio']);

    tabs.first?.dispose();
    tabs.second?.dispose();
    expect(firstFixture.dockviewTab.hasAttribute('role')).toBe(false);
    expect(secondFixture.dockviewTab.hasAttribute('role')).toBe(false);
    tabList.remove();
  });
});
