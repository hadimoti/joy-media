import { deliveryGate, type ExportProcessEntry } from './export-history.js';

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
            const gate = deliveryGate(entry);
            const channelLabel =
              entry.channel === 'verified-delivery'
                ? 'Verified delivery'
                : entry.channel === 'quick-browser-export'
                  ? 'Quick browser export'
                  : 'Legacy export';
            const reportRef = entry.inspection?.reportRef ?? entry.reportRef;
            return (
              <li key={entry.id} className={`delivery-report-row delivery-report-${gate.status}`}>
                <div className="delivery-report-main">
                  <span className="delivery-report-channel">{channelLabel}</span>
                  <strong dir="ltr">{entry.filename}</strong>
                  <span className="delivery-report-reason">{gate.reason}</span>
                </div>
                <div className="delivery-report-meta" dir="ltr">
                  <span>{gate.label}</span>
                  {entry.exportJobId !== undefined && <span>export {entry.exportJobId}</span>}
                  {entry.inspectJobId !== undefined && <span>inspect {entry.inspectJobId}</span>}
                  {reportRef !== undefined && <span>report {reportRef}</span>}
                  {gate.summary.pass > 0 && <span>{plural(gate.summary.pass, 'pass')}</span>}
                  {gate.summary.warn > 0 && <span>{plural(gate.summary.warn, 'warning')}</span>}
                  {gate.summary.fail > 0 && <span>{plural(gate.summary.fail, 'failure')}</span>}
                  {gate.waiver !== undefined && (
                    <span>
                      waived by {gate.waiver.actor}: {gate.waiver.reason}
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
