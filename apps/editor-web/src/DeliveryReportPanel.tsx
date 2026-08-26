import { deliveryGate, exportProcessGate, type ExportProcessEntry } from './export-history.js';

export function DeliveryReportPanel({
  entries,
}: {
  readonly entries: readonly ExportProcessEntry[];
}) {
  const deliveryEntries = entries;

  return (
    <section className="delivery-report-panel" aria-label="Delivery reports">
      <h3>Delivery reports</h3>
      {deliveryEntries.length === 0 ? (
        <p className="empty-hint">No delivery reports yet.</p>
      ) : (
        <ul className="delivery-report-list">
          {deliveryEntries.map((entry) => {
            // Browser and legacy exports are process records, not verified
            // delivery attempts. Keep the strict inspection gate for the
            // verified channel, but do not turn a successful download into a
            // misleading "Not verified" result.
            const gate =
              entry.channel === 'verified-delivery'
                ? deliveryGate(entry)
                : exportProcessGate(entry);
            const channelLabel =
              entry.channel === 'verified-delivery'
                ? 'Verified delivery'
                : entry.channel === 'quick-browser-export'
                  ? 'Quick browser export'
                  : 'Legacy export';
            return (
              <li key={entry.id} className={`delivery-report-row delivery-report-${gate.status}`}>
                <div className="delivery-report-main">
                  <span className="delivery-report-channel">{channelLabel}</span>
                  <bdi dir="auto">
                    <strong>{entry.filename}</strong>
                  </bdi>
                  <span className="delivery-report-reason">{gate.reason}</span>
                </div>
                <div className="delivery-report-meta">
                  <span>{gate.label}</span>
                  {gate.summary.pass > 0 && <span>{plural(gate.summary.pass, 'pass')}</span>}
                  {gate.summary.warn > 0 && <span>{plural(gate.summary.warn, 'warning')}</span>}
                  {gate.summary.fail > 0 && <span>{plural(gate.summary.fail, 'failure')}</span>}
                  {entry.inspection?.report?.evidenceLevel !== undefined && (
                    <span>evidence: sampled checks</span>
                  )}
                  {entry.inspection?.report !== undefined &&
                    entry.inspection.report.evidenceLevel === undefined && (
                      <span>evidence: unavailable</span>
                    )}
                  {gate.waiver !== undefined && (
                    <span>
                      waiver recorded: <bdi dir="auto">{gate.waiver.reason}</bdi>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
