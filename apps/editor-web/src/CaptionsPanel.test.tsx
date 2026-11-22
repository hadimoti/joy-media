// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyCaptionProjectCommand } from '@joy-media/captions-core';
import type { VisualObjectTransaction } from '@joy-media/property-system';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { CaptionsPanel } from './CaptionsPanel.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';

describe('CaptionsPanel empty state', () => {
  it('offers an accessible caption-track action when no slot exists', () => {
    const root = INITIAL_EDITOR_PROJECT.compositions.root!;
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      captionDocuments: {},
      compositions: {
        ...INITIAL_EDITOR_PROJECT.compositions,
        root: { ...root, tracks: root.tracks.filter((track) => track.kind !== 'caption') },
      },
    };
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={project}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain('Add caption track');
    expect(markup).toContain('aria-label="Add caption track"');
  });

  it('renders the editable display override with accessible edit and revert controls', () => {
    const document = INITIAL_EDITOR_PROJECT.captionDocuments['captions-fa']!;
    const first = document.segments[0]!;
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      captionDocuments: {
        ...INITIAL_EDITOR_PROJECT.captionDocuments,
        'captions-fa': {
          ...document,
          segments: [{ ...first, textOverride: 'Edited caption' }, ...document.segments.slice(1)],
        },
      },
    };
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={project}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError={undefined}
        onProjectChange={() => undefined}
      />,
    );

    // Cues are named by order (1, 2, …); the segment id never reaches the DOM.
    expect(markup).toContain('aria-label="Caption text 1"');
    expect(markup).not.toContain('seg-1');
    expect(markup).toContain('>Edited caption</textarea>');
    expect(markup).toContain('title="Source: Welcome to JOY"');
    expect(markup).toContain('aria-label="Revert caption 1 to source text"');
    expect(markup).toContain('aria-label="Delete caption 1"');
    expect(markup).toContain('Caption track 1');
  });

  it('exposes transcription failures beside the actions that are affected', () => {
    const markup = renderToStaticMarkup(
      <CaptionsPanel
        project={INITIAL_EDITOR_PROJECT}
        playheadUs={0}
        onSeek={() => undefined}
        onDispatch={() => undefined}
        onTranscribe={async () => undefined}
        transcriptionError="Select an audio or video clip to transcribe."
        onProjectChange={() => undefined}
      />,
    );

    expect(markup).toContain(
      'Transcription unavailable: Select an audio or video clip to transcribe.',
    );
    expect(markup).toContain('class="caption-transcription-status" role="status"');
  });

  it('describes the unavailable status from both generate actions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CaptionsPanel
          project={INITIAL_EDITOR_PROJECT}
          playheadUs={0}
          onSeek={() => undefined}
          onDispatch={() => undefined}
          onTranscribe={async () => undefined}
          transcriptionError="Select an audio or video clip to transcribe."
          onProjectChange={() => undefined}
        />,
      );
    });

    const generateTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === 'Generate',
    );
    await act(async () => {
      generateTab?.click();
    });
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>('.caption-generate-actions button'),
    ];
    expect(actions).toHaveLength(2);
    const describedByIds = actions.map((button) => button.getAttribute('aria-describedby'));
    expect(describedByIds.every((id) => id !== null)).toBe(true);
    expect(new Set(describedByIds).size).toBe(1);
    const description = [...container.querySelectorAll<HTMLElement>('[id]')].find(
      (element) => element.id === describedByIds[0],
    );
    expect(description?.textContent).toContain('Transcription unavailable:');

    await act(async () => root.unmount());
    container.remove();
  });
});

