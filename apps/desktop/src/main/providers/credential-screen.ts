/**
 * The check that a text holds a credential (PLAN-v4 §6b). The broker runs it on the replies and the model values it
 * returns, and the ChatGPT sign-in runs it on the model it saves, so both refuse a credential the same way.
 */

/** How deep a string that holds JSON is searched. Past it, a string that parses is refused. */
const MAX_NESTED_JSON = 8;

/**
 * True when the key shows in the reply: in its text, in a JSON string, or in a string that is itself
 * JSON, such as a tool call's arguments. JSON escapes do not hide it (PLAN-v4 §6b).
 */
export function holdsCredential(reply: string, key: string): boolean {
  return textHoldsKey(reply, key, 0);
}

function textHoldsKey(text: string, key: string, depth: number): boolean {
  if (text.includes(key)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return valueHoldsKey(parsed, key, depth);
}

function valueHoldsKey(value: unknown, key: string, depth: number): boolean {
  if (typeof value === 'string') {
    if (value.includes(key)) return true;
    // Only a string with a backslash can hide the key behind a JSON escape.
    if (!value.includes('\\')) return false;
    if (depth >= MAX_NESTED_JSON) return isJsonText(value);
    return textHoldsKey(value, key, depth + 1);
  }
  if (Array.isArray(value)) return value.some((item) => valueHoldsKey(item, key, depth));
  if (typeof value === 'object' && value !== null) {
    // A property name is a string too: it can hold JSON, escapes and all.
    return Object.entries(value).some(
      ([name, item]) => valueHoldsKey(name, key, depth) || valueHoldsKey(item, key, depth),
    );
  }
  return false;
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
