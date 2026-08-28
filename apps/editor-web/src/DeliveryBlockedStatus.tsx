export function DeliveryBlockedStatus({
  id,
  failures,
}: {
  readonly id: string;
  readonly failures: readonly {
    readonly channel: 'Quick export' | 'Verified delivery';
    readonly detail: string;
  }[];
}) {
  if (failures.length === 0) return null;
  const summary =
    failures.length === 1 ? `${failures[0]!.channel} unavailable` : 'Export unavailable';
  const announcement =
    failures.length === 1
      ? `${failures[0]!.channel} is unavailable.`
      : 'Export is unavailable. Quick export and verified delivery need attention.';
  return (
    <div className="delivery-blocked-status">
      <span
        id={`${id}-announcement`}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
      <details id={id} className="delivery-blocked-reason">
        <summary>{summary}</summary>
        <ul className="delivery-blocked-detail">
          {failures.map((failure) => (
            <li key={failure.channel}>
              <strong>{failure.channel}</strong>
              <span>{failure.detail}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
