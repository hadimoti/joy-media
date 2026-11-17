# JOY Media v1.1.1

JOY Media v1.1.1 is an update to v1.1.0. It is still a local desktop video editor for Windows, with no account and no server. This version adds Monitor tools, a full colour panel, real thumbnails and waveforms on the timeline, and many fixes found by using the app by hand.

## Monitor and colour

### Monitor

- Zoom the Monitor with the mouse wheel, from 10 percent to 800 percent. The zoom goes toward the pointer.
- Ctrl+0 fits the picture. Ctrl+1 shows it at 100 percent. Ctrl++ and Ctrl+- zoom in and out.
- Hold Space and drag to move the picture. It does not start playback.
- Click a clip in the Monitor to select it. A box appears with handles to scale and rotate it.
- With a clip selected in the Monitor, the arrow keys move it by one pixel. Shift+arrow moves it by ten.
- Fit and Fill buttons put a clip into the frame.
- When you change the canvas (for example 16:9 to 9:16), JOY Media asks how to reframe the clips: Fit, Fill or Keep positions. Undo returns the old canvas.

### Colour

- The Colour panel has wheels, curves, HSL bands with an eyedropper, six looks, and a LUT amount.
- A grade can be set for the whole output or for one clip, and the Monitor shows it.
- Every colour control can be reset, undone, keyframed and saved with the project (checked in tests).

### Filters, effects and transitions

- Each filter and effect is tested one by one against a real picture.
- Filters and effects each have one home. The 20 items that appeared in both lists now appear once.
- There are 38 transitions in 8 groups: Basic fades, Wipes, Slides and pushes, Zooms and spins, Shapes and masks, Glitch and digital, Light and glow, Creative. 35 pass every check. The three that do not are listed under known limits.

## Timeline

- Clips have a colour by type: video, audio, text, effect.
- Video clips show small thumbnails. Audio clips show a waveform. Thumbnails are whole tiles only, and they hide on clips that are too narrow.
- The sound of each video clip shows as a strip on the first audio row. This is display only. You cannot move or edit the strip. Strips of clips that play together are drawn in separate bands.
- The column with track names can be resized by dragging. Double-click the edge to reset it. The width is remembered.
- Audio rows are at least 56 pixels high. The track headers stay in view while you scroll.
- When you drag clips, a dashed ghost shows where they will land. A red ghost means the drop is refused, and a message says why. A clip dropped on a taken spot lands at the nearest free spot of that row. A group keeps its shape.
- Ctrl+C, Ctrl+X and Ctrl+V work. Paste lands at the earliest free spot after the playhead, and the clips keep their distances.
- Ctrl+D duplicates every selected clip. Shift+click extends the selection.
- Timeline keys: V select tool, B split tool, M marker, T add visual track, A add audio track, N snapping, = and - zoom, Shift+Z fit, Shift+F freeze frame, Shift+R reverse, Shift+Delete ripple delete, Ctrl+I import media. The Keyboard Shortcuts dialog lists them.
- The track colour menu is a small row of dots.
- The eye button on a track now hides text and stickers too, in the picture and in the export.

## Text and captions

- Text and stickers draw over the video, and only while their clip plays.
- A gradient on text has a start dot and an end dot in the Monitor. Drag either dot, also outside the text.
- Clicking a colour swatch opens a colour picker: a square, a hue bar and a hex field. It replaces the old colour input in Text, Captions and the Inspector.
- Captions are drawn in the Monitor and in the export as soon as you add the first caption track. The panel switch can turn this off. Caption styles Clean, Karaoke Pop and RTL Classic and the size slider work.
- Auto captions use the selected clip, or the clip under the playhead if none is selected. The words are placed where the clip plays, with its trim and speed. Auto captions need a speech-to-text provider that you connect in Joy Code Settings.
- Caption sliders keep the value inside their range.
- The Inspector names a text clip by its words, not by an id.

## Joy Code

- Every failure has a plain message that says what happened. If the provider gave a reason, the message keeps it.
- Joy Code does not start a run when no model is chosen.
- A sign-in that stopped can be started again.
- Joy Code Settings use one layout. The temperature and token fields are replaced by an effort level: Auto, Low, Medium or High. Older saved numbers show as Custom.
- The model list loads as soon as you choose a provider. The model field stays off until then.
- A custom endpoint needs one tick to confirm that you trust it.
- Joy Code opens as wide as the Inspector column.

## Files and projects

- The Projects page scrolls, has window buttons, and can be used to drag the window. The format picker no longer pushes Create and Cancel off the screen.
- Drag files from Windows onto a timeline lane, onto the area under the tracks (this makes a new track), onto the Monitor, or onto the Media panel. A locked track refuses the drop. A dashed outline shows the target.
- Dropping on the Media panel only imports. It does not place clips.
- The import message counts only new files: "N files added to the media library, M already there."
- A project reopens with the playhead where you left it.
- A saved project reopens with the same clips, tracks, titles, captions, curves and markers.
- Export MP4 was checked on a 71-second project: H.264 1920x1080, AAC stereo, it decodes without error, and six frames match the Monitor.

