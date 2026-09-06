import { useId, type KeyboardEvent } from 'react';
import {
  MAX_OBSERVATION_CONSENT_BYTES,
  MAX_OBSERVATION_CONSENT_EVIDENCE_IDS,
  MAX_OBSERVATION_CONSENT_RANGE_US,
  MAX_OBSERVATION_CONSENT_REQUESTS,
  OBSERVATION_MODALITIES,
  type ObservationModality,
  type ObservationRange,
} from './joy-agent/observation-consent.js';
import './AgentObservationConsent.css';

export type AgentObservationConsentAvailability = 'ready' | 'probing' | 'unavailable';

export interface AgentObservationConsentCostEstimate {
  readonly amount: number;
  readonly currency: string;
}

/**
 * A display-only, already-redacted consent summary from the trusted UI host.
 *
 * This deliberately excludes provider endpoints, API keys, project/run IDs,
 * evidence IDs, media locations, and media bytes. The object is a review
 * surface, not the host-issued consent capability used by transfer code.
 */
export interface AgentObservationConsentScope {
  readonly providerName: string;
  readonly modelName: string;
  readonly availability: AgentObservationConsentAvailability;
  readonly selectedEvidenceCount: number;
  readonly modalities: readonly ObservationModality[];
  readonly range: ObservationRange;
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly estimatedCost?: AgentObservationConsentCostEstimate | 'unknown';
  /** HTTPS provider policy page. It is validated before being rendered. */
  readonly policyHref?: string;
}

export interface AgentObservationConsentProps {
  readonly scope: AgentObservationConsentScope;
  /** Emits a frozen redacted snapshot only after the user presses Allow. */
  readonly onApprove: (scope: AgentObservationConsentScope) => void;
  /** Lets the host reopen its selection controls; it never changes scope here. */
  readonly onNarrow: (scope: AgentObservationConsentScope) => void;
  /** Lets the host dismiss/revoke a pending consent review. */
  readonly onCancel: (scope: AgentObservationConsentScope) => void;
  readonly direction?: 'ltr' | 'rtl';
  readonly narrow?: boolean;
  readonly reducedMotion?: boolean;
}

const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_POLICY_URL_LENGTH = 512;
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 .:_/+-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;
const POLICY_PATH = /(?:privacy|policy|legal|terms|data)/iu;
const MEDIA_LIKE_POLICY_PATH =
  /\.(?:avi|flac|gif|jpe?g|m4a|mkv|mov|mp3|mp4|mpeg|oga|ogg|png|svg|wav|webm)$/iu;

const modalityLabels: Readonly<Record<ObservationModality, string>> = {
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
  transcript: 'Transcript excerpts',
};

const availabilityCopy: Readonly<
  Record<
    AgentObservationConsentAvailability,
    { readonly title: string; readonly description: string }
  >
> = {
  ready: {
    title: 'Ready for your decision',
    description: 'Nothing has been shared. Allowing this review is the next explicit step.',
  },
  probing: {
    title: 'Checking availability',
    description:
      'JOY is checking whether the selected model can accept this scope. Nothing has been shared.',
  },
  unavailable: {
    title: 'Review unavailable',
    description: 'The selected model cannot accept this scope right now. Nothing has been shared.',
  },
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyExpectedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.every((key) => required.includes(key) || optional.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isSafeDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DISPLAY_NAME_LENGTH &&
    DISPLAY_NAME.test(value) &&
    !value.includes('://') &&
    !value.includes('\\')
  );
}

function isAvailability(value: unknown): value is AgentObservationConsentAvailability {
  return value === 'ready' || value === 'probing' || value === 'unavailable';
}

function isPositiveBoundedInteger(
  value: unknown,
  maximum: number,
  allowZero = false,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= maximum
  );
}

function isSafeRange(value: unknown): value is ObservationRange {
  if (!isPlainRecord(value) || !hasOnlyExpectedKeys(value, ['domain', 'startUs', 'endUs'], []))
    return false;
  const { domain, startUs, endUs } = value;
  return (
    (domain === 'source' || domain === 'composition') &&
    isPositiveBoundedInteger(startUs, Number.MAX_SAFE_INTEGER, true) &&
    isPositiveBoundedInteger(endUs, Number.MAX_SAFE_INTEGER) &&
    endUs > startUs &&
    endUs - startUs <= MAX_OBSERVATION_CONSENT_RANGE_US
  );
}

