import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import type { PropertyFilters } from "@/services/properties";
import { TagCombobox } from "./TagCombobox";

function Toggle({ label, checked, disabled, onChange, testId }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId: string }) {
  return (
    <label className={`hh-switch ${disabled ? "disabled" : ""}`}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} data-testid={testId}>
        <span />
      </button>
      {label}
    </label>
  );
}

type FilterPanelProps = { filters: PropertyFilters; tags: string[]; onChange: (change: Partial<PropertyFilters>) => void };

export function FilterPanel({ filters, tags, onChange }: FilterPanelProps) {
  const [search, setSearch] = useState(filters.search);
  // Keep the box in step when the URL changes (back button, Clear filters).
  useEffect(() => setSearch(filters.search), [filters.search]);
  useEffect(() => {
    if (search === filters.search) return;
    const timer = setTimeout(() => onChange({ search }), 200);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="hh-filter-panel" aria-label="Filter properties">
      <div className="hh-filter-row">
        <div className="hh-search">
          <Search size={14} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search..." aria-label="Search by name, street, postcode or town" data-testid="input-search-properties" />
          {search && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { setSearch(""); onChange({ search: "" }); }}><X size={13} /></button>}
        </div>
        <TagCombobox value={filters.tags} options={tags} onChange={(next) => onChange({ tags: next })} placeholder="Limit to tags..." label="Limit to tags" />
      </div>
      <div className="hh-filter-row toggles">
        <Toggle label="Actions only" checked={filters.actionsOnly} onChange={(actionsOnly) => onChange({ actionsOnly })} testId="switch-actions-only" />
        <Toggle label="Inactive" checked={filters.inactive && !filters.showAll} disabled={filters.showAll} onChange={(inactive) => onChange({ inactive })} testId="switch-inactive" />
        <Toggle label="Show all" checked={filters.showAll} onChange={(showAll) => onChange({ showAll, inactive: false })} testId="switch-show-all" />
      </div>
    </section>
  );
}