describe('CaptionsPanel cue keyboard editing', () => {
  function renderPanel(
    container: HTMLElement,
    onDispatch: (transaction: VisualObjectTransaction) => void,
    project = INITIAL_EDITOR_PROJECT,
  ) {
    const root = createRoot(container);
    const render = (nextProject = project) =>
      root.render(
        <CaptionsPanel
          project={nextProject}
          playheadUs={0}
          onSeek={() => undefined}
          onDispatch={onDispatch}
          onTranscribe={async () => undefined}
          transcriptionError={undefined}
          onProjectChange={() => undefined}
        />,
      );
    act(() => render());
    return { root, render };
  }

  function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function key(textarea: HTMLTextAreaElement, init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(event);
    return event;
  }

  it('renders an accessible multiline editor and splits at the logical selection start once', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const transactions: VisualObjectTransaction[] = [];
    const { root } = renderPanel(container, (transaction) => transactions.push(transaction));
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    );

    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('dir')).toBe('ltr');
    expect(editor?.tagName).toBe('TEXTAREA');
    await act(async () => {
      editor!.focus();
      editor!.setSelectionRange(8, 10);
      key(editor!, { key: 'Enter' });
    });

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.commands).toHaveLength(1);
    const command = transactions[0]!.commands[0]!;
    expect(command.type).toBe('caption.replaceDocument');
    if (command.type !== 'caption.replaceDocument') {
      throw new Error('Expected caption replacement');
    }
    const replacement = command.payload.document;
    expect(
      replacement.segments.map((segment: { textOverride?: string }) => segment.textOverride),
    ).toEqual(['Welcome ', 'to JOY', undefined]);
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps native multiline editing for modified, composing, and ranged Backspace keys', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const transactions: VisualObjectTransaction[] = [];
    const { root } = renderPanel(container, (transaction) => transactions.push(transaction));
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    )!;
    await act(async () => {
      editor.focus();
      expect(key(editor, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false);
      expect(key(editor, { key: 'Enter', isComposing: true }).defaultPrevented).toBe(false);
      editor.setSelectionRange(1, 4);
      expect(key(editor, { key: 'Backspace' }).defaultPrevented).toBe(false);
    });
    expect(transactions).toHaveLength(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it('merges into the true previous cue and clears a filter that hid it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let project = INITIAL_EDITOR_PROJECT;
    const transactions: VisualObjectTransaction[] = [];
    const { root, render } = renderPanel(container, (transaction) => {
      transactions.push(transaction);
      const command = transaction.commands[0];
      if (command?.type === 'caption.replaceDocument') {
        project = {
          ...project,
          captionDocuments: {
            ...project.captionDocuments,
            [command.payload.documentId]: applyCaptionProjectCommand(project, command).project
              .captionDocuments[command.payload.documentId]!,
          },
        };
        render(project);
      }
    });
    const searchToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Search Captions"]',
    )!;
    await act(async () => searchToggle.click());
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    const second = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 2"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'Studio',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
      second.focus();
      second.setSelectionRange(0, 0);
      key(second, { key: 'Backspace' });
    });

    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    );
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    expect(editor?.value).toBe('Welcome to JOY Media Studio');
    expect(editor?.selectionStart).toBe('Welcome to JOY '.length);
    await act(async () => {
      setTextareaValue(editor!, 'Merged cue edited');
      editor!.blur();
      editor!.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[1]?.commands[0]?.type).toBe('caption.setSegmentText');
    expect(transactions[1]?.commands[0]).toMatchObject({
      payload: { textOverride: 'Merged cue edited' },
    });
    await act(async () => root.unmount());
    container.remove();
  });

  it('adds generated captions without replacing existing cues and one undo restores the project', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const project = INITIAL_EDITOR_PROJECT;
    const capturedStartUs = 5_000_000;
    const onDispatch = vi.fn<(transaction: VisualObjectTransaction) => void>();
    const render = (playheadUs: number) =>
      root.render(
        <CaptionsPanel
          project={project}
          playheadUs={playheadUs}
          onSeek={() => undefined}
          onDispatch={onDispatch}
          onTranscribe={async () => undefined}
          transcriptionError={undefined}
          onProjectChange={() => undefined}
          speechModelStatus={[
            { modelId: 'kokoro-82m', state: 'ready' },
            { modelId: 'faster-whisper-large-v3-turbo', state: 'ready' },
          ]}
          onGenerateSpeech={async () => ({
            availability: 'ready',
            insertionStartUs: capturedStartUs,
            timing: {
              durationUs: 2_000_000,
              timingSource: 'native',
              words: [
                { text: 'Generated', startUs: 100_000, endUs: 500_000 },
                { text: 'words', startUs: 600_000, endUs: 900_000 },
              ],
            },
          })}
        />,
      );
    await act(async () => render(0));

    const generateTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (button) => button.textContent === 'Generate',
    )!;
    await act(async () => generateTab.click());
    const text = container.querySelector<HTMLTextAreaElement>('.speech-generation-panel textarea')!;
    const checkbox = container.querySelectorAll<HTMLInputElement>(
      '.speech-consent-group input[type="checkbox"]',
    )[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        text,
        'Generated words',
      );
      text.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.speech-action-row button[type="submit"]')!
        .click();
    });
    expect(container.textContent).toContain('Speech generation complete.');

    // Move the playhead after Generate completed; captions must keep the captured start.
    await act(async () => render(8_000_000));
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.speech-action-row button')]
        .find((button) => button.textContent === 'Add captions')!
        .click();
    });

    expect(onDispatch).toHaveBeenCalledTimes(1);
    const transaction = onDispatch.mock.calls[0]![0];
    expect(transaction.commands).toHaveLength(1);
    const command = transaction.commands[0]!;
    expect(command.type).toBe('caption.replaceDocument');
    if (command.type === 'caption.replaceDocument') {
      const before = project.captionDocuments[command.payload.documentId]!;
      const generatedWords = Object.values(command.payload.document.words).filter(
        (word) => word.text.startsWith('Generated') || word.text === 'words',
      );
      expect(generatedWords.map(({ startUs, endUs }) => [startUs, endUs])).toEqual([
        [capturedStartUs - 1_000_000 + 100_000, capturedStartUs - 1_000_000 + 500_000],
        [capturedStartUs - 1_000_000 + 600_000, capturedStartUs - 1_000_000 + 900_000],
      ]);
      expect(command.payload.document.segments).toEqual(
        expect.arrayContaining([...before.segments]),
      );
      expect(Object.keys(command.payload.document.words)).toEqual(
        expect.arrayContaining(Object.keys(before.words)),
      );
      const applied = applyCaptionProjectCommand(project, command);
      expect(applied.project.captionDocuments).toHaveProperty('captions-fa');
      expect(Object.keys(applied.project.captionDocuments)).toEqual(
        Object.keys(project.captionDocuments),
      );
      expect(applyCaptionProjectCommand(applied.project, applied.inverse).project).toEqual(project);
    }
    await act(async () => root.unmount());
    container.remove();
  });

  it('splits RTL code points at the logical caret, focuses the new cue, and preserves undo', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const source = '\u200fسلام‌۱۲۳';
    const original = INITIAL_EDITOR_PROJECT;
    const captionDocument = original.captionDocuments['captions-fa']!;
    const first = captionDocument.segments[0]!;
    let project: typeof INITIAL_EDITOR_PROJECT = {
      ...original,
      captionDocuments: {
        ...original.captionDocuments,
        'captions-fa': {
          ...captionDocument,
          direction: 'rtl' as const,
          segments: [{ ...first, textOverride: source }, ...captionDocument.segments.slice(1)],
        },
      },
    };
    const expectedBefore = project.captionDocuments['captions-fa']!.segments;
    let renderProject: (next: typeof project) => void = () => undefined;
    const { root, render } = renderPanel(
      container,
      (transaction) => {
        const command = transaction.commands[0];
        if (command?.type !== 'caption.replaceDocument') return;
        const applied = applyCaptionProjectCommand(project, command);
        project = applied.project;
        renderProject(project);
        const undone = applyCaptionProjectCommand(project, applied.inverse).project;
        expect(undone.captionDocuments['captions-fa']?.segments).toEqual(expectedBefore);
      },
      project,
    );
    renderProject = render;
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    )!;
    const logicalCut = '\u200fسلام‌'.length;
    await act(async () => {
      editor.focus();
      editor.setSelectionRange(logicalCut, logicalCut);
      key(editor, { key: 'Enter' });
    });

    const nextEditor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 2"]',
    );
    expect(editor.dir).toBe('rtl');
    expect(nextEditor?.value).toBe('۱۲۳');
    expect(document.activeElement).toBe(nextEditor);
    expect(nextEditor?.selectionStart).toBe(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps newlines and aligns a multiline word boundary to source timing', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const base = INITIAL_EDITOR_PROJECT;
    const captionDocument = base.captionDocuments['captions-fa']!;
    const cue = captionDocument.segments[0]!;
    const project = {
      ...base,
      captionDocuments: {
        ...base.captionDocuments,
        'captions-fa': {
          ...captionDocument,
          words: {
            first: { id: 'first', text: 'hello', startUs: 0, endUs: 400_000 },
            second: { id: 'second', text: 'world', startUs: 600_000, endUs: 1_000_000 },
          },
          segments: [{ ...cue, startUs: 0, endUs: 1_000_000, wordIds: ['first', 'second'] }],
        },
      },
    };
    const transactions: VisualObjectTransaction[] = [];
    const { root } = renderPanel(
      container,
      (transaction) => transactions.push(transaction),
      project,
    );
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    )!;
    await act(async () => {
      setTextareaValue(editor, 'hello\nworld');
      editor.setSelectionRange(6, 6);
      key(editor, { key: 'Enter' });
    });
    const command = transactions[0]!.commands[0];
    expect(command?.type).toBe('caption.replaceDocument');
    if (command?.type === 'caption.replaceDocument') {
      expect(
        command.payload.document.segments.map(({ startUs, endUs, textOverride }) => ({
          startUs,
          endUs,
          textOverride,
        })),
      ).toEqual([
        { startUs: 0, endUs: 500_000, textOverride: 'hello\n' },
        { startUs: 500_000, endUs: 1_000_000, textOverride: 'world' },
      ]);
    }
    await act(async () => root.unmount());
    container.remove();
  });

  it('makes edge splits and a first-cue Backspace no-ops without inserting a newline', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const transactions: VisualObjectTransaction[] = [];
    const { root } = renderPanel(container, (transaction) => transactions.push(transaction));
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    )!;
    await act(async () => {
      editor.setSelectionRange(0, 0);
      expect(key(editor, { key: 'Enter' }).defaultPrevented).toBe(true);
      editor.setSelectionRange(editor.value.length, editor.value.length);
      expect(key(editor, { key: 'Enter' }).defaultPrevented).toBe(true);
      editor.setSelectionRange(0, 0);
      expect(key(editor, { key: 'Backspace' }).defaultPrevented).toBe(false);
    });
    expect(editor.value).toBe('Welcome to JOY');
    expect(transactions).toHaveLength(0);
    await act(async () => root.unmount());
    container.remove();
  });

  it('cancels drafts on Escape and keeps Ctrl+Enter as an ordinary edit commit', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const transactions: VisualObjectTransaction[] = [];
    const { root } = renderPanel(container, (transaction) => transactions.push(transaction));
    const editor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Caption text 1"]',
    )!;
    await act(async () => {
      editor.focus();
      setTextareaValue(editor, 'Discard this edit');
      key(editor, { key: 'Escape' });
    });
    expect(transactions).toHaveLength(0);
    expect(editor.value).toBe('Welcome to JOY');

    await act(async () => {
      editor.focus();
      setTextareaValue(editor, 'Committed edit');
      key(editor, { key: 'Enter', ctrlKey: true });
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.commands[0]!.type).toBe('caption.setSegmentText');
    await act(async () => root.unmount());
    container.remove();
  });
});
