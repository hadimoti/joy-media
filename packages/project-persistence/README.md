# `@joy-media/project-persistence`

WP-01.2 provides durable, local-first project persistence: verified snapshots, append-only command transactions, recovery reporting, write-ahead recovery copies, autosave states, and per-project ownership locks.

`JsonFileProjectStore` is the desktop-first adapter. It rewrites an isolated JSON database through a temporary sibling and atomic rename. A browser IndexedDB adapter can implement the same `ProjectStore` contract without changing command or recovery behavior.
