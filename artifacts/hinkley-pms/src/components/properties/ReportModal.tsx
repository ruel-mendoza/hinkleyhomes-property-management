import type { PropertySummary } from "@workspace/api-client-react";
import { buildReport, locationLine } from "@/services/properties";
import { ModalShell } from "./ModalShell";
import { OccupancyBar } from "./OccupancyBar";

export function ReportModal({ items, filtered, onClose }: { items: PropertySummary[]; filtered: boolean; onClose: () => void }) {
  const report = buildReport(items);
  const stats = [
    { label: "Properties", value: String(report.totalProperties) },
    { label: "Rooms", value: String(report.totalRooms) },
    { label: "Occupancy", value: report.occupancyPercent === null ? "—" : `${report.occupancyPercent}%`, foot: `${report.occupiedRooms} rooms occupied` },
    { label: "With open actions", value: String(report.withOpenActions), foot: `${report.openActions} open actions` },
  ];
  return (
    <ModalShell
      title="Properties report"
      caption={filtered ? "For the properties matching your current filters." : "For every active property."}
      onClose={onClose}
      wide
      testId="modal-properties-report"
      footer={<>
        <button type="button" className="button" onClick={() => window.print()}>Print</button>
        <button type="button" className="button primary" onClick={onClose}>Done</button>
      </>}
    >
      <dl className="hh-report-stats">
        {stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd>{stat.foot && <small>{stat.foot}</small>}</div>)}
      </dl>
      {report.unknownOccupancy > 0 && <p className="hh-act-hint">{report.unknownOccupancy} {report.unknownOccupancy === 1 ? "property isn't" : "properties aren't"} in COHO yet, so {report.unknownOccupancy === 1 ? "its" : "their"} occupancy isn't counted.</p>}
      <h3 className="hh-report-heading">Lowest occupancy</h3>
      {report.lowestOccupancy.length ? (
        <ol className="hh-report-list">
          {report.lowestOccupancy.map((property) => (
            <li key={property.id}>
              <span><strong>{property.name}</strong><small>{locationLine(property)}</small></span>
              <span className="hh-report-occ">{property.roomsOccupied}/{property.totalRooms}<OccupancyBar occupied={property.roomsOccupied} total={property.totalRooms} /></span>
            </li>
          ))}
        </ol>
      ) : <p className="hh-act-hint">No occupancy data for these properties.</p>}
    </ModalShell>
  );
}