function isSafeModalities(value: unknown): value is readonly ObservationModality[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > OBSERVATION_MODALITIES.length)
    return false;
  const modalities = value as readonly unknown[];
  const unique = new Set(modalities);
  return (
    unique.size === modalities.length &&
    modalities.every((modality) => OBSERVATION_MODALITIES.includes(modality as ObservationModality))
  );
}

function normalizePolicyHref(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_POLICY_URL_LENGTH)
    return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !POLICY_PATH.test(parsed.pathname) ||
      MEDIA_LIKE_POLICY_PATH.test(parsed.pathname)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeCost(value: unknown): AgentObservationConsentCostEstimate | 'unknown' {
  if (value === undefined || value === 'unknown') return 'unknown';
  if (
    !isPlainRecord(value) ||
    !hasOnlyExpectedKeys(value, ['amount', 'currency'], []) ||
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    value.amount > 1_000_000 ||
    typeof value.currency !== 'string' ||
    !CURRENCY.test(value.currency)
  ) {
    return 'unknown';
  }
  return Object.freeze({ amount: value.amount, currency: value.currency });
}

function snapshotScope(value: unknown): AgentObservationConsentScope | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyExpectedKeys(
      value,
      [
        'providerName',
        'modelName',
        'availability',
        'selectedEvidenceCount',
        'modalities',
        'range',
        'maxRequests',
        'maxBytes',
      ],
      ['estimatedCost', 'policyHref'],
    ) ||
    !isSafeDisplayName(value.providerName) ||
    !isSafeDisplayName(value.modelName) ||
    !isAvailability(value.availability) ||
    !isPositiveBoundedInteger(
      value.selectedEvidenceCount,
      MAX_OBSERVATION_CONSENT_EVIDENCE_IDS,
      true,
    ) ||
    !isSafeModalities(value.modalities) ||
    !isSafeRange(value.range) ||
    !isPositiveBoundedInteger(value.maxRequests, MAX_OBSERVATION_CONSENT_REQUESTS) ||
    !isPositiveBoundedInteger(value.maxBytes, MAX_OBSERVATION_CONSENT_BYTES)
  ) {
    return undefined;
  }
  const policyHref = normalizePolicyHref(value.policyHref);
  if (value.policyHref !== undefined && policyHref === undefined) return undefined;
  return Object.freeze({
    providerName: value.providerName,
    modelName: value.modelName,
    availability: value.availability,
    selectedEvidenceCount: value.selectedEvidenceCount,
    modalities: Object.freeze([...value.modalities]),
    range: Object.freeze({ ...value.range }),
    maxRequests: value.maxRequests,
    maxBytes: value.maxBytes,
    estimatedCost: normalizeCost(value.estimatedCost),
    ...(policyHref === undefined ? {} : { policyHref }),
  });
}

