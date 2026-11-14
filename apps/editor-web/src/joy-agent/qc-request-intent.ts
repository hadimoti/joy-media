/**
 * The cheap, dependency-free half of the QC wiring. It lives apart from the QC
 * host adapter so the Joy Code panel can decide whether a request is a quality
 * check without loading the sampler and contact-sheet code into its main chunk.
 */

import type { JoyAgentHostToolName } from './host-tool-contract.js';

/** The three model-visible QC tool names. They exist only on a QC run. */
export const QC_HOST_TOOL_NAMES = Object.freeze([
  'qc_report_read',
  'media_frames_view',
  'media_contact_sheet',
] as const satisfies readonly JoyAgentHostToolName[]);

const QC_HOST_TOOL_NAME_SET: ReadonlySet<string> = new Set(QC_HOST_TOOL_NAMES);

export function isQcHostToolName(name: string): boolean {
  return QC_HOST_TOOL_NAME_SET.has(name);
}

/**
 * True when the owner's text asks for a quality check, so the QC tools may be
 * offered for that one run. Ordinary edits never see them.
 */
export function isQcCheckRequest(prompt: string): boolean {
  const value = prompt.toLowerCase();
  return (
    /\b(?:qc|quality[- ]?(?:check|control|review)|proofread)\b/.test(value) ||
    /\b(?:check|review|inspect|audit|watch)\b[^.\n]{0,40}\b(?:cut|timeline|film|video|export|frames?)\b/.test(
      value,
    ) ||
    /\b(?:problems?|faults?|issues?|mistakes?|errors?)\b[^.\n]{0,40}\b(?:cut|timeline|film|video|export)\b/.test(
      value,
    ) ||
    /\b(?:cut|timeline|film|video|export)\b[^.\n]{0,40}\b(?:problems?|faults?|issues?|mistakes?|errors?)\b/.test(
      value,
    ) ||
    /(?:کنترل کیفیت|بررسی کیفیت|چک کیفیت)/u.test(prompt)
  );
}
