/** Hand-written tokenizer — no regex-based `eval`-adjacent tricks, just character scanning. */

export type TokenKind =
  | 'number'
  | 'string'
  | 'identifier'
  | 'true'
  | 'false'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '!'
  | '?'
  | ':'
  | '('
  | ')'
  | ','
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value?: number | string;
  readonly position: number;
}

export class LexError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'LexError';
  }
}

const SINGLE_CHAR_TOKENS: Readonly<Record<string, TokenKind>> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '?': '?',
  ':': ':',
  '(': '(',
  ')': ')',
  ',': ',',
};

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

/** Tokenizes `source` in one pass; throws `LexError` on the first invalid character. */
export function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
      continue;
    }
    const start = i;
    if (isDigit(char) || (char === '.' && isDigit(source[i + 1] ?? ''))) {
      let text = '';
      while (i < source.length && (isDigit(source[i]!) || source[i] === '.')) {
        text += source[i];
        i += 1;
      }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new LexError(`invalid number literal "${text}"`, start);
      tokens.push({ kind: 'number', text, value, position: start });
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      let text = '';
      while (i < source.length && source[i] !== quote) {
        text += source[i];
        i += 1;
      }
      if (i >= source.length) throw new LexError('unterminated string literal', start);
      i += 1; // closing quote
      tokens.push({ kind: 'string', text, value: text, position: start });
      continue;
    }
    if (isIdentifierStart(char)) {
      let text = '';
      while (i < source.length && isIdentifierPart(source[i]!)) {
        text += source[i];
        i += 1;
      }
      if (text === 'true') tokens.push({ kind: 'true', text, position: start });
      else if (text === 'false') tokens.push({ kind: 'false', text, position: start });
      else tokens.push({ kind: 'identifier', text, position: start });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ kind: two, text: two, position: start });
      i += 2;
      continue;
    }
    if (char === '<' || char === '>' || char === '!') {
      tokens.push({ kind: char, text: char, position: start });
      i += 1;
      continue;
    }
    const single = SINGLE_CHAR_TOKENS[char];
    if (single !== undefined) {
      tokens.push({ kind: single, text: char, position: start });
      i += 1;
      continue;
    }
    throw new LexError(`unexpected character "${char}"`, start);
  }
  tokens.push({ kind: 'eof', text: '', position: source.length });
  return tokens;
}
