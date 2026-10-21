import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { AlertTriangle, Download, FileBarChart } from "lucide-react";
import { getListPropertiesQueryKey, useListProperties } from "@workspace/api-client-react";
import {
  DEFAULT_FILTERS,
  allTags,
  downloadText,
  filterProperties,
  filtersFromSearch,
  filtersToSearch,
  hasActiveFilters,
  propertiesCsv,
  type PropertyFilters,
} from "@/services/properties";
import { errorText } from "@/components/action-modals";
import { PropertiesHeader } from "@/components/properties/PropertiesHeader";
import { ActionBar } from "@/components/properties/ActionBar";
import { FilterPanel } from "@/components/properties/FilterPanel";
import { PropertyGrid } from "@/components/properties/PropertyGrid";
import { PropertyTable } from "@/components/properties/PropertyTable";
import { NewPropertyModal } from "@/components/properties/NewPropertyModal";
import { NewBuildingModal } from "@/components/properties/NewBuildingModal";
import { WebsiteWidgetModal } from "@/components/properties/WebsiteWidgetModal";
import { ReportModal } from "@/components/properties/ReportModal";
import "./properties.css";

type Modal = "property" | "building" | "widget" | "report" | null;

export default function PropertiesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const setFilters = (change: Partial<PropertyFilters>) => {
    const query = filtersToSearch({ ...filters, ...change });
    navigate(`/properties${query ? `?${query}` : ""}`, { replace: true });
  };
  const clearFilters = () => setFilters({ ...DEFAULT_FILTERS, view: filters.view });

  const listQuery = useListProperties({ query: { queryKey: getListPropertiesQueryKey(), refetchInterval: 120_000 } });
  const all = listQuery.data?.items ?? [];
  const visible = useMemo(() => filterProperties(all, filters), [all, filters]);
  const tags = useMemo(() => allTags(all), [all]);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const exportCsv = () => {
    const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    downloadText(`hinkley-properties-${stamp}.csv`, propertiesCsv(visible));
    setToast(`Exported ${visible.length} ${visible.length === 1 ? "property" : "properties"}.`);
  };
  const loading = listQuery.isLoading;
  const filtered = hasActiveFilters(filters);

  return (
    <>
      <PropertiesHeader view={filters.view} onViewChange={(view) => setFilters({ view })} count={listQuery.data ? visible.length : null} />
      <ActionBar onNewProperty={() => setModal("property")} onNewBuilding={() => setModal("building")} onWidget={() => setModal("widget")} />
      <FilterPanel filters={filters} tags={tags} onChange={setFilters} />

      {listQuery.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Properties could not be loaded: {errorText(listQuery.error)}</p>}
      {listQuery.data?.cohoError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> COHO couldn't be reached, so only properties saved in this app are shown. ({listQuery.data.cohoError})</p>}

      {filters.view === "grid"
        ? <PropertyGrid items={visible} loading={loading} filtered={filtered} onClear={clearFilters} />
        : <PropertyTable items={visible} loading={loading} filtered={filtered} onClear={clearFilters} />}

      <div className="hh-props-footer">
        <button type="button" className="button" onClick={exportCsv} disabled={loading || !visible.length} data-testid="button-export-csv"><Download size={14} /> Export (CSV)</button>
        <button type="button" className="button" onClick={() => setModal("report")} disabled={loading} data-testid="button-report"><FileBarChart size={14} /> Report</button>
      </div>

      {modal === "property" && (
        <NewPropertyModal
          tagOptions={tags}
          onClose={() => setModal(null)}
          onSaved={(property) => { setModal(null); setToast(`${property.name} added to the property register. Remember to add it in COHO too.`); }}
        />
      )}
      {modal === "building" && (
        <NewBuildingModal
          properties={all.filter((property) => !property.deactivated)}
          onClose={() => setModal(null)}
          onSaved={(building) => { setModal(null); setToast(`Building “${building.name}” saved with ${building.propertyCount} ${building.propertyCount === 1 ? "property" : "properties"}.`); }}
        />
      )}
      {modal === "widget" && <WebsiteWidgetModal onClose={() => setModal(null)} />}
      {modal === "report" && <ReportModal items={visible} filtered={filtered} onClose={() => setModal(null)} />}
      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}
