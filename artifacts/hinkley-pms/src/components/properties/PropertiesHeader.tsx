import { House, LayoutGrid, List } from "lucide-react";
import type { ViewMode } from "@/services/properties";

export function PropertiesHeader({ view, onViewChange, count }: { view: ViewMode; onViewChange: (view: ViewMode) => void; count: number | null }) {
  return (
    <div className="hh-props-head">
      <h1 className="page-title"><House size={24} aria-hidden="true" /> Properties{count !== null && <span className="hh-props-count">{count}</span>}</h1>
      <div className="hh-view-toggle" role="group" aria-label="View">
        <button type="button" className={`icon-btn ${view === "grid" ? "active" : ""}`} aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => onViewChange("grid")} data-testid="button-view-grid">
          <LayoutGrid size={17} />
        </button>
        <button type="button" className={`icon-btn ${view === "list" ? "active" : ""}`} aria-label="List view" aria-pressed={view === "list"} onClick={() => onViewChange("list")} data-testid="button-view-list">
          <List size={17} />
        </button>
      </div>
    </div>
  );
}
