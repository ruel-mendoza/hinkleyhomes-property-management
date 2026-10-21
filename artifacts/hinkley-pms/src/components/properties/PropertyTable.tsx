import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useLocation } from "wouter";
import type { PropertySummary } from "@workspace/api-client-react";
import { compareByStreet, statusLabel } from "@/services/properties";
import { ActionsBadge } from "./ActionsBadge";
import { OccupancyBar } from "./OccupancyBar";
import { EmptyProperties } from "./PropertyGrid";
import { PropertyThumb, propertyPath } from "./PropertyCard";

type SortKey = "property" | "actions";

export function PropertyTable({ items, loading, filtered, onClear }: { items: PropertySummary[]; loading: boolean; filtered: boolean; onClear: () => void }) {
  const [, navigate] = useLocation();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "property", dir: 1 });
  const rows = useMemo(() => {
    const sorted = [...items].sort((a, b) =>
      sort.key === "actions" ? a.openActionsCount - b.openActionsCount || compareByStreet(a, b) : compareByStreet(a, b),
    );
    return sort.dir === 1 ? sorted : sorted.reverse();
  }, [items, sort]);
  const toggle = (key: SortKey) => setSort((current) => ({ key, dir: current.key === key ? (current.dir === 1 ? -1 : 1) : key === "actions" ? -1 : 1 }));
  const SortHeader = ({ keyName, label }: { keyName: SortKey; label: string }) => {
    const active = sort.key === keyName;
    const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <th aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="hh-sort" onClick={() => toggle(keyName)}>{label} <Icon size={12} /></button>
      </th>
    );
  };

  if (!loading && !items.length) return <EmptyProperties onClear={onClear} filtered={filtered} />;
  return (
    <section className="panel table-panel">
      <div className="table-wrap">
        <table className="hh-prop-table">
          <thead>
            <tr><th>Image</th><SortHeader keyName="property" label="Property" /><th>Town</th><th>Postcode</th><th>Rooms</th><th>Tags</th><SortHeader keyName="actions" label="Actions" /><th>Status</th></tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8}><div className="empty-state"><h3>Loading properties…</h3></div></td></tr>
            ) : rows.map((property) => (
              <tr
                key={property.id}
                className="hh-act-row"
                tabIndex={0}
                aria-label={`Open ${property.name}`}
                onClick={() => navigate(propertyPath(property))}
                onKeyDown={(event) => { if (event.key === "Enter") navigate(propertyPath(property)); }}
                data-testid={`row-property-${property.id}`}
              >
                <td><PropertyThumb property={property} className="small" /></td>
                <td><strong>{property.name}</strong></td>
                <td>{property.town ?? "—"}</td>
                <td className="hh-nowrap">{property.postcode ?? "—"}</td>
                <td className="hh-rooms-cell">
                  <span>{property.roomsOccupied === null ? "?" : property.roomsOccupied}/{property.totalRooms}</span>
                  <OccupancyBar occupied={property.roomsOccupied} total={property.totalRooms} />
                </td>
                <td><div className="hh-act-tags">{property.tags.length ? property.tags.map((tag) => <span key={tag}>{tag}</span>) : <span className="secondary-text" style={{ background: "none", padding: 0, margin: 0 }}>—</span>}</div></td>
                <td><ActionsBadge count={property.openActionsCount} variant="pill" /></td>
                <td><span className={`status ${property.deactivated ? "cancelled" : property.source === "register" ? "pending" : "completed"}`}>{statusLabel(property)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
