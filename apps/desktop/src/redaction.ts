const SECRET_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|jwt|session)/i;
const SECRET_VALUE =
  /(bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/gi;

/** Redacts common secret-bearing fields before anything reaches the local UI. */
export function redactLogLine(line: string): string {
  let output = line.replace(SECRET_VALUE, '[REDACTED]');
  output = output.replace(
    /(["']?[^\s"'=]+["']?\s*[=:]\s*)([^\s,;}]+)/g,
    (match, prefix: string, _value: string) =>
      SECRET_KEY.test(prefix) ? `${prefix}[REDACTED]` : match,
  );
  return output.length > 1_000 ? `${output.slice(0, 1_000)}…` : output;
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : value,
    ]),
  );
}
