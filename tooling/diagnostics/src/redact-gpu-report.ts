/**
 * Redacts a GPU diagnostic report before it leaves the PC (plan section 3.2, step 6). Only allowlisted
 * fields survive, and every string that is kept is scrubbed for user names, host names, paths,
 * network addresses, adapter LUIDs and serial-like tokens. Raw dumps and logs never pass through
 * here, and the report keeps exception codes, because the diagnosis needs them.
 */

/** The only top-level fields a redacted report may contain. */
export const GPU_REPORT_FIELDS = [
  'vendor',
  'gpuModel',
  'driverVersion',
  'osBuild',
  'electronVersion',
  'chromiumVersion',
  'angleBackend',
  'featureStatus',
  'exceptionCode',
  'exceptionSubcode',
  'faultingModule',
  'faultingOffset',
  'topChromiumFrames',
] as const;

export type GpuReportField = (typeof GPU_REPORT_FIELDS)[number];

export interface RedactionOptions {
  /** Literal values that must never appear, such as the account and host names of this PC. */
  readonly sensitive: readonly string[];
}

/**
 * Paths run to the end of their token, spaces included: a folder such as "Alice Example" is a user
 * name, and a path that stops at its first space would leave it behind.
 */
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/[A-Za-z]:\\[^"'<>|\r\n]*/g, '<path>'],
  [/\\\\[^"'<>|\r\n]+/g, '<path>'],
  [/\b0x[0-9a-f]{8}:0x[0-9a-f]{8}\b/gi, '<luid>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>'],
  [/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '<address>'],
  [/\b[A-Z0-9]{10,}\b/g, '<id>'],
];

function escapeForPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

/** Scrubs one string: the pattern rules first (so whole paths go), then the sensitive literals. */
export function scrubText(value: string, options: RedactionOptions): string {
  let scrubbed = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  for (const literal of options.sensitive) {
    if (literal.length > 0) scrubbed = scrubbed.replace(escapeForPattern(literal), '<redacted>');
  }
  return scrubbed;
}

function scrubValue(value: unknown, options: RedactionOptions): unknown {
  if (typeof value === 'string') return scrubText(value, options);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, options));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubText(key, options),
        scrubValue(item, options),
      ]),
    );
  }
  return value;
}

/**
 * Returns a copy of `report` that keeps only GPU_REPORT_FIELDS, with every kept string scrubbed.
 * Any other field, nested or not, is dropped without being read into the output.
 */
export function redactGpuReport(
  report: Readonly<Record<string, unknown>>,
  options: RedactionOptions,
): Partial<Record<GpuReportField, unknown>> {
  return redactFields(report, options, GPU_REPORT_FIELDS);
}

/** Keeps only the named `fields` of `report`, scrubbing each kept value. Every report kind uses this rule. */
export function redactFields<Field extends string>(
  report: Readonly<Record<string, unknown>>,
  options: RedactionOptions,
  fields: readonly Field[],
): Partial<Record<Field, unknown>> {
  const redacted: Partial<Record<Field, unknown>> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(report, field)) {
      redacted[field] = scrubValue(report[field], options);
    }
  }
  return redacted;
}
