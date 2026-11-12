# Where your project files are (JOY Media 1.2)

A short guide for people who make things, not code. It explains where a folder project lives and what
is safe to do with it.

## Where to find your projects

Each project is one folder in `Documents\JOY Projects`.

If your Documents folder is kept in OneDrive, the app uses `C:\Users\<your name>\JOY Projects`
instead, because cloud sync can damage a project while the app is writing it.

Every project folder ends in `.joyproj`, for example `Summer.joyproj`. The Projects screen lists the
folders it finds there, next to your other projects. Click one to open it in the editor.

You do not have to remember any of this: the Projects screen shows the exact folder, under the word
**Projects**, as "Folder projects are saved in: …". There is no setting to change this folder.

To make a project that is a folder, click **New folder project**. A project made with **New project**
is kept inside the app instead: it is not a folder you can see, copy or back up.

## What is inside a project folder

| Inside           | What it is                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `project.sqlite` | The project itself: your timeline, edits and settings.                                                   |
| `assets\`        | The project's own copies of your videos, pictures and sounds. They have code names, not your file names. |
| `cache\`         | Working files the app makes for itself.                                                                  |

Do not change, rename or delete anything **inside** the folder. Treat the whole `.joyproj` folder as
one thing, like a single file.

## How saving works

- The app saves into the folder by itself, every few seconds, and again when you go back to Projects.
- When you add a video or picture, the app copies it into the folder's `assets\` on the next save.
  Your original file stays where it was. The project keeps working even if you later delete or move
  the original.

## Close the project first

While a project is open in the editor, Windows keeps its folder in use. Before you rename, move,
copy or back up a project folder, go back to the **Projects** screen (or close the app).

## Rename, move, copy

- **Rename** the folder inside JOY Projects: it is still the same project.
- **Move** it out of JOY Projects: the app no longer lists it. **Move it back**: it is the same project
  again, with all its work and media.
- **Copy** the folder (for example to try a different version): the copy opens as a **new project of
  its own**. The app says: "This folder is a copy, so it opened as a new project of its own. The folder
  it was copied from is left as it is." Changes in the copy never touch the original.
- Sometimes the app cannot tell whether a folder is the original or a copy, for example after it was
  taken to another drive and brought back, or when the original went missing. Then it asks you. Pick
  the answer that is true; if you are not sure, choose **copy**, which never changes the other folder.

## Back up a project

With the project closed, copy the whole `.joyproj` folder to a backup drive. To use the backup, copy it
back into JOY Projects. If the original folder is still there too, the backup opens as a copy.

## When media is missing

If a media file is not in the folder, the project still opens and the app says which file is missing,
for example: "“Summer” opened, but 1 media file is missing from its folder: beach.mp4. Its place in the
project is kept. Import the very same file again and it goes back in place."

Import that same file again (the very same file, not an edited version) and it returns to its place.

## Not there yet

- Opening a project folder on another computer brings its timeline and media into the editor, but a
  render or export there may not find the media yet.
- Audio mix settings are not kept in the folder yet.
- The first save of a project with very large media can take a while; if it does not finish, the app
  tries again on the next save.
