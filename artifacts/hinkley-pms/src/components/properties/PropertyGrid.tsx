import { SearchX } from "lucide-react";
import type { PropertySummary } from "@workspace/api-client-react";
import { PropertyCard } from "./PropertyCard";

export function EmptyProperties({ onClear, filtered }: { onClear: () => void; filtered: boolean }) {
  return (
    <div className="empty-state hh-props-empty">
      <SearchX size={22} />
      <h3>{filtered ? "No properties match your filters" : "No properties yet"}</h3>
      {filtered && <button type="button" className="button" onClick={onClear} data-testid="button-clear-filters">Clear filters</button>}
    </div>
  );
}

export function PropertyGrid({ items, loading, filtered, onClear }: { items: PropertySummary[]; loading: boolean; filtered: boolean; onClear: () => void }) {
  if (loading) {
    return (
      <div className="hh-prop-grid" aria-busy="true" aria-label="Loading properties">
        {Array.from({ length: 9 }, (_, index) => <div className="hh-prop-card skeleton" key={index}><span className="hh-thumb" /><div className="hh-prop-body"><i /><i /></div></div>)}
      </div>
    );
  }
  if (!items.length) return <EmptyProperties onClear={onClear} filtered={filtered} />;
  return <div className="hh-prop-grid">{items.map((property) => <PropertyCard key={property.id} property={property} />)}</div>;
}
