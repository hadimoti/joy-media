# T-P04 panel header menu driver

Status: written for the attended app run; not executed in this code session. The T-P04 prompt says not to launch the app.

Use the task-card launch rule and a scratch profile/library. Run this in both Vertical and Widescreen Edit layouts. Save screenshots and the action/restart results under `C:\jgp\v111\evidence\T-P04\`.

## Overflow at wide and narrow sizes

1. For each Dockview group in the layout, widen the group until the header's width, less its pre, left and right action slots, is at least 480 px (`LABELLED_TAB_STRIP_WIDTH` in `PanelTab.tsx`; a strip that is already labelled stays labelled down to 456 px). Record the group name, that measured width and the visible tab names. The built-in `.dv-tabs-overflow-dropdown-default` control must be absent while every tab is fully visible. Capture that group's header.
2. Narrow each multi-tab group until one or more tabs are partially clipped. The built-in overflow control must appear. Open it and compare its entries with the tabs clipped from that same group: every hidden tab must appear once, and each fully visible tab must be absent. Select a hidden tab and confirm it becomes active and scrolls into view.
3. Repeat the narrow check for the Browser group, Context group, and Timeline group. A single-tab group must keep the overflow control hidden at every width. Capture each header and each open overflow list.

## Header actions and restart persistence

For each action, start from the same saved layout, perform one action, close and restart JOY Media, and confirm the resulting group state is still present. Reset the layout between cases.

1. **Close panel:** close the active tab. Confirm other tabs in the group remain. After restart, the closed tab remains absent; reopen it through the existing panel route and confirm it returns.
2. **Float panel:** float the group. Confirm it leaves the dock and remains floating after restart.
3. **Maximize panel:** maximize the group. Confirm it fills the dock area and remains maximized after restart.
4. **Restore panel:** restore a maximized group. Confirm the prior split layout returns after restart.
5. **Move to left, right, bottom:** run each placement separately. Confirm the group moves relative to another docked group and keeps that position after restart.
6. **Reset workspace:** the menu item clears every saved panel layout (all modes and presets) and the saved view settings, then applies the default mode and preset. Confirm the default preset's seeded layout is shown after restart. Confirm another preset's previously saved layout is gone: opening it shows its first-run layout, not the one saved before the reset.

Capture a screenshot of every group header in both layouts, plus the open panel menu and hidden-tab list. Record each action's restart result and any Dockview action that is unavailable in the real app.
