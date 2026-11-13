# JOY Media v1.1.1 (DRAFT)

> **Draft for CC to finish.** This draft lists only work merged on this branch. Anything not yet seen in a real window is in the **Still to check** list at the end, and it is not presented as checked.
>
> **Drafting note (remove before publishing):** The quality check (Joy Code reading pictures and video frame by frame) and generated pictures and videos are **not** in this draft. Their work is not merged on this branch.

JOY Media is a local desktop video editor for Windows. Everything from v1.1.0 is still here: no account, no server, and projects, media and exports stay on your computer.

## What is new

### Clearer words and names

- The app uses one name everywhere: JOY Media.
- Menus, buttons and messages use plain words. Shortcuts show Ctrl.
- Clips, tracks, captions and motion items show their names, not ID numbers. Most History labels (the undo list) do the same.
- Icons and tab labels were redone. A tab that shows only an icon now has a name.
- Clips are coloured by type, so you can tell them apart on the timeline.
- Confirm and prompt boxes now match the app's look, in 12 places.
- Each panel has one empty-state message. The timeline has a short hint.
- Settings use plain English. The Asset Library Storage window is finished.
- Only one popup is open at a time.
- Menus and dialogs now animate. Reduced motion is respected.

### Monitor

- Zoom with the mouse wheel or with keyboard shortcuts. The picture stays sharp while you zoom.
- Hand tool: hold Space or the middle mouse button to move around the picture. A navigator shows where you are.
- Click on the monitor to select a clip.
- Draw a box around a clip on the monitor to move, scale and rotate it. Groups can move together.
- Overlays: safe areas, grid, rulers, guides, a background colour and a preview overlay.

### Colour

- A new colour engine: the grade works on the whole picture.
- Colour wheels.
- A curves editor.
- Colour ranges (HSL bands) and an eyedropper.
- Scopes are in one place. They can float in their own window, and reset with undo.

### Transitions and effects

- 38 transitions in 8 categories.
- Each filter and effect has one home in the library. Items that appear in more than one place have an "Also in" link. Favourites move over.

### Format and export

- One Format control in the header. The read-out on the monitor opens the same menu.
- Export uses the canvas size you set.

### Joy Code

- Every Joy Code failure shows a plain message. No raw technical text reaches the chat.
- You cannot start a request until a model is connected. The Run button is off, with a short reason.
- The first time you open Joy Code, it is collapsed and shows one calm "Connect a model" card.
- Joy Code settings use the same look as the rest of the app.

### Files dropped from Windows

- Drag files from Windows onto the timeline, the monitor or the Media panel.
- A drop on the timeline adds clips. A drop on the Media panel only imports the files.

### 3D

- The 3D tab has its own icon, and the 3D scene sits in a framed card.

## What was fixed

- **Crop now cuts the picture,** in the monitor and in the export.
- **Export uses the canvas size** you set in the Format control.
- **Joy Code messages** are plain. Raw error text no longer reaches the chat.
- **Raw IDs removed** from most labels for clips, tracks, captions, motion and Dual Lens.

## How to install and check

1. Download `joy-media-setup.exe` from the release page. The release page also has `joy-media-windows-x64` (portable copy), `SHA256SUMS.txt` and the other files listed there.
2. The files are **not code-signed**, so Windows shows a warning when you download or run the setup. Check the download first. In PowerShell, run `Get-FileHash .\joy-media-setup.exe` and compare the result with the `joy-media-setup.exe` line in `SHA256SUMS.txt`. They must be identical.
3. Run the setup. It adds JOY Media to your Desktop and Start Menu.
4. **After upgrading from v1.0.2,** the Desktop shortcut may keep its old icon for a while. Windows keeps a copy of icons (the icon cache). If the old icon stays, restart the PC.

There are no automatic updates. Download a new version yourself.

## Known limits

