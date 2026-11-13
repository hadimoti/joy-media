import { useContext } from 'react';
import type { IDockviewHeaderActionsProps } from 'dockview';
import { ActionOverflowMenu, type ActionOverflowMenuItem } from './ActionOverflowMenu.js';
import { EditorPanelContext } from './editor-panel-context.js';

export function PanelHeaderMenu({
  api,
  containerApi,
  group,
  activePanel,
  onResetLayout,
}: IDockviewHeaderActionsProps & { readonly onResetLayout: () => void }) {
  const location = api.location.type;
  const canFloat = location === 'grid';
  const canMaximize = location === 'grid';
  const moveTarget = containerApi.groups.find(
    (candidate) => candidate !== group && candidate.api.location.type === 'grid',
  );
  const panelName = activePanel?.title ?? group.activePanel?.title ?? group.id;
  const moveTargetName = moveTarget?.activePanel?.title ?? moveTarget?.id ?? 'another group';
  const isMaximized = canMaximize && api.isMaximized();

  const moveTo = (position: 'left' | 'right' | 'bottom') => {
    if (moveTarget !== undefined) api.moveTo({ group: moveTarget, position });
  };

  const items: readonly ActionOverflowMenuItem[] = [
    {
      id: 'close-panel',
      label: 'Close panel',
      disabled: activePanel === undefined,
      disabledReason: 'There is no active panel to close.',
      onSelect: () => activePanel?.api.close(),
    },
    {
      id: 'float-panel',
      label: 'Float group',
      tooltip: 'Moves the whole panel group into a floating window.',
      disabled: !canFloat,
      disabledReason: 'This group is already outside the dock.',
      onSelect: () => containerApi.addFloatingGroup(group),
    },
    {
      id: 'maximize-panel',
      label: isMaximized ? 'Restore panel' : 'Maximize panel',
      disabled: !canMaximize,
      disabledReason: 'Only docked groups can be maximized.',
      onSelect: () => (api.isMaximized() ? api.exitMaximized() : api.maximize()),
    },
    ...(['left', 'right', 'bottom'] as const).map((position) => ({
      id: `move-${position}`,
      label: `Move group to ${position} of ${moveTargetName}`,
      disabled: moveTarget === undefined,
      disabledReason: 'A second docked group is required.',
      onSelect: () => moveTo(position),
    })),
    {
      id: 'reset-workspace',
      label: 'Reset workspace',
      tooltip:
        'Clears every saved panel layout for all workspaces, plus saved view settings. Your projects and media are not touched.',
      onSelect: onResetLayout,
    },
  ];

  return (
    <ActionOverflowMenu
      label={`More actions for ${panelName}`}
      className="panel-header-action-overflow-menu"
      items={items}
    />
  );
}

/** Stable Dockview component; its React portal inherits the editor context. */
export function PanelHeaderActions(props: IDockviewHeaderActionsProps) {
  const context = useContext(EditorPanelContext);
  if (context === undefined) return null;
  return <PanelHeaderMenu {...props} onResetLayout={context.resetWorkspace} />;
}
