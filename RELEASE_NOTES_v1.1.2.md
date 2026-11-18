# JOY Media v1.1.2

JOY Media v1.1.2 is an update to v1.1.1. It is still a local desktop video editor for Windows, with no account and no server. This version shows your pictures in the Asset Library, adds smart guides and snapping on the Monitor, and makes the Joy Code chat and settings clearer when something goes wrong.

## What is new

### Asset Library

- Library cards and the big preview show the picture itself, taken from the asset library folder. Before, they showed an icon. This works in the desktop app for pictures and videos.
- The library file check is stricter. A folder with a name like the library's (for example, library2) can no longer be read as if it were the library.

### Monitor

- Smart guides help you line things up. While you move or scale a box on the Monitor, it snaps when it is within 6 screen pixels of the centre, the edges, the safe margins, your guides, or another item in the picture.
- A small readout shows the box's position, size and angle while you work.
- Hold Ctrl to turn snapping off.

### Joy Code and chat

- The Joy Code Settings button is a gear icon, not a sun.
- A sign-in section shows "Signed in." when you already have a saved sign-in. This does not show yet for xAI.
- When a provider says your usage limit is reached, the app says "Usage limit reached". Before, it said the model was incompatible or that you were offline.
- MiniMax gets a bigger answer budget, so it can think longer before it replies. If a model still runs out of room, the chat says "The model ran out of room" instead of saying you are offline.
- The chat keeps your typed text when the model has not been tested yet, so the message is not lost.
- The chat shows bold, italic and code formatting instead of the raw symbols.

### Command line

- The command line says "usage limit" when a provider reaches its limit.

## Under the hood

- The release workflow was rebuilt without the old server-based test lanes. An offline smoke step for the Windows Sandbox test is in place.

## Known limits

- **Unsigned.** The files are not code-signed, so Windows shows a warning when you download or run the setup. Windows Sandbox on the build PC blocks the unsigned installer.
- **Clean installs and upgrades not tested.** A clean install and upgrades from v1.0.2 and v1.1.0 were not tested in a clean Windows for this build. If an install or an upgrade fails for you, please report it.
- **xAI sign-in.** The "Signed in." label does not show yet for xAI.
- **Missing library files.** A library file that is missing is asked for again at every refresh.
- **Kimi limit.** When Kimi says the usage limit is reached, the limit is on your own Kimi plan. JOY Media cannot change it.
- **MiniMax.** MiniMax models think before they answer. A very long thought can still use up the room, and then the chat gives no answer. The app now says so.

## Not yet checked on screen

These are built and tested in code. They were not yet confirmed in the running app when these notes were written.

- Smart guides and snapping on the Monitor.
- The gear icon, the "Signed in." label and the usage limit wording in Joy Code.
- The chat keeping your typed text and showing bold, italic and code formatting.

## Download and check

Every file of this release will be listed here with its SHA-256 hash by the release step. This list is not filled in yet.

After you download, compare the hash of each file with that list. In PowerShell, use `Get-FileHash` on the downloaded file.

[Placeholder: file hashes will be listed here by the release step.]
