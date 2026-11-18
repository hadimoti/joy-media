import type { ReactNode } from 'react';

/**
 * A small inline formatter for Joy Code assistant text. It turns `**bold**`,
 * `*italic*`, `_italic_` and `` `code` `` into React nodes. Nothing is parsed as
 * HTML: text becomes React text, so `<script>` stays plain. Links and images
 * are not recognised and stay as written. A mark that is not closed on the same
 * line stays plain text.
 */

export type JoyCodeInlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly JoyCodeInlineNode[] }
  | { readonly kind: 'em'; readonly children: readonly JoyCodeInlineNode[] };

interface InlineContext {
  readonly inStrong: boolean;
  readonly inEm: boolean;
}

interface Rule {
  readonly kind: 'code' | 'strong' | 'em';
  readonly pattern: RegExp;
  readonly allowed: boolean;
}

interface Found {
  readonly index: number;
  readonly end: number;
  readonly node: JoyCodeInlineNode;
}

function rulesFor(context: InlineContext): readonly Rule[] {
  return [
    // Code is literal: marks inside it are not parsed.
    { kind: 'code', pattern: /`([^`\n]+)`/g, allowed: true },
    // Bold cannot contain another `**`, so an unbalanced pair stays plain.
    {
      kind: 'strong',
      pattern: /\*\*(?=\S)((?:(?!\*\*)[^\n])*?\S)\*\*/g,
      allowed: !context.inStrong,
    },
    // A single `*` must hug its text, so `2 * 3 * 4` stays plain.
    {
      kind: 'em',
      pattern: /(?<!\*)\*(?![\s*])((?:\*\*[^\n]*?\*\*|[^*\n])+?)(?<![\s*])\*(?!\*)/g,
      allowed: !context.inEm,
    },
    // An underscore inside a word (snake_case_name) is not an italic mark.
    {
      kind: 'em',
      pattern: /(?<![\p{L}\p{N}_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\p{L}\p{N}_])/gu,
      allowed: !context.inEm,
    },
  ];
}

function nextMatch(text: string, from: number, context: InlineContext): Found | undefined {
  let best: Found | undefined;
  for (const rule of rulesFor(context)) {
    if (!rule.allowed) continue;
    rule.pattern.lastIndex = from;
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    if (best !== undefined && best.index <= match.index) continue;
    const end = match.index + match[0].length;
    const content = match[1] ?? '';
    if (rule.kind === 'code') {
      best = { index: match.index, end, node: { kind: 'code', text: content } };
    } else if (rule.kind === 'strong') {
      best = {
        index: match.index,
        end,
        node: {
          kind: 'strong',
          children: parseInline(content, { inStrong: true, inEm: context.inEm }),
        },
      };
    } else {
      best = {
        index: match.index,
        end,
        node: {
          kind: 'em',
          children: parseInline(content, { inStrong: context.inStrong, inEm: true }),
        },
      };
    }
  }
  return best;
}

function parseInline(text: string, context: InlineContext): JoyCodeInlineNode[] {
  const nodes: JoyCodeInlineNode[] = [];
  const pushText = (value: string): void => {
    if (value.length === 0) return;
    const last = nodes[nodes.length - 1];
    if (last?.kind === 'text') {
      nodes[nodes.length - 1] = { kind: 'text', text: last.text + value };
    } else {
      nodes.push({ kind: 'text', text: value });
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const found = nextMatch(text, cursor, context);
    if (found === undefined) break;
    pushText(text.slice(cursor, found.index));
    nodes.push(found.node);
    cursor = found.end;
  }
  pushText(text.slice(cursor));
  return nodes;
}

/** Splits assistant text into plain, code, bold and italic nodes. Pure; no React. */
export function parseJoyCodeInlineMarks(text: string): JoyCodeInlineNode[] {
  return parseInline(text, { inStrong: false, inEm: false });
}

function renderNodes(nodes: readonly JoyCodeInlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'code':
        return <code key={index}>{node.text}</code>;
      case 'strong':
        return <strong key={index}>{renderNodes(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderNodes(node.children)}</em>;
    }
  });
}

/** Renders assistant text with its marks as React elements. Text is escaped by React. */
export function JoyCodeInlineText({ text }: { readonly text: string }): ReactNode {
  return <>{renderNodes(parseJoyCodeInlineMarks(text))}</>;
}
