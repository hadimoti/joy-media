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

const MEDIA = '(?:cut|timeline|film|video|export|footage)';
const PROBLEM = '(?:problems?|faults?|issues?|mistakes?|errors?|glitch(?:es)?|defects?)';
const FA_MEDIA = '(?:ویدیو|فیلم|خروجی|تایم‌?لاین)';
const FA_PROBLEM = '(?:مشکل|ایراد|اشکال)';

const CHECK_FOR_PROBLEMS = new RegExp(
  `\\b(?:check|review|inspect|audit|scan)\\b[^.\\n]{0,40}\\bfor\\b[^.\\n]{0,20}\\b${PROBLEM}\\b`,
);
const DETECT_PROBLEMS = new RegExp(
  `\\b(?:find|spot|detect|look for|are there|is there|any)\\b[^.\\n]{0,30}\\b${PROBLEM}\\b`,
);
const MEDIA_WORD = new RegExp(`\\b${MEDIA}\\b`);
const MEDIA_HAS_PROBLEMS = new RegExp(
  `\\b(?:does|do|did|is|are)\\b[^.\\n]{0,30}\\b${MEDIA}\\b[^.\\n]{0,30}\\b(?:have|has|contain|contains)\\b[^.\\n]{0,15}\\b${PROBLEM}\\b`,
);
const FA_QUALITY_OF_MEDIA = new RegExp(`کیفیت[^.\\n]{0,20}${FA_MEDIA}`, 'u');
const FA_MEDIA_PROBLEM = new RegExp(`${FA_MEDIA}[^.\\n]{0,25}${FA_PROBLEM}`, 'u');
const FA_PROBLEM_MEDIA = new RegExp(`${FA_PROBLEM}[^.\\n]{0,30}${FA_MEDIA}`, 'u');

/**
 * True when the owner's text asks for a quality check, so the QC tools may be
 * offered for that one run. Ordinary edits never see them: a verb such as "check"
 * or "review" alone ("check the frame rate", "review my timeline pacing") and a
 * problem word alone ("fix the error in the title") are edits, not quality checks.
 */
export function isQcCheckRequest(prompt: string): boolean {
  const value = prompt.toLowerCase();
  return (
    // Explicit quality-check wording.
    /\b(?:qc|quality[- ]?(?:check|control|review|assurance))\b/.test(value) ||
    // "check ... for problems", "find problems in the cut", "does the film have errors?".
    CHECK_FOR_PROBLEMS.test(value) ||
    (DETECT_PROBLEMS.test(value) && MEDIA_WORD.test(value)) ||
    MEDIA_HAS_PROBLEMS.test(value) ||
    // Persian: quality control / quality check, quality of the video, problems in the video.
    /(?:کنترل کیفیت|بررسی کیفیت|چک کیفیت)/u.test(prompt) ||
    FA_QUALITY_OF_MEDIA.test(prompt) ||
    FA_MEDIA_PROBLEM.test(prompt) ||
    FA_PROBLEM_MEDIA.test(prompt)
  );
}
