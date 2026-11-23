# JOY Media v1.1.2

JOY Media v1.1.2 is an update to v1.1.1. It is still a local desktop video editor for Windows, with no account and no server. This version shows your pictures in the Asset Library, adds smart guides and snapping on the Monitor, and makes the Joy Code chat and settings clearer when something goes wrong.

## What is new

### Speech on your PC

- **Subtitles from speech.** The Captions panel can make subtitles from a voice recording on the timeline, in English or Persian. Recognition runs on your PC with the faster-whisper large-v3-turbo model. No account and no server are needed.
- **Voice-over.** The Generate tab makes a voice from text on your PC. English voices use Kokoro (82M) or Chatterbox English. The Persian voice uses Chatterbox Persian Expressive.
- **Reference voice.** Chatterbox can copy a voice from a short recording. Use a clean clip of 5 to 10 seconds, and only a voice you have the right to use. Put the clip on the timeline first, then choose it in the Generate tab.
- **Credit and licence.** The Persian voice model is Chatterbox Persian Expressive by Ramin Mahmoodi, licensed CC-BY-NC-4.0 for non-commercial use. The Captions panel and the speech README credit it. The model files are not part of JOY Media.

### Asset Library

- Library cards and the big preview show the picture itself, taken from the asset library folder. Before, they showed an icon. This works in the desktop app for pictures and videos.
- The library file check is stricter. A folder with a name like the library's (for example, library2) can no longer be read as if it were the library.

### Monitor

- Smart guides help you line things up. While you move or scale a box on the Monitor, it snaps when it is within 6 screen pixels of the centre, the edges, the safe margins, your guides, or another item in the picture.
- A small readout shows the box's position, size and angle while you work.
- Hold Ctrl to turn snapping off.

### Timeline

- Holding the left mouse button on a clip no longer sometimes turns the pointer into an arrow with a small plus and stops the drag. Clips, tracks and lanes no longer select text, and a clip cannot start a browser drag of its own.
- **Split at the playhead** cuts the selected clip where the playhead is.
- **Space** plays and pauses when the timeline or the Monitor has focus. It does not act while you type in a box or inside a dialog.
- **Inspector numbers** can be typed or dragged. Each change is one Undo step.
- **Captions:** in the caption text, Enter splits the caption at the cursor, Ctrl+Enter saves the text, and Backspace at the very start joins the caption to the one before.
- **Tracks** have lock, hide, mute and solo buttons.
- **Add to timeline** from the Media panel places the clip at the playhead, on the first track that is free there.

### Quality check

- The quality check now also reports a **low resolution** picture (under 360 pixels on the short side, for example a 320 by 180 clip) and **black bars baked into the picture** (a letterbox or pillarbox of 8 percent of the frame or more, for example 16:9 content padded into a 4:3 frame). Both are advice: JOY Media does not change the picture for you.
- The check for a frozen picture is unchanged and stays strict.

### Generated pictures and video

- Joy Code can start a picture or a video from MiniMax, show a cost card first, and attach the finished file to the timeline.
- The MiniMax video request now uses the format the current MiniMax service expects.

### Joy Code and chat

- The Joy Code Settings button is a gear icon, not a sun.
- A sign-in section shows "Signed in." when you already have a saved sign-in. This does not show yet for xAI.
- When a provider says your usage limit is reached, the app says "Usage limit reached". Before, it said the model was incompatible or that you were offline.
- MiniMax gets a bigger answer budget, so it can think longer before it replies. If a model still runs out of room, the chat says "The model ran out of room" instead of saying you are offline.
- The chat keeps your typed text when the model has not been tested yet, so the message is not lost.
- The chat shows bold, italic and code formatting instead of the raw symbols.

### Command line

- The command line says "usage limit" when a provider reaches its limit.

## Fixes

- **Title-only projects export.** A project that holds only titles now exports over the background. Before, the export refused it with "No playable visual clips are available for export".
- **Add to timeline starts at the playhead.** Before, the clip went after the clips already on the first track.

## Under the hood

- The release workflow was rebuilt without the old server-based test lanes. An offline smoke step for the Windows Sandbox test is in place.

## Known limits

- **Unsigned.** The files are not code-signed, so Windows shows a warning when you download or run the setup. Windows Sandbox on the build PC blocks the unsigned installer.
- **Clean installs and upgrades not tested.** A clean install and upgrades from v1.0.2 and v1.1.0 were not tested in a clean Windows for this build. If an install or an upgrade fails for you, please report it.
- **xAI sign-in.** The "Signed in." label does not show yet for xAI.
- **Missing library files.** A library file that is missing is asked for again at every refresh.
- **Kimi limit.** When Kimi says the usage limit is reached, the limit is on your own Kimi plan. JOY Media cannot change it.
- **MiniMax video.** The video steps are tested against test servers only. A real video request reached MiniMax and was answered with "no balance or rate limited", because the Go plan credits do not cover pay-as-you-go video. A picture from MiniMax was made and placed on the timeline for real.
- **Monitor menu.** The right-click menu on the Monitor has no Bring forward or Send backward yet. To change which layer is on top, move its track in the Timeline. Both items, and pressing Esc to cancel a title edit on the Monitor, are planned for a later version; for now Esc keeps the edit.
- **MiniMax.** MiniMax models think before they answer. A very long thought can still use up the room, and then the chat gives no answer. The app now says so.
- **Subtitle cues.** Each subtitle cue is one whole spoken part, so a long sentence stays one long cue. Cutting cues to a short length, and repairing Persian half-spaces, are not done yet.
- **Reference voice.** A reference voice must be a clip on the timeline. A file that is only in the Asset Library cannot be picked yet.
- **Speech set-up.** The speech engines and their model folders are not part of the installer in this release. The Captions and Generate panels say when something is missing.
- **Persian voice licence.** The Persian voice model is for non-commercial use only (CC-BY-NC-4.0).
- **Arabic final yeh.** In some Arabic titles, the final yeh may appear without its two dots in the default title font. This is not fixed in this release.

## Not yet checked on screen

These are built and tested in code. They were not yet confirmed in the running app when these notes were written.

- Smart guides and snapping on the Monitor.
- The gear icon, the "Signed in." label and the usage limit wording in Joy Code.
- The chat keeping your typed text and showing bold, italic and code formatting.

## Download and check

Every file of this release will be listed here with its SHA-256 hash by the release step. This list is not filled in yet.

After you download, compare the hash of each file with that list. In PowerShell, use `Get-FileHash` on the downloaded file.

[Placeholder: file hashes will be listed here by the release step.]