- **Unsigned.** See "How to install and check" above.
- **GPU crash, cause unknown.** An NVIDIA hardware-encoder crash (the GPU process exiting during an export) was seen on one machine before v1.1.0. It has not been seen again in the checks we ran, and its cause was not found. If the GPU process exits, the app restarts once with a safe encoder setting.
- **High memory on long exports.** A 10-minute export used up to about 8.3 GB of memory on a PC with 64 GB (measured for v1.1.0). Close other large programs before a long export.
- **Export leaves a staged copy.** Each MP4 export can leave a hidden working copy in the asset library, named `<export name>.mp4.stage`. Delete it from the Assets panel with the card's Delete button. It does not change the exported file.
- **Providers.** ChatGPT sign-in was tested end to end in v1.1.0. Kimi and xAI sign-in exist, but their model answers were not verified. MiniMax sign-in was removed.
- **Export presets differ.** The app has 5 export presets and the command line has 3. The same request can give different files.
- **Some effect previews are wrong.** 14 of the 33 effects play the wrong short preview, and 11 effects appear twice in the Effects panel.
- **No Fit or Fill for a clip yet.** Only the monitor's view ratio can change.
- **Some items are missing from menus.** Several panels are not in the View menu, and the Clip menu has fewer items than planned. The command list writes the undo shortcut differently from the menus; the key is the same (Ctrl+Z).
- **Some effects and tools are limited.** A mask works only in the background worker, not on the timeline. Picture-in-picture has no button. Audio ducking works only through Joy Code. The lower third is an HTML template. The Templates panel has no motion type.
- **Guides are mouse-only,** and the vertical ruler has no numbers.
- **One template subtitle** still says "New tools for JOY Studio." It is kept so saved scenes do not change.
- **Some History labels** still show internal names (for marker, effect, speed-ramp and transition actions).
- **Web version only:** Cancel during a file drop may still add the file. The desktop app is not affected.
- **Custom endpoints.** A private IPv6 address form (ISATAP, some NAT64 and 6rd prefixes) still passes the address check. This was accepted for this release and predates v1.1.0.
- **Project folders are not in this version.** Projects are saved in the app's library as before. Folder projects are planned for v1.2.

## Still to check

These items are **not yet checked on screen**. Do not present them as verified until they are.

- Dialogs, empty states, the first-run Joy Code card and the Connect card: not yet checked on screen.
- Menu and dialog animation, and reduced motion: not yet checked on screen.
- Zoom, hand tool, click to select, the transform box and rotation on the monitor: live check pending.
- Overlays and guides, and whether overlays stay out of the export: live check pending.
- Crop in the monitor and in the export: pixel match pending.
- Colour engine on a GPU, and old projects compared with the old colours: pending. "Hold to compare" is not checked.
- Format: frame rate and background controls are still open. Real export size check pending.
- Drops from Windows onto the timeline, monitor and Media panel: live drop test pending.
- Joy Code: "no run without a model" and the first-run layout: live look pending.
- Layout per workspace preset (Edit, Automate): saved layout not yet checked.
- Open folder button in Asset Library Storage: not yet clicked on a real folder.
- Icon buttons in Joy Code settings and across the app: colours not yet checked on screen.
- **Effects in the exported file:** the code shows only 4 of the 33 effects with an export path. Until it is checked, do not say that all effects appear in exports. If it is confirmed, it is a blocker.
- Canvas and export preset: the defect log still lists two controls. Confirm that one Format control is enough.
- Shift+Space starts playback, and double-click in Hand mode returns to Fit: fix in progress.
- Audio pill truncation at the gutter width: not seen on screen.
- Icon cache: the "restart the PC" fix is not tested.
- Installer: install over v1.0.2, open, close, uninstall and offline use are not yet run for v1.1.1.
- Provider live checks (ChatGPT, Kimi, xAI, and the command line) are not yet run for v1.1.1.
- Memory use on long exports and the staged-copy limit: not measured again for v1.1.1.
- GPU crash note: confirm it is still current.
- File names, sizes and SHA-256 values on the release page: confirm at release.
- Quality check and generated pictures and videos: not merged on this branch. Do not list them as new until they are merged and checked.
