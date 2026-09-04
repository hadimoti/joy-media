---
title: JOY Media native stock-video library redesign
status: proposed
effective_date: 2026-09-04
tags: [design, editor-web, stock-video, asset-library, accessibility]
---

# JOY Media native stock-video library redesign

## Status and scope

This is an implementation plan only. It targets the editor-web asset library at production baseline a314dd70a1f68b2dbb00365782f37e37c6d109f4. It does not implement, commit, push, deploy, restart, or change a provider/backend/storage contract.

The design covers the native Pexels/Pixabay stock-video catalog shown under Cloud library → Video. Existing My media, cloud picture collections, attribution/source links, same-origin posters/previews, preview behavior, import-to-My-media behavior, six eligible clips per category, and the shared large/medium/list view modes remain in scope for preservation.

Reference evidence:

- Current UI screenshot: C:\Users\HadiMoti\AppData\Local\Temp\codex-clipboard-ea730c48-c987-4f1b-b411-87d0d06f4cbf.png
- Existing cloud picture category-rail screenshot: C:\Users\HadiMoti\AppData\Local\Temp\codex-clipboard-c0b227cc-19e2-405f-a0b6-c1ccd4c1185f.png
- Primary source files: apps/editor-web/src/StockVideoDiscovery.tsx, apps/editor-web/src/AssetLibraryPanel.tsx, apps/editor-web/src/asset-library-icons.ts, apps/editor-web/src/icon-assets.ts, and apps/editor-web/src/app.css

## Problem evidence and root cause

The current native stock catalog is visually unstable in the narrow editor dock:

- The screenshot shows a portrait clip using a tall 9:16 poster while the neighboring landscape clip uses a short 16:9 poster. Their metadata and actions start at different vertical positions, making one grid row look broken.
- The pane is narrow enough that provider, creator, dimensions, source, and import controls compete for little horizontal space. Medium cards stack actions vertically, which makes the card disproportionately tall and pushes actions away from their peers.
- Stock categories are rendered as a horizontally scrolling pill tablist inside StockVideoDiscovery. This duplicates the visual language of the cloud picture collection rail and consumes scarce vertical space.
- The existing asset rail already has the correct JOY visual language: icon-only controls, mask icons, selected accent treatment, tooltips, and a scrollable vertical rail. The stock catalog does not reuse it.

The code confirms the direct causes:

- StockVideoDiscovery.tsx owns category internally and renders .stock-video-categories as a horizontal tablist.
- app.css gives every poster aspect-ratio: 16 / 9, then overrides portrait cards with aspect-ratio: 9 / 16 at .stock-video-card[data-orientation='portrait'] .stock-video-poster.
- Card copy and actions are in normal flow; there is no equal-height/flex-bottom contract. The medium layout turns actions into a column.
- AssetLibraryPanel.tsx already owns the outer asset category and view mode, renders .asset-library-sidebar and .asset-library-collections, and passes viewMode to StockVideoDiscovery. showingStockVideos is already exactly assetSource === 'cloud' && category === 'video'.
- STOCK_VIDEO_CATEGORIES in control-plane-client.ts is the stable eight-category browser contract. It remains the single category list; no provider API change is needed.

## Goals

1. Make portrait and landscape stock clips occupy the same predictable grid geometry.
2. Keep title, provider/creator, technical metadata, attribution, and actions readable without uneven rows or clipped primary actions.
3. Reuse the existing left icon-only asset rail when native stock video is active, with eight distinct local mask icons and no nested second rail.
4. Preserve the three shared view modes and make each intentional at the editor dock width.
5. Preserve native JOY presentation: provider-neutral catalog language, with provider/creator and source attribution only where required.
6. Preserve current loading, error, empty, poster, preview, import, and retry behavior, improving layout stability and accessibility.
7. Limit later verification to focused UI-contract and rendered-layout checks.

## Non-goals

- No changes to Pexels/Pixabay keys, backend provider adapters, catalog ranking, category IDs, proxy routes, storage, import workers, or deployment configuration.
- No masonry layout, variable-height media frames, or orientation-specific poster dimensions in grid modes.
- No new cloud-provider browsing surface or provider-brand tabs.
- No timeline insertion before import; stock clips remain imported to My media first.
- No redesign of owned BrowserAsset cards beyond avoiding accidental style leakage from stock-card classes.
- No broad editor regression, long soak, production-browser run, or deployment as part of this planning task.

## Proposed UX

### Shell composition and category ownership

Cloud library → Video → native stock is one state of the existing asset library, not a second library.

1. Keep the existing PanelShell top-level tabs. Video remains selected.
2. Keep the existing asset-library-content two-column composition: one asset-library-sidebar and one asset-library-main.
3. When showingStockVideos is true, replace the sidebar's derived cloud collection entries with the eight native stock category entries. Do not render a second sidebar inside StockVideoDiscovery.
4. When the user leaves native stock (My media, Images, Audio, or another collection), restore the existing cloud collection rail unchanged.
5. Remove stock-video-categories and its horizontal pills from native stock. The selected rail icon and heading are sufficient category context.
6. Keep the shared search field and shared large/medium/list switch in the shell. Search filters the selected stock category through stockVideos(category, query).
7. Keep the selected stock category in AssetLibraryPanel state for the session. Switching away and back returns to the last selected category; it does not alter persisted asset-library view preferences. A category change starts the existing loading state and stale responses remain guarded by the request sequence.

