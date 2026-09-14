# `@joy-media/project-persistence`

WP-01.2 provides durable, local-first project persistence: verified snapshots, append-only command transactions, recovery reporting, write-ahead recovery copies, autosave states, and per-project ownership locks.

`JsonFileProjectStore` is the desktop-first adapter. It rewrites an isolated JSON database through a temporary sibling and atomic rename. `BrowserProjectStore` implements the same `ProjectStore` contract over a `localStorage`-shaped key/value store without changing command or recovery behavior.

`SqliteProjectStore` (added for the JOY Media desktop migration, wave 2) implements the same contract over `node:sqlite`, wrapping every multi-row write in a transaction (`BEGIN IMMEDIATE` / `COMMIT`, rolled back on error) instead of JSON's whole-file rewrite. It is exported from the `./desktop` subpath alongside `JsonFileProjectStore`, never from the package's browser-safe `.` entry — `apps/editor-web`'s Vite bundle never resolves `node:sqlite`.