## Fixes

### Pictures and effects

- The Monitor was black whenever the project had a colour grade. Fixed.
- A grade with a value such as Exposure +0.45 turned the picture into blue and magenta bands. Fixed.
- Clip colour grades did nothing in the app. Fixed.
- Curves came out too dark and tinted. Fixed.
- The Monitor kept the last video frame over a gap. It now shows the background.
- Eleven effects drew nothing in the preview, and now draw: Pixelate, Mosaic, Radial Blur, Tilt Shift, Bayer Dither, Halftone, Contour Map, Glyph Matrix, Scatter Mosaic, Tone Geometry, Pixel Sort.
- Nine effects had no picture at all and now work: Color Overlay, Curves, Bulge, Twist, Ripple, CRT, Edge Detect, Emboss, Unsharp Mask.
- Bloom now adds a glow around bright areas, and its Threshold slider works. Before, it blurred the whole picture.

**Saved projects can look different.** These change the picture of an existing project: Bloom, Sepia, Vibrance, Brightness / Contrast (when not at 0), Hue / Saturation (when saturation is not 0), and the nine effects listed above. In every case the old picture was wrong, blank or missing.

### Editing

- S, Ctrl+D, N and Ctrl+Z did nothing after you clicked a clip. Fixed.
- The snapping button and the N key did nothing. Fixed.
- Shift+Delete deleted without closing the gap. Fixed.
- Setting a clip to 2x and back to 1x made it one microsecond longer, and the change was refused when the next clip touched. Fixed.
- Plain Left and Right now move a selected clip by one pixel, and step the playhead when nothing is selected.
- Dragging an effect or filter card onto a clip no longer starts the browser's picture drag.
- The Monitor zoom keys Ctrl+0, Ctrl+1, Ctrl++ and Ctrl+- did not work. Fixed.

### Menus and panels

- Header menus open one at a time. Escape closes a menu and returns focus to its title.
- The command palette opens empty each time.
- The Clip menu has Split at Playhead, Duplicate Clip, Delete and Speed. The Edit menu has Cut, Copy, Paste and Delete.
- Every dock tab has its own close button. A closed panel that is listed in the View menu reopens in its old place.
- Monitor footer controls are no longer cut at the bottom.
- Settings left tabs can no longer scroll out of sight.
- Connection sections in Settings show the right arrow when closed and down when open.
- Library panels have no description lines. Cards have a plus button only.
- Asset view icons: large previews are four squares, the compact grid is nine small squares.
- On a 16-inch laptop screen the app window moved a few pixels up, down and sideways while you worked. It no longer does. Only the Inspector list scrolls.
- The New project form fits a small screen. The Project name field and the Create button are visible, and the format cards lay out in a grid.
- The timeline right-click menu shows only keys that work, and empty divider lines no longer leave blank rows.
- The timeline right-click menu opens on top of the panel, so a menu opened near the bottom of a small window is no longer cut.
- Full screen works. The F key and View > Toggle Full Screen did nothing before.
- J (reverse) and the faster speeds now move the playhead. Before, reverse never moved.
- Window > Focus puts the keyboard inside the panel, not only the panel in front.
- Adding a template to the timeline asks first, with a "Don't ask next time" tick.
- The Automate workspace has a Workflows tab beside Joy Code and Jobs.
- Joy Code Looks: a Look can no longer be bound to the invisible Null object, which made the preview fail with "The preview could not be prepared". The approval card names the change and the time in seconds.
- Joy Code Settings: the custom endpoint tick stays valid after the connection is saved, a profile chosen for an agent slot is no longer lost while its models load, and Suggest only shows no Approve button.
- Undo of a track colour or track family works, and the track header follows.
- A colour-graded clip inside a transition kept no size, so the transition picture could come out wrong or blank in the Monitor and in the export. Fixed.
- A long export (10 minutes) failed after about 12 minutes with "worker lease expired": the export helper stopped reporting while it finished the file. Fixed; a 10-minute 1080p export now completes.
- The 4K export preset failed at the final check ("decoder policy"). Fixed.
- Cancelling an export of an H.264 or a WebM clip stops it, frees the Export button and keeps no file.

## Known limits