function formatTimestamp(timestampUs: number): string {
  const totalMilliseconds = Math.floor(timestampUs / 1_000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  const secondsText = seconds.toString().padStart(2, '0');
  const millisecondsText = milliseconds.toString().padStart(3, '0');
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secondsText}.${millisecondsText}`
    : `${minutes}:${secondsText}.${millisecondsText}`;
}

function formatRange(range: ObservationRange): string {
  return `${formatTimestamp(range.startUs)}–${formatTimestamp(range.endUs)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function formatCost(cost: AgentObservationConsentCostEstimate | 'unknown' | undefined): string {
  if (cost === undefined || cost === 'unknown') return 'Unavailable — check provider pricing';
  return `${cost.amount.toFixed(cost.amount < 1 ? 4 : 2)} ${cost.currency}`;
}

/**
 * UI-only explicit consent review. Future trusted host integration must issue
 * the real in-memory consent after onApprove; this component does not probe a
 * provider, transfer media, construct requests, or retain raw media data.
 */
export function AgentObservationConsent({
  scope,
  onApprove,
  onNarrow,
  onCancel,
  direction = 'ltr',
  narrow = false,
  reducedMotion = false,
}: AgentObservationConsentProps) {
  const titleId = useId();
  const descriptionId = useId();
  const safeScope = snapshotScope(scope);

  if (safeScope === undefined) {
    return (
      <section
        className="agent-observation-consent is-invalid"
        data-agent-observation-consent="invalid"
        role="region"
        aria-label="Agent observation review unavailable"
      >
        <h2>Observation review unavailable</h2>
        <p>The review details were not safe to display. Nothing has been shared.</p>
      </section>
    );
  }

  const availability = availabilityCopy[safeScope.availability];
  const canApprove = safeScope.availability === 'ready' && safeScope.selectedEvidenceCount > 0;
  const approveDisabledReason =
    safeScope.availability === 'probing'
      ? 'Waiting for the availability check to finish.'
      : safeScope.availability === 'unavailable'
        ? 'This model cannot accept the selected scope right now.'
        : 'Select at least one safe evidence item before allowing a review.';
  const className = [
    'agent-observation-consent',
    `is-${safeScope.availability}`,
    narrow ? 'is-narrow' : '',
    direction === 'rtl' ? 'is-rtl' : '',
    reducedMotion ? 'is-reduced-motion' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const call = (callback: (value: AgentObservationConsentScope) => void) => callback(safeScope);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    call(onCancel);
  };

  return (
    <section
      className={className}
      data-agent-observation-consent="true"
      data-availability={safeScope.availability}
      dir={direction}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={onKeyDown}
    >
      <header className="agent-observation-consent__header">
        <div>
          <p className="agent-observation-consent__label">Agent observation review</p>
          <h2 id={titleId}>Review what JOY may share</h2>
        </div>
        <p className="agent-observation-consent__availability" role="status" aria-live="polite">
          <strong>{availability.title}</strong>
          <span>{availability.description}</span>
        </p>
      </header>

      <p id={descriptionId} className="agent-observation-consent__intro">
        This is a scoped, one-time review. This screen does not send media or store credentials.
      </p>

      <dl className="agent-observation-consent__scope" aria-label="Observation review scope">
        <div>
          <dt>Model</dt>
          <dd>
            {safeScope.providerName} · {safeScope.modelName}
          </dd>
        </div>
        <div>
          <dt>Selected evidence</dt>
          <dd>
            {safeScope.selectedEvidenceCount} opaque item
            {safeScope.selectedEvidenceCount === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Media types</dt>
          <dd>{safeScope.modalities.map((modality) => modalityLabels[modality]).join(', ')}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd>
            <span className="agent-observation-consent__range-domain">
              {safeScope.range.domain}
            </span>{' '}
            <time dir="ltr">{formatRange(safeScope.range)}</time>
          </dd>
        </div>
        <div>
          <dt>Request budget</dt>
          <dd>
            At most {safeScope.maxRequests} request{safeScope.maxRequests === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Byte budget</dt>
          <dd>At most {formatBytes(safeScope.maxBytes)}</dd>
        </div>
        <div>
          <dt>Provider cost</dt>
          <dd>{formatCost(safeScope.estimatedCost)}</dd>
        </div>
      </dl>

      {safeScope.policyHref !== undefined && (
        <a
          className="agent-observation-consent__policy"
          href={safeScope.policyHref}
          target="_blank"
          rel="noreferrer"
        >
          Read the provider policy
        </a>
      )}
      {safeScope.policyHref === undefined && (
        <p className="agent-observation-consent__policy-unavailable">
          Provider policy link unavailable for this compatible provider. Check its privacy terms
          before approval.
        </p>
      )}

      <p className="agent-observation-consent__notice">
        Approval allows only this reviewed scope. Your provider may charge for or retain request
        logs under its own policy. You can narrow it first or cancel it at any time.
      </p>

      <div className="agent-observation-consent__actions">
        <button
          className="agent-observation-consent__button agent-observation-consent__button--primary"
          type="button"
          disabled={!canApprove}
          aria-describedby={canApprove ? undefined : `${descriptionId}-approve-reason`}
          onClick={() => call(onApprove)}
        >
          Allow this review
        </button>
        <button
          className="agent-observation-consent__button"
          type="button"
          onClick={() => call(onNarrow)}
        >
          Narrow selection
        </button>
        <button
          className="agent-observation-consent__button agent-observation-consent__button--quiet"
          type="button"
          aria-keyshortcuts="Escape"
          onClick={() => call(onCancel)}
        >
          Cancel review
        </button>
      </div>
      {!canApprove && (
        <p
          id={`${descriptionId}-approve-reason`}
          className="agent-observation-consent__disabled-reason"
        >
          {approveDisabledReason}
        </p>
      )}
    </section>
  );
}
