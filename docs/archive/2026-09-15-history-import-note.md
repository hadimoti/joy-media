# History note: the 2026-09-15 whole-tree import

Commit `e270d5f` (2026-09-14) is the root commit of the imported line of history. It touches 2101 files
and is a whole-tree import of the `joy-media-final-migration-20260914` branch. It was merged into `main`
via `17627eb` on 2026-09-15.

Its message, "fix(editor): resync monitor after media placement", describes only a small part of the
change. Treat `e270d5f` as an import, not as an editor fix.

History before 2026-09-05 was not carried over. PR #1, merged on 2026-08-13, is not in the commit graph.

Purpose of this note: so future bisects and `git blame` runs know that a regression landing on `e270d5f`
means "somewhere in the imported tree", and that earlier history cannot be recovered from this repository.
Rewriting history again to fix this is not planned (see P6 in `docs/plans/2026-10-02-v1.0.1-plan.md`).