### Controlled category contract

AssetLibraryPanel is the sole owner and writer of stock category selection. Its existing AssetCategory state remains the top-level asset type (for example, video); it is never reused for a stock slug. Add a distinct state named stockVideoCategory with type BrowserStockVideoCategory, initialized to STOCK_VIDEO_CATEGORIES[0].id. Add stockVideoCategoryCounts with one entry per stable ID.

The rail is intentionally inline in AssetLibraryPanel.tsx; no new rail component or file is required. The exact split is:

- Inline stock category rail in AssetLibraryPanel.tsx receives stockVideoCategory, stockVideoCategoryCounts, and a single onCategoryChange handler implemented as setStockVideoCategory. That handler is the sole write path for the stock slug.
- StockVideoDiscovery.tsx receives client, projectId, query, category={stockVideoCategory}, categoryCounts={stockVideoCategoryCounts}, onCategoryCountsChange={mergeStockVideoCounts}, viewMode, onImport, and onStatus. It receives no onCategoryChange prop and renders no category buttons.
- The panel's mergeStockVideoCounts callback merges server counts by key without changing stockVideoCategory. Discovery calls it only after the response wins the existing request-sequence guard.

There is one visible rail and one controlled selected value. On entry to native stock, the panel keeps the session's last stockVideoCategory; switching to another top-level asset type leaves it intact. Initialize all eight counts to the existing six-card target so the rail has stable labels before the first response. Counts are display metadata only; a zero count remains selectable and produces the normal empty state.

### Stock category rail

The native rail mirrors the cloud picture rail's proportions, mask-icon rendering, focus treatment, and selected accent.

Runtime orientation source of truth (one reference box):

