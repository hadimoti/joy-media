# T-P04 Dockview overflow driver step

**Status:** Written; not run in this code-only pass.

Dockview 4.13.1's `OverflowObserver` decides overflow by comparing `.dv-tabs-container` `scrollWidth` with `clientWidth` after a `ResizeObserver` callback. Its hidden-tab list checks each `.dv-tab` against that same container's bounding box. jsdom does not perform browser layout, so a jsdom test cannot establish whether a real group has clipped tabs or whether Dockview inserted its overflow control. Run this check in the real editor browser after loading the default Edit workspace.

Define these selectors and expected-hidden-name helper in the browser driver:

```ts
const headers = page.locator('.dv-groupview > .dv-tabs-and-actions-container');
const headerWithTwoTabs = headers.filter({
  has: page.locator('.dv-tabs-container > .dv-tab:nth-child(2)'),
});
const headerWithThreeTabs = headers.filter({
  has: page.locator('.dv-tabs-container > .dv-tab:nth-child(3)'),
});
const overflowControl = (header) =>
  header.locator(
    '.dv-right-actions-container .dv-tabs-overflow-dropdown-root .dv-tabs-overflow-dropdown-default',
  );
const hiddenNames = (header) =>
  header.locator('.dv-tabs-container').evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return Array.from(list.querySelectorAll(':scope > .dv-tab'))
      .filter((tab) => {
        const rect = tab.getBoundingClientRect();
        return rect.left < bounds.left || rect.right > bounds.right;
      })
      .map((tab) => tab.querySelector('.panel-tab[aria-label]')?.getAttribute('aria-label'));
  });
```

1. At a 1920 × 1080 viewport, select `headerWithTwoTabs.first()`. Assert `hiddenNames(header)` is `[]` and `overflowControl(header)` has count 0.

2. Resize to 640 × 800 and select `headerWithThreeTabs.first()`. Compute `expected` with `hiddenNames(header)`. Assert `expected` is non-empty and `overflowControl(header)` has count 1.

3. Click `overflowControl(header)`. Read the displayed hidden names from:

   ```ts
   page.locator('.dv-tabs-overflow-container .dv-tab .panel-tab[aria-label]');
   ```

   Assert this ordered list equals `expected` exactly. This catches both a missing chevron and visible tabs incorrectly included in the list.

The current `PanelTab` unit test covers the header-width calculation with Dockview's nested `.dv-scrollable` structure. It does not replace this browser layout check.
