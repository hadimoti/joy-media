# Persian explainer-copy policy

Status: active from 2026-07-27.

JOY Media keeps editor titles, tabs, menus, buttons, control labels, and
technical identifiers in English. It presents supporting copy in Persian:

- explanatory paragraphs and onboarding guidance;
- empty and inactive states;
- live status, validation, error, and success messages;
- search, composer, and other instructional placeholders.

Persian copy must carry `lang="fa"` when rendered as its own element. The
shared editor style applies Modam Pro, centered alignment, and
`unicode-bidi: plaintext`. Do not force `dir="rtl"` or `dir="ltr"` on these
blocks; direction overrides can alter otherwise neutral flex/grid layouts.
Use `<bdi>` or `<code>` for filenames, ids, API names, and other technical
tokens embedded in a Persian sentence.

This is a copy and presentation rule, not a product rename. The two visible
application header lockups read **JOY Studio**. Existing JOY Media domains,
repository names, packages, API messages/contracts, storage keys, and
infrastructure paths stay unchanged.

Implementation source of truth:

- [`DESIGN.md`](../../DESIGN.md) §4d–§4f;
- [`apps/editor-web/src/app.css`](../../apps/editor-web/src/app.css);
- [`apps/editor-web/src/PanelShell.tsx`](../../apps/editor-web/src/PanelShell.tsx).