- **Unsigned.** The files are not code-signed, so Windows shows a warning when you download or run the setup.
- **GPU.** An NVIDIA hardware-encoder crash was seen on one machine before v1.1.0. Its cause is not known. The graphics card path of the colour engine is not yet checked on screen.
- **Icon cache after upgrading from v1.0.2.** The Desktop shortcut can keep its old icon. This is the Windows icon cache, not JOY Media.
- **Providers.** Kimi and xAI model answers and the Get a key and API docs links on the provider cards may not work as expected.
- **Export.** The command line has 3 export choices (MP4, WebM, ProRes). The app has 5 presets, so the same request can give different files. Some effects may not appear in exported videos.
- **Effect previews.** Some effect cards play the wrong preview loop, so the card may not show the effect as it looks.
- **Sample project export.** Exporting one sample project can fail with "cannot resolve visual asset".
- **Some drags.** One clip dragged from the asset panel showed on the timeline but was missing from the saved project; this is not yet explained. Dropping an image from the Asset Library onto the filter layer can do nothing, with no message.
- **Export size.** Export size may follow the selected preset instead of the canvas size.
- **Projects page when maximised.** The bottom of the Projects page can sit behind the Windows taskbar.
- **Persian and Arabic text is not finished.** Right-to-left shaping and line direction are not correct in titles or captions in the video. This is planned for a later version.
- **Transitions.** TV Static uses random noise, so the preview and the export cannot match. Kaleidoscope and Ripple: the Speed option showed no change in the test (open). Slide and push transitions are tested with a looser limit for the last frame. Full table: `docs/qa/v1.1.1/TRANSITIONS.md`.
- **Video clips have no fade.** There are no opacity fade handles on video. Audio fades are set in the Audio panel.
- **No Detach audio.** The Clip menu cannot split the sound of a video clip into its own audio clip. The audio strips on the first audio row are display only.
- **Dual Lens Time View has no audio strips.**
- **Dragging a clip out of JOY Media to Explorer is not offered.**
- **Text from templates is placed by its top edge**, while the Inspector counts from the centre. Position Y 540 draws the text about half a height low.
- **Text gradients use anchors.** There is no angle field and no "reset anchors" button.
- **Smart guides, snapping while you move on the Monitor, text editing in place, crop handles and the right-click menu on the Monitor** are planned for v1.1.2.
- **Joy Code can run a quality check on the open project** (it samples frames of the composition on this computer and reports findings; asked in words, for example "run a quality check and fix the problems"). It measures where titles and captions sit on a check-only copy of the renderer and says when text could not be measured. It cannot yet make pictures or videos.
- **Very long exports use a lot of memory.** A 10-minute 1080p export finishes (about 15 minutes on the test laptop) but the app can use about 4 GB while it runs. Shorter exports use far less.
- **Quality check repairs.** When the check finds a title or caption outside the safe area, Joy Code prepares one plan that moves it back; you approve it and one Undo restores the project. This is tested in code but was not yet seen live in the app. A title that is hard to read is reported but not repaired automatically. The quality check card is not kept after a reload; only its summary line is.
- **Glow** still blurs the whole picture. **Vibrance** is slightly different in the preview and in the command-line render. The Tone Geometry Angle slider does nothing until a shape other than Circle is chosen.
- The HSL band names do not match their centre angles (Yellow shows 90 degrees, Green 135).
- The Track Lock button keeps the same name when locked. Its state is shown only to screen readers.
- Guides on the Monitor work with the mouse only.
- The web build of the drop progress Cancel button cannot stop the file that is being imported. The desktop app is not affected.
- **Position X** uses offsets from the centre for picture clips and pixels for text clips, so the same number can mean different things.
- **Small items, not yet fixed:** the vertical ruler on the Monitor has no numbers; Alt+arrow scaling at the smallest size can change a box's shape; the Monitor's frame-step keys are not in the command palette; the command palette shows a different Undo shortcut from the menus; the View menu cannot reopen the Captions, Text, Audio, Transitions, Colour, Motion or Templates panels; the command line prints an older provider risk sentence; one title template still says "New tools for JOY Studio"; some icon buttons in Joy Code Settings keep fixed colours instead of the theme colours; the History panel shows internal ids in a few labels.

## Not yet checked on screen

These are built and tested in code. They were not yet seen working in the running app when these notes were written.

- Crop numbers cutting the picture in the Monitor and the export.
- Monitor overlays, guides, background and bars; frame stepping and the time readout. (Seen working on 17 Nov: the Preview quality control in the Monitor bar, Scopes in the Colour panel, and the Format menu with grouped export presets.)
- Colour on old projects compared with v1.1.0, and the graphics card path of the colour engine.
- Whether the Format control saves frame rate and background settings, and whether exports match the canvas size.
- Sample projects without missing media, missing-clip marks on the timeline, the Monitor and the Inspector, and the export warning about missing media.
- The Asset Library Storage dialog and its Open folder button.
- The library card design and transition cards that play the real transition.
- Animate panel changes, and the panel header menu.
- Audio fades in the Audio panel.
- Workspace presets keep their own layout when you switch between Edit, Automate and the others.
- A clean install and upgrades from v1.0.2 and v1.1.0.