- Add one ResizeObserver effect in AssetLibraryPanel.tsx, observing exactly `.asset-library-content` through `assetLibraryContentRef`. On setup and every callback, read `assetLibraryContentRef.current.getBoundingClientRect().width` (the measured border-box width of that exact box); derive `isHorizontalStockRail` as `contentWidth <= 288px` (18rem at the app's 16px root) and store that boolean in panel state. No outer Dockview, `.asset-library`, viewport, or child width is a product input.
- Disconnect the observer on unmount; do not create a second observer in StockVideoDiscovery. Initial measurement and callbacks use the same derive function.
- Write data-stock-rail-orientation="horizontal|vertical" on .asset-library-content. Use isHorizontalStockRail for aria-orientation, roving key axis, and Home/End focus logic.
- Make `.asset-library-content` the named CSS container (`container-type:inline-size; container-name:asset-library-content`) for stock layout queries. Stock CSS uses `@container asset-library-content (max-width:18rem)`, so CSS and ResizeObserver observe the same DOM box; the query and the observer both branch at 288px. Add `data-asset-library-source="stock"` while native stock is active and scope the existing unnamed cloud fallback to `:not([data-asset-library-source="stock"])`; no generic ancestor query may decide stock orientation.
- At exactly 288px content width the state is horizontal; at 289px it is vertical.

- Rail width: preserve the existing 3.35rem (approximately 54px) column at normal editor-dock widths.
- Each control: minimum 2.5rem × 2.5rem (40px × 40px), with a 44px effective hit area through padding or a 44px minimum where space allows. Keep the existing approximately 1.15rem mask glyph centered.
- Rail: vertical flex column, 0.14–0.28rem gaps, 0.2rem horizontal padding, thin vertical scrolling when eight entries exceed available height.
- Controls are icon-only visually. Each has a complete aria-label and tooltip such as “Business & Work — 6 clips”; no emoji, text pill, remote image, or provider logo is used.
- Selected state: existing JOY accent color, accent border/background, and inset inline-start accent bar. Hover/focus uses existing border/color treatment. In RTL, use logical properties so the selected bar remains on the rail-facing edge.
- Heading: retain “JOY stock videos” and “Curated clips for your next edit”; add selected category label as compact heading context (for example, “Nature”) and keep the count badge for that category. Do not repeat a horizontal category list.

Desktop/normal rail keyboard behavior and tab panel relationship:

- Use role=tablist, aria-label=Native JOY stock video categories, and aria-orientation=vertical.
- Each button uses role=tab, a stable id such as stock-video-category-{slug}, aria-selected, aria-controls=stock-video-panel, and roving tabIndex: selected is 0, all others -1.
- Use automatic activation: ArrowDown/ArrowUp moves focus with wraparound and immediately calls the same single setStockVideoCategory handler; Home/End do the same for the first/last category. Enter/Space reaffirms the focused tab and does not create a second activation path. Click/touch calls the same handler and focuses the activated tab.
- StockVideoDiscovery's root section is the sole panel with role=tabpanel, id=stock-video-panel, aria-labelledby=stock-video-category-{stockVideoCategory}, and tabIndex=0. There are not eight hidden panels; one panel displays the selected filter result. The panel relationship is therefore complete without duplicating catalog DOM.
- The ResizeObserver state is the sole stock-rail breakpoint: at content width <=288px, render the retained horizontal row with aria-orientation=horizontal and Left/Right plus Home/End; above 288px, render the vertical row with aria-orientation=vertical and ArrowUp/Down plus Home/End. CSS reads data-stock-rail-orientation, so DOM and visual axis change together.
- After automatic activation, focus remains on the selected button while the panel enters loading. Tooltips appear on hover and keyboard focus, and the accessible name remains available without relying on the tooltip.

### Category-to-icon semantic mapping

Add the mapping alongside ASSET_CATEGORY_ICONS in asset-library-icons.ts. Every source is bundled through icon-assets.ts and Vite; no remote URL is permitted.

| Stock category ID | Label | Local mask asset | Semantic rationale |
| --- | --- | --- | --- |
| business-work | Business & Work | ui/charts.png | Work/metrics signal for business use cases. |
| technology | Technology | asset/24_UI.png | Existing UI/technical glyph used in JOY's asset language. |
| people-lifestyle | People & Lifestyle | 24_socials.png | Existing people/community/social signal. |
| nature | Nature | 24_scenes.png | Existing scene/environment signal. |
| travel-places | Travel & Places | camera.png | Capture/travel signal already bundled in panel icons. |
| city-transport | City & Transport | asset/24_arrows.png | Direction/movement/route signal. |
| food-drink | Food & Drink | asset/24_creative.png | Creative elements signal where no food-specific glyph is bundled. |
| abstract-backgrounds | Abstract Backgrounds | asset/24_patterns.png | Pattern/background signal already used in the cloud rail. |

These are the locked semantic matches to the existing JOY icon set, not new pictograms. Do not substitute a different asset or introduce an external icon package in this redesign.

## Card and grid system

### Shared geometry contract

Grid modes use one fixed media frame for every orientation:

- stock-video-poster: aspect-ratio 16 / 9, width 100%, height auto through the frame, overflow hidden.
- Remove the portrait 9:16 CSS override entirely.
- Poster image: width/height 100%, object-fit cover, centered positioning. Portrait sources may crop at the sides; the orientation badge communicates source orientation and the preview remains uncropped in the dialog.
- Poster fallback occupies the same fixed frame with a neutral JOY surface. Its visible “Loading poster…” or “Poster unavailable” copy is intentionally visual-only (aria-hidden=true); the poster button's stable accessible name remains “Preview {title}” so a changing fallback cannot make the action name ambiguous. Poster loading/failure is covered by the focused visual-state check, not a second live announcement.
- Keep the orientation badge in a stable lower corner, with logical inset properties and sufficient contrast.
- In large/medium grid modes, .stock-video-grid:not(.stock-video-grid--list) .stock-video-card is a flex column with align-self:stretch and min-width:0. Its .stock-video-poster is flex:0 0 auto; its .stock-video-card-copy is flex:1 1 auto with min-width:0 and min-height:0; .stock-video-card-actions has margin-top:auto. This pins actions to the same bottom position for cards in a row.
- Titles are limited to two lines with a line clamp; provider/creator and technical metadata are one line with ellipsis. Full values remain available through title and accessible names.
- A card row stretches to the tallest card in that row. Because poster height, copy line counts, and action heights are bounded, portrait/landscape cards in one row have equal outer height. Do not use CSS columns or masonry.

Use min-height as a guard against transient poster/copy changes, not as a substitute for fixed structure:

- Large card: minimum approximately 15rem at the normal pane; title two lines, one provenance line, one metadata line, action row.
- Medium card: minimum approximately 12rem; compact two-column action row.
- List row: minimum 3.75rem; fixed thumbnail frame and one-line metadata.

Acceptance tolerances: in a rendered grid row, card outer heights differ by no more than 1px; poster frame heights differ by no more than 1px; no card becomes taller solely because orientation=portrait.

### Large view

Large is the reading/preview-forward mode.

- Grid: repeat(auto-fill, minmax(10.5rem, 1fr)), gap 0.55–0.65rem. At measured `.asset-library-content` width 300px, after the 53.6px rail, one comfortable column is expected; at wider reference-box widths, two columns are allowed.
- Poster frame is 16:9.
- Copy padding approximately 0.45rem; title 0.75–0.8rem; provenance/meta approximately 0.65rem.
- Actions stay in one row when the card is at least 10.5rem wide: Source link and Import to My media button, each at least 28px high. Import is visually primary.
- Use compact “Source” and “Import” labels with tooltips at every large-card width; never hide either action.

### Medium view

Medium is dense browse mode, not a miniature large card.

- Grid: `repeat(auto-fill, minmax(13.5rem, 1fr))`, with an exact `0.5rem` (8px) gap. At measured `.asset-library-content` width 300px, the existing 3.35rem (53.6px) rail leaves 246.4px. With 0.65rem (10.4px) inline padding on each side, grid content is 225.6px, which admits one 216px minimum track. At measured content width 560px, grid content is 485.6px: two 216px tracks plus one 8px gap require 440px, while three require exactly `3 × 216 + 2 × 8 = 664px`, so exactly two medium cards fit. This explicit minimum prevents `auto-fill` from admitting a third card at the 560px reference width.
- Same 16:9 poster frame; no portrait exception.
- Use slightly smaller copy with title clamped to two lines and provider/meta clamped to one line.
- Keep Source and Import in a single compact action row with minimum 28px control height, using exactly the visible labels “Source” and “Import”; each still has a complete accessible name, title, and visible focus ring. Do not stack two full-width actions.
- If a container is below 272px of grid content, the grid is explicitly one column before actions become unreadable.

### List view

List is the dense metadata/action mode. The card markup changes in PR 2: poster, copy, and actions are three direct children of each stock-video-card. Actions are no longer nested inside copy.

- In list mode, the later, more specific selector `.stock-video-grid--list .stock-video-card` sets `box-sizing:border-box; padding:0; border:1px solid var(--joy-border-subtle); display:grid; grid-template-columns:5rem minmax(0,1fr) auto; align-items:center; column-gap:0.45rem`. The first column is a fixed 5rem × 3rem landscape thumbnail; the second is copy; the third is the actions wrapper. At or below the exact <=20rem container breakpoint, the later narrow selector changes this to `3.25rem minmax(6rem,1fr) 3.8125rem` (52px + flexible copy + 61px).
- Thumbnail is always a fixed landscape frame; portrait source is cropped with object-fit:cover.
- Title, provenance, and metadata remain one-line ellipsized fields. Actions align to the inline end and remain visible on hover, focus-within, and keyboard navigation; import must not disappear for keyboard users.
- List rows must not inherit grid card minimum heights. The list selector is later in the stylesheet and more specific than the grid flex selector, so list cards remain grid cards.
- At measured `.asset-library-content` width 300px, the list grid area is 225.6px; the 1px border on each side leaves 223.6px inside the list card. The exact <=20rem rule uses `3.25rem minmax(6rem,1fr) 3.8125rem` and two `0.45rem` (7.2px) column gaps: 52px thumbnail + at least 96px copy + 61px actions + 14.4px gaps = 223.4px, leaving 0.2px inside the border-box. The action wrapper has `gap:0.25rem` (4px); its two `28px × 28px` icon-only controls therefore require 60px and fit within the 61px action column. Source uses the existing `ExportIcon` and Import uses the existing `UploadIcon` from `apps/editor-web/src/icons.tsx`; each control retains complete accessible name/title text while visible labels are hidden only at this compact breakpoint. Actions never move below copy.
- Orientation badge remains visible on the thumbnail. Source attribution remains a link with target=_blank and rel=noreferrer.

### Narrow editor-dock behavior

Use the measured .asset-library-content box as the sole product reference.

- At measured content width 300px (>288px), the 53.6px rail leaves 246.4px for main; 0.65rem (10.4px) discovery padding on each side leaves 225.6px grid content, so large and medium are one column.
- At measured content width 560px, the same calculation leaves 485.6px grid content and medium renders exactly two cards (2 × 216px minimum tracks + 8px gap = 440px; a third would require exactly `3 × 216 + 2 × 8 = 664px`). The browser fixture sizes the padded outer panel to 320.8px and 580.8px respectively so its 0.65rem + 0.65rem root padding yields exact 300px/560px content.
- At measured content width <=288px, the ResizeObserver data state moves the stock rail to the horizontal row and uses one content column. At 280px the fixture must assert this branch; the padded outer fixture width is 300.8px (280px content + 2 × 10.4px).
- Never create document-level horizontal overflow. Stock discovery scrolls vertically; the rail has its own thin scroll only when necessary.

## Data flow and component changes


### AssetLibraryPanel.tsx

- Import BrowserStockVideoCategory and the stock category list/type from control-plane-client.ts.
- Add distinct stockVideoCategory and stockVideoCategoryCounts state; existing AssetCategory category remains the top-level media type.
- Attach assetLibraryContentRef to the actual .asset-library-content element. Add the one ResizeObserver effect described in Stock category rail, measuring border-box inline width and disconnecting on cleanup/unmount.
- Write `data-stock-rail-orientation="horizontal|vertical"` and `data-asset-library-source="stock"` on `.asset-library-content` while native stock is active; the former is the sole DOM/CSS orientation state for the stock rail, while the latter prevents the legacy cloud fallback from competing with the named stock query.
- Add a merge callback that updates returned count keys without resetting selected category.
- In the existing asset-library-sidebar, branch on showingStockVideos: native stock renders eight inline stock-video-category-rail tabs using local masks, stockVideoCategory/counts, setStockVideoCategory, and the ResizeObserver-derived orientation/key axis; all other states render current collections unchanged.
- Pass controlled category, counts, and count callback into StockVideoDiscovery; it receives no category setter.
- Keep viewMode, query, onImport, and onStatus props and current import-success move to My media → Video.

### StockVideoDiscovery.tsx

- Remove internal category ownership and the horizontal category tablist.
- Accept controlled category, categoryCounts, and onCategoryCountsChange props; do not accept onCategoryChange.
- Make the root section the one role=tabpanel with id=stock-video-panel and aria-labelledby pointing to the selected rail tab.
- Move stock-video-card-actions out of stock-video-card-copy so each card has exactly three direct children: stock-video-poster, stock-video-card-copy, and stock-video-card-actions; this is required for list three-column layout.
- Add previewRequestSequence and previewOpenerRef. Increment on open and close; late preview results are ignored and any URLs created by stale requests are revoked.
- Continue existing catalog, request-sequence, lazy poster, same-origin preview/poster, attribution, and import-polling behavior. Keep all loading/error/empty/preview states and the three shared grid classes.
- Render six stable non-interactive loading skeleton slots with the same card frame dimensions; replace them when the request settles.

### asset-library-icons.ts and icon-assets.ts

- Add explicit STOCK_VIDEO_CATEGORY_ICONS keyed by exact eight IDs and resolved through iconUrl.
- Keep the existing bundled Vite import.meta.glob mechanism. A missing asset should fail the build as it does for existing masks.
- Do not add remote URLs or emoji fallback art.

### app.css

- Replace stock grid/card rules around current lines 428–603 with fixed-frame/equal-height geometry and remove the portrait poster aspect-ratio override.
- Add scoped stock-video-category-rail / stock-video-category-tab classes. Do not migrate the cloud collection selector's physical marker; cloud picture behavior remains unchanged.
- For vertical stock selection, draw the selected marker with a logical pseudo-element at inset-inline-start. When .asset-library-content[data-stock-rail-orientation='horizontal'], draw it at inset-block-end. CSS follows the ResizeObserver data attribute.
- Selector contract: .stock-video-grid:not(.stock-video-grid--list) .stock-video-card owns flex-column grid cards; poster is non-shrinking and copy has min-width:0/min-height:0. A later .stock-video-grid--list .stock-video-card owns list display:grid and 5rem minmax(0,1fr) auto columns.
- The <=20rem compact-list selector is later than base list selectors: it sets `box-sizing:border-box; padding:0; border:1px solid var(--joy-border-subtle)` and changes list columns to `3.25rem minmax(6rem,1fr) 3.8125rem`; the two grid gaps remain `0.45rem` and the action-wrapper gap is `0.25rem`. It hides visible action labels and retains 28px `ExportIcon`/`UploadIcon` buttons with title and aria-label. Keep all stock selectors scoped under stock-video-* or the orientation data attribute so owned asset-grid styles remain unchanged.
- Keep the base `.asset-library-content` composition as `display:grid; grid-template-columns:3.35rem minmax(0,1fr)`. Because a query container cannot restyle itself, add the direct state selector `.asset-library-content[data-stock-rail-orientation='horizontal'] { display:flex; flex-direction:column; }` and the explicit restore selector `.asset-library-content[data-stock-rail-orientation='vertical'] { display:grid; grid-template-columns:3.35rem minmax(0,1fr); }`. Keep descendant-only `@container asset-library-content (max-width:18rem)` rules for compact stock discovery/card details, and scope the existing unnamed <=18rem cloud rule to `.asset-library-content:not([data-asset-library-source='stock'])`. Verify no duplicate selector later in the file overrides the stock contract.

## Performance and failure behavior

- Keep the six-item category limit and do not prefetch poster blobs for unselected categories.
- Keep lazy poster hydration through IntersectionObserver; preserve URL revocation on card unmount and preview close.
- Category selection issues one catalog request through the existing browser client. Counts update from that response; no new provider calls are introduced.
- Search continues through useDeferredValue and the request cancellation sequence.
- Fixed frames and skeleton slots prevent layout shifts while posters resolve.
- Catalog error clears stale cards, announces concise native-library failure, and offers Retry. Retrying keeps selected category and query.
- Zero-result response shows explicit category/query empty state; it does not collapse the rail or card geometry.
- Poster failure leaves a same-size fallback and does not block Source or Import.
- Preview failure reports status without leaving a broken dialog or unreleased object URL.
- Import failure marks only that card as retryable; no duplicate import button or timeline action is added.
- Keep provider-neutral copy. Provider and creator are attribution metadata, and Source opens the supplied source page only.

## Accessibility

- Keep one semantic tablist for native stock categories and one selected tab. The selected tab owns aria-controls=stock-video-panel; the panel owns aria-labelledby back to that selected tab. Do not make the decorative rail container focusable.
- Provide an accessible rail label; each tab's accessible name includes category label and clip count. The visible icon is decorative with aria-hidden=true.
- Use roving tab index with automatic activation: vertical ArrowUp/ArrowDown/Home/End above 288px; horizontal Left/Right/Home/End at or below 288px. Enter/Space reaffirms the focused tab without another state transition. Preserve focus on the selected button while loading starts.
- Every poster remains a button with stable accessible name Preview {title}. Poster fallback copy is visual-only aria-hidden=true; no duplicate live status is emitted.
- Every Source link names provider and title. Every Import button names title and destination.
- Loading uses role=status and polite live text. Error uses role=alert with Retry. Empty state names active category and query. Importing disables only the relevant import action and exposes Importing…; failure restores Retry import.
- Preview is a modal dialog with aria-modal=true, stable title id stock-video-preview-title referenced by aria-labelledby, initial focus on Close, Escape/Close dismissal, focus containment between Close and the video element, and return to previewOpenerRef. previewRequestSequence plus mounted/cancel guard prevents late results reopening the dialog or leaking URLs after close/unmount.
- Maintain visible :focus-visible and approximately 40–44px pointer targets for rail and compact actions. Do not encode orientation only by color; retain Portrait/Landscape badge and accessible media metadata.

## Focused verification plan

This intentionally avoids a long broad regression run. Keep source invariants in Vitest and use one dedicated browser spec for real layout/keyboard behavior.

1. Add tests/e2e/stock-video-ui.spec.ts. It is the only browser spec for this redesign. It uses playwright.config.ts project desktop-minimum, whose webServer starts tooling/e2e-server.ts and the editor Vite server. beforeEach adds joy-media-e2e-token to localStorage as authenticated-project-library.spec.ts does; the spec creates/opens one disposable project through the existing UI. Immediately after `openDisposableWorkspace()`, read `localStorage.getItem('joy-media.active-project.v1')`, parse it, require `{version:1,projectId:<non-empty string>}`, and store that value as `activeProjectId`; a malformed/missing value fails the fixture. Register a request listener before opening the asset panel: for every URL matching `/api/v1/projects/{id}/...`, decode the path segment and assert `id === activeProjectId` (fail if it changes), then use that same value in every project-scoped mock.
2. Before opening the asset panel, install deterministic page.route handlers:
   - `page.route('**/api/v1/library/my-assets**', ...)` validates `new URL(route.request().url()).pathname === '/api/v1/library/my-assets'` and reads `url.searchParams.get('projectId')`; the unscoped initial response is `{data:[]}`. The project-scoped response is `{data:[completedAsset]}` only when `projectId === activeProjectId`, where `activeProjectId` is read and validated from `joy-media.active-project.v1` after `openDisposableWorkspace()`; any other project query throws.
   - `page.route('**/api/v1/library/cloud-assets', ...)` returns `{data:[]}` and asserts the expected project query when present.
   - `page.route('**/api/v1/library/stock-videos?*', ...)` handles only the catalog URL (poster/preview use their own more-specific matchers), validates `url.searchParams.get('category')` against the exact eight IDs and `url.searchParams.get('q')` against the fixture query, and returns `{data:{items:[six mixed-orientation records],counts:{all eight IDs}}}` plus controlled delayed/zero/error variants.
   - `page.route('**/api/v1/library/stock-videos/*/poster', ...)` returns a deterministic image Blob; one fixture ID returns a controlled non-2xx poster failure.
   - `page.route('**/api/v1/library/stock-videos/*/preview', ...)` returns a deterministic video Blob; stale-preview delays this response after modal close.
   - `page.route('**/api/v1/projects/*/stock-video-import', ...)` asserts POST JSON `{catalogId}` and returns `{data:{importId:'stock-import-1',state:'claimed'}}`.
   - `page.route('**/api/v1/projects/*/stock-video-imports/stock-import-1', ...)` returns exactly `{data:{importId:'stock-import-1',state:'completed',assetId:'imported-stock-1'}}`. The primary journey therefore exercises the production assetId fallback rather than a nested asset response. `completedAsset` is the complete valid BrowserAsset returned by the matching project-scoped my-assets route: `{id:'imported-stock-1',projectId:activeProjectId,kind:'video',displayName:'Imported stock fixture.mp4',sha256:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',bytes:1024,descriptor:{mimeType:'video/mp4',durationUs:3000000,width:640,height:360},createdAt:1700000000000,cloudBacked:true}`. The hash is exactly 64 hex characters; bytes, dimensions, and duration are positive; createdAt is a nonnegative integer; and the test asserts `completedAsset.projectId === activeProjectId`.
   - Any other stock request throws in the route handler. Record intercepted stock requests and assert none falls through to the e2e server's unconfigured `STOCK_PROVIDER_UNAVAILABLE` path. No provider endpoint, key, or production data is reachable.
 3. Size the exact `.asset-library-content` reference box, not the outer Dockview/panel: fixture CSS accounts for the existing 0.65rem + 0.65rem outer padding (20.8px at the 16px root), so set padded outer border-box width to 320.8px for 300px content and 580.8px for 560px content. Set parent flex `min-width:0; overflow:hidden`; set `.asset-library` and `.asset-library-content` to `box-sizing:border-box; width:100%`. Before assertions read `getBoundingClientRect().width` for `.asset-library-content`, `.asset-library-sidebar`, and `.stock-video-discovery`; assert the content box is 300px/560px (±1px), never infer from viewport or outer width.
 4. At 300px content width assert 53.6px rail, 10.4px discovery inline padding each side, approximately 225.6px list/grid area, one large/medium column, computed `.asset-library-content` display `grid` with exactly two computed tracks whose first track is approximately 53.6px, and separate overflow bounds: documentElement, `.asset-library`, and `.asset-library-content` each have `scrollWidth <= clientWidth`. In list mode assert the card border-box is 225.6px, inner width is at least 223.6px, thumbnail is 52px, action wrapper is 61px, each icon-only control is 28px × 28px, action gap is 4px, and copy clientWidth is at least 96px.
 5. At 560px content width assert approximately 485.6px grid content, computed medium `grid-template-columns` has exactly two tracks, exactly two medium cards are rendered, and visible list labels remain above the <=20rem compact boundary.
 6. Resize that same fixture element so the measured `.asset-library-content` becomes 280px (padded outer width 300.8px), await two animation frames plus ResizeObserver delivery, and assert measured width <=288px, `data-stock-rail-orientation=horizontal`, `aria-orientation=horizontal`, computed `.asset-library-content` display `flex` with `flex-direction:column`, horizontal rail layout, and Left/Right activation. Restore the padded outer width 320.8px, assert content returns to 300px, computed display `grid` with the vertical grid columns, and ArrowUp/Down activation. This proves resize crossing on the same box that drives CSS and runtime orientation.
7. In both widths assert every poster has the same computed 16:9 frame regardless of orientation, common-row cards differ by at most 1px, actions occupy the bottom row, and text does not overflow.
8. Exercise rail mouse and automatic-activation keyboard paths (ArrowUp/Down/Home/End, selected tab, aria-controls/tabpanel relationship), one RTL assertion for the scoped selected marker, and compact smoke states: loading, zero-result, catalog error + Retry, poster failure visual fallback, modal open/close/Escape/focus return/stale-result suppression, import busy, and import failure + Retry. Keep one mixed-orientation fixture and do not duplicate existing client behavior suite.
9. Run the exact narrow commands from repository root:
   
       pnpm exec tsc --noEmit -p apps/editor-web/tsconfig.json --pretty false
       pnpm exec eslint apps/editor-web/src/AssetLibraryPanel.tsx apps/editor-web/src/StockVideoDiscovery.tsx apps/editor-web/src/asset-library-icons.ts apps/editor-web/src/icon-assets.ts
       pnpm exec vitest run apps/editor-web/src/stock-video-ui-contract.test.ts apps/editor-web/src/stock-video-client-contract.test.ts apps/editor-web/src/stock-video-contract.test.ts
       pnpm exec playwright test tests/e2e/stock-video-ui.spec.ts --project=desktop-minimum --workers=1

   apps/editor-web/tsconfig.json contains project references, so tsc can type-check referenced workspace packages as required; that unavoidable breadth is documented here and is not a request to run root pnpm typecheck. ESLint and Vitest are path-bounded; Playwright runs one spec/project with configured disposable servers.
10. Review source diff and changed-path manifest: no API/provider/backend/storage/deployment file changed. Do not run the repository's full test matrix, a long soak, production browser automation, or live deployment as part of this UI plan.

## Acceptance criteria

The redesign is ready for owner review when all of the following are true:

- Native stock video uses the existing left asset rail; there is no nested second rail and no horizontal stock category pill row.
- Exactly the eight stable category IDs are represented by distinct icon-only controls using local bundled masks.
- The normal rail is vertical, scrollable when necessary, has selected/focus/tooltip states matching cloud picture collections, and supports accessible roving keyboard navigation.
- Large, medium, and list views render without document-level horizontal overflow at measured `.asset-library-content` width 300px.
- Portrait and landscape cards use the same fixed grid poster frame. In a mixed row, computed poster and card heights differ by no more than 1px.
- Card actions remain at a stable bottom position; Source attribution and Import to My media are present and usable in every view. Importing, failed import, and Retry import are communicated per card.
- Titles, provider/creator attribution, duration/dimensions, orientation badge, and source links are retained with sensible truncation and accessible names.
- Loading, error, empty, poster-failure, preview, and import states retain current semantics and do not create large layout jumps.
- Existing shared view-mode persistence and import-to-My-media flow are preserved.
- Focused tests pass and the changed-path manifest is exactly this allowlist: implementation/style files `apps/editor-web/src/AssetLibraryPanel.tsx`, `apps/editor-web/src/StockVideoDiscovery.tsx`, `apps/editor-web/src/asset-library-icons.ts`, and `apps/editor-web/src/app.css`; focused tests `apps/editor-web/src/stock-video-ui-contract.test.ts` and `tests/e2e/stock-video-ui.spec.ts`; no helper file is planned or allowed.
- No provider credentials, owner browser profile, user media, secrets, runtime deployment, or unrelated broad refactor is involved.

## Rollout and rollback boundaries

This is a client-only UI change. The implementation PRs stop at focused checks and owner acceptance. There is no database migration, API versioning, provider configuration, storage migration, worker change, service restart, or release metadata change.

After the no-code owner acceptance gate, any release is a separate owner-run task with its own approval, web artifact, VPS-origin verification, rollback decision, and required redacted Gbrain completion record. No deployment, service restart, VPS check, export, or Gbrain receipt occurs as part of this plan or its implementation PRs.

The safe rollback boundary is the last known-good editor-web commit/bundle: the owner may revert the focused UI PR or redeploy the prior web artifact only in that separate release task. Do not roll back backend/provider facts or alter imported media to undo a visual change. Plan completion does not imply runtime deployment or production acceptance.

## Locked next-agent implementation goal and guardrails

Implementation goal: in the named editor-web worktree, replace the native stock-video horizontal category pills and variable-orientation grid with the controlled shared-rail/category contract and fixed-frame/equal-height card system described here, while preserving current provider-neutral data and import/preview behavior.

Guardrails:

- This document is a plan, not implementation authorization. The owner must separately approve code changes and any later release.
- No lane may implement, commit, push, deploy, restart a service, access an owner browser profile, or read production credentials without explicit owner approval.
- If SuperPlane or independent agents under C:\Users\HadiMoti\Desktop\HadiPc-Agents are used, they are advisory/evidence lanes only. Treat Cline and Kilo as repository-evidence lanes only after a read-only source snapshot; treat dynamic OpenRouter and unavailable NVIDIA lanes as context-only critics, never acceptance voters.
- Any subagent used in the implementation plan must use gpt-5.6-luna only. The owner orchestrator independently verifies claims; a successful pipeline process is not acceptance evidence.
- Advisory workers must receive bounded, read-only, redacted context. They must not receive secrets, owner cookies, browser auth state, raw provider output, or user media.
- Preserve the user's dirty worktree and data. Do not use destructive Git commands or broad test/cleanup commands.
- Keep verification focused on affected package/tests and the two rendered layout widths. Do not broaden into a repository-wide test campaign.
- Do not change STOCK_VIDEO_CATEGORIES IDs, provider/backend/storage contracts, source-page attribution, same-origin poster/preview behavior, or six-item limit.
- Before implementation, consult the authenticated VPS Gbrain brief and the SuperPlane advisory plan. At completion of an authorized change, the owner orchestrator—not a subagent—handles any required redacted Gbrain completion record/export.

## Key Decisions

1. Repurpose the existing asset rail instead of adding a nested rail. The panel already owns the sidebar and top-level Video context; a second rail would consume the narrow dock and create competing selection models. Reusing the rail gives stock video the same mask, focus, selected, and tooltip language as cloud picture assets.
2. Hoist only stock category selection/counts. Requests, poster hydration, preview, and import remain local to discovery, minimizing prop surface and preserving current async guards while making the rail the single category owner.
3. Use one 16:9 fixed media frame for both orientations in grid modes. The current 9:16 portrait override directly creates uneven rows. object-fit:cover preserves a stable catalog scan; the orientation badge and full preview preserve meaning.
4. Use flex-bottom actions and bounded text. A fixed poster alone is insufficient when titles/providers vary. Two-line title clamp, one-line metadata, flex copy, and margin-top:auto keep actions aligned.
5. Keep list thumbnails landscape and fixed. List mode is for metadata density; a variable portrait thumbnail would reintroduce row drift and waste horizontal space.
6. Use nearest existing JOY masks rather than introducing an icon dependency. Local Vite-bundled masks avoid remote UI, cache drift, and provider branding while matching the existing cloud rail.
7. Keep native stock as a cloud-video state, not a new asset source. This preserves existing source switching, search, shared view preferences, and post-import reveal behavior.
8. Use focused verification only. The risk is localized layout/state integration. A small contract suite plus three reference-width rendered checks gives useful evidence without claiming broad regression or production acceptance.

## Open Questions

None remain that require an owner decision for implementation. The eight icon mappings and fallback behavior are locked for this plan.

## PR Plan

1. PR 1 — Define native stock category rail contract and local masks
   - Affected: apps/editor-web/src/AssetLibraryPanel.tsx, apps/editor-web/src/StockVideoDiscovery.tsx, apps/editor-web/src/asset-library-icons.ts, focused contract tests.
   - Dependency: none.
   - Changes: hoist category/count ownership, add eight-key local icon map, render stock rail in existing sidebar, remove internal horizontal category tablist, and keep shared viewMode/search/import contracts.

2. PR 2 — Normalize stock-video card geometry across orientations and views
   - Affected: apps/editor-web/src/app.css and apps/editor-web/src/StockVideoDiscovery.tsx (the latter is required for the three-sibling card DOM).
   - Dependency: PR 1.
   - Changes: remove portrait aspect-ratio override; add fixed 16:9 frames, equal-height flex cards, stable bottom actions, large/medium/list measurements, container-query fallback, truncation, focus, and no-overflow rules.

3. PR 3 — Add focused stock-video UI verification
   - Affected: `apps/editor-web/src/stock-video-ui-contract.test.ts` and `tests/e2e/stock-video-ui.spec.ts`. No helper file is planned.
   - Dependency: PRs 1 and 2.
   - Changes: keep source/key/ownership invariants in the Vitest contract and add one deterministic mocked Playwright spec for measured 300px/560px/280px layouts, 300px list action bounding boxes, resize-crossing rail behavior, keyboard/tabpanel semantics, RTL marker, and compact loading/error/empty/preview/import states.

4. PR 4 — Owner acceptance gate (no code)
   - Affected: none. This is a review/acceptance record, not a code or artifact PR.
   - Dependency: PR 3 focused checks.
   - Changes: owner reviews the diff, focused browser evidence, acceptance criteria, exact allowlist, and guardrail compliance; records accept/reject and any follow-up fixes. PR 4 validates that every changed path is in the allowlist above and that no helper or test outside it was added. It must not alter source, release metadata, web artifacts, deployment state, VPS state, or Gbrain.
   
Any later release is a separate owner-run task after PR 4, outside this PR plan. That task—not this plan—may perform the normal web release, VPS-origin check, rollback choice, export, and Gbrain completion record after separate authorization.
