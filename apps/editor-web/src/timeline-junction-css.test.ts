import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const dnd = readFileSync(new URL('./editor-pointer-dnd.ts', import.meta.url), 'utf8');

// CSS-text and source checks: they prove the rule exists and is tied to the marker the drag code sets. The
// live proof is the Looks row D-070, which clicks a one second clip next to a cut.
describe('Empty transition junction on a short clip', () => {
  it('only catches the pointer while an editor drag is in progress', () => {
    const rule = appCss.match(
      /body:not\(\[data-editor-pointer-dragging\]\)\s+\.timeline-transition-junction\.timeline-transition-junction--empty \{([\s\S]*?)\n\}/u,
    );
    expect(rule?.[1]).toContain('pointer-events: none;');
  });

  it('uses the body marker that the pointer drag really sets and clears', () => {
    expect(dnd).toContain('document.body.dataset.editorPointerDragging = drag.payload.kind;');
    expect(dnd).toContain('delete document.body.dataset.editorPointerDragging;');
  });

  it('leaves a junction that holds a transition clickable', () => {
    expect(appCss).not.toMatch(/\.timeline-transition-junction \{[^}]*pointer-events: none/u);
  });
});
