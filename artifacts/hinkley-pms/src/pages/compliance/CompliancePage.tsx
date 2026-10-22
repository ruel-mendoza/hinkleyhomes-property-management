import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Download, Search, X } from "lucide-react";
import {
  getGetComplianceQueryKey,
  useGetCompliance,
  type ComplianceFilter,
  type ComplianceItemStatus,
  type ComplianceRow,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { downloadText, formatDate } from "@/services/properties";
import "./compliance.css";

// Compliance page, modelled on COHO's Compliance screen. Rows come from
// GET /api/compliance (COHO's compliance overview plus each property's records).

const FILTERS: { key: ComplianceFilter; label: string }[] = [
  { key: "expired", label: "Expired" },
  { key: "due_30", label: "Due within 30 days" },
  { key: "due_60", label: "Due within 60 days" },
  { key: "due_90", label: "Due within 90 days" },
  { key: "not_started", label: "Not started (no record)" },
  { key: "not_required", label: "Not required" },
  { key: "all", label: "All items" },
];
const STATUS: Record<ComplianceItemStatus, [string, string]> = {
  expired: ["Expired", "overdue"],
  due_soon: ["Due soon", "pending"],
  not_started: ["No record", "na"],
  not_required: ["Not required", "na"],
  in_date: ["In date", "completed"],
};
// Tile colour for the selected filter, so the tiles read like COHO's.
const FILTER_TONE: Record<ComplianceFilter, string> = {
  expired: "bad", due_30: "warn", due_60: "warn", due_90: "warn", not_started: "info", not_required: "neutral", all: "info",
};

export const complianceQuery = (status: ComplianceFilter) => ({
  params: { status },
  options: { query: { queryKey: getGetComplianceQueryKey({ status }), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 } },
});

type SortKey = "property" | "type" | "status" | "carriedOut" | "expiry";
const STATUS_ORDER: ComplianceItemStatus[] = ["expired", "due_soon", "not_started", "in_date", "not_required"];

const relative = (date: string | null, today: string) => {
  if (!date) return null;
  const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return "today";
  return days < 0 ? `${-days} ${days === -1 ? "day" : "days"} ago` : `in ${days} ${days === 1 ? "day" : "days"}`;
};

export default function CompliancePage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter = (FILTERS.some((item) => item.key === params.get("status")) ? params.get("status") : "expired") as ComplianceFilter;
  const category = params.get("category") ?? "";
  const type = params.get("type") ?? "";
  const term = params.get("q") ?? "";
  const setParams = (change: Partial<Record<"status" | "category" | "type" | "q", string>>) => {
    const next = { status: filter, category, type, q: term, ...change };
    const query = new URLSearchParams();
    if (next.status !== "expired") query.set("status", next.status);
    if (next.category) query.set("category", next.category);
    if (next.type) query.set("type", next.type);
    if (next.q) query.set("q", next.q);
    navigate(`/compliance${query.size ? `?${query}` : ""}`, { replace: true });
  };
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });

  const { params: queryParams, options } = complianceQuery(filter);
  const query = useGetCompliance(queryParams, options);
  const data = query.data;

  // Property filters set the tile counts; category and type tiles then narrow the table.
  const inScope = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (data?.rows ?? []).filter((row) =>
      (!selectedPropertyReference || row.propertyReference === selectedPropertyReference) &&
      (!needle || row.propertyName.toLowerCase().includes(needle)),
    );
  }, [data, term, selectedPropertyReference]);
  const count = (predicate: (row: ComplianceRow) => boolean) => inScope.filter(predicate).length;
  const selectedCategory = data?.categories.find((item) => item.key === category);
  const typeTiles = (selectedCategory ? [selectedCategory] : (data?.categories ?? []).filter((item) => item.types.length > 1 && count((row) => row.categoryKey === item.key) > 0))
    .flatMap((item) => item.types.map((typeItem) => ({ ...typeItem, categoryKey: item.key })));

  const rows = useMemo(() => {
    const visible = inScope.filter((row) => (!category || row.categoryKey === category) && (!type || row.typeKey === type));
    const value = (row: ComplianceRow) =>
      sort.key === "property" ? row.propertyName
        : sort.key === "type" ? `${row.categoryName} ${row.typeName}`
          : sort.key === "status" ? String(STATUS_ORDER.indexOf(row.status)).padStart(2, "0") + (row.expiry ?? "9999")
            : (row[sort.key] ?? "9999");
    return [...visible].sort((a, b) => sort.dir * value(a).localeCompare(value(b), "en-GB", { numeric: true }) || a.propertyName.localeCompare(b.propertyName, "en-GB", { numeric: true }));
  }, [inScope, category, type, sort]);

  const tone = FILTER_TONE[filter];
  const SortHeader = ({ keyName, label }: { keyName: SortKey; label: string }) => {
    const active = sort.key === keyName;
    const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <th aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="hh-sort" onClick={() => setSort((current) => ({ key: keyName, dir: current.key === keyName && current.dir === 1 ? -1 : 1 }))}>{label} <Icon size={12} /></button>
      </th>
    );
  };

  const exportCsv = () => {
    const cell = (value: string | null) => (value === null ? "" : /[",\r\n]/.test(value) || /^[=+\-@]/.test(value) ? `"${value.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : value);
    const lines = [["property", "category", "type", "status", "carriedOut", "expiry"].join(","), ...rows.map((row) => [row.propertyName, row.categoryName, row.typeName, STATUS[row.status][0], row.carriedOut, row.expiry].map(cell).join(","))];
    downloadText(`hinkley-compliance-${filter}-${data?.asOf ?? "export"}.csv`, lines.join("\r\n"));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO</div>
          <h1 className="page-title">Compliance</h1>
          <p className="page-sub">Certificates, safety tests and licences for every property{data ? ` · as of ${formatDate(data.asOf)}` : ""}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" onClick={exportCsv} disabled={!rows.length} data-testid="button-compliance-export"><Download size={14} /> Export (CSV)</button>
        </div>
      </div>

      <div className="hh-comp-filter">
        <select className="select-control hh-comp-select" value={filter} onChange={(event) => setParams({ status: event.target.value, category: "", type: "" })} aria-label="Compliance status" data-testid="select-compliance-status">
          {FILTERS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
        <div className="hh-comp-search">
          <Search size={14} />
          <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="All properties" aria-label="Filter by property" data-testid="input-compliance-search" />
          {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear property filter"><X size={13} /></button>}
        </div>
      </div>

      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Compliance could not be loaded from COHO: {errorText(query.error)}</p>}
      {data && data.datesUnavailable.length > 0 && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Dates could not be loaded for {data.datesUnavailable.join(", ")}.</p>}

      <div className="hh-comp-tiles" role="group" aria-label="Filter by compliance type">
        {(data?.categories ?? []).map((item) => {
          const value = count((row) => row.categoryKey === item.key);
          const active = category === item.key;
          return (
            <button key={item.key} type="button" className={`hh-comp-tile ${value ? tone : ""} ${active ? "active" : ""}`} aria-pressed={active} onClick={() => setParams({ category: active ? "" : item.key, type: "" })} data-testid={`tile-compliance-${item.key}`}>
              <strong>{value}</strong><span>{item.name}</span>
            </button>
          );
        })}
        {data && (
          <button type="button" className={`hh-comp-tile ${inScope.length ? tone : ""} ${!category ? "active" : ""}`} aria-pressed={!category} onClick={() => setParams({ category: "", type: "" })} data-testid="tile-compliance-all">
            <strong>{inScope.length}</strong><span>All</span>
          </button>
        )}
        {!data && query.isLoading && <div className="hh-comp-loading">Loading compliance from COHO…</div>}
      </div>

      {typeTiles.length > 1 && (
        <div className="hh-comp-tiles sub" role="group" aria-label="Filter by item">
          {typeTiles.map((item) => {
            const value = count((row) => row.typeKey === item.key);
            const active = type === item.key;
            return (
              <button key={item.key} type="button" className={`hh-comp-tile ${value ? tone : ""} ${active ? "active" : ""}`} aria-pressed={active} onClick={() => setParams({ category: item.categoryKey, type: active ? "" : item.key })}>
                <strong>{value}</strong><span>{item.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-comp-table">
            <thead>
              <tr><SortHeader keyName="property" label="Property" /><SortHeader keyName="type" label="Type" /><SortHeader keyName="status" label="Status" /><SortHeader keyName="carriedOut" label="Carried out" /><SortHeader keyName="expiry" label="Expiry date" /></tr>
            </thead>
            <tbody>
              {query.isLoading ? (
                <tr><td colSpan={5}><div className="empty-state"><h3>Loading compliance from COHO…</h3></div></td></tr>
              ) : !rows.length ? (
                <tr><td colSpan={5}><div className="empty-state"><h3>Nothing to show</h3><p>No {FILTERS.find((item) => item.key === filter)?.label.toLowerCase()} items match these filters.</p></div></td></tr>
              ) : rows.map((row) => {
                const [label, chip] = STATUS[row.status];
                const when = data ? relative(row.expiry, data.asOf) : null;
                return (
                  <tr key={`${row.propertyReference}-${row.typeKey}`} data-testid={`row-compliance-${row.propertyReference}-${row.typeKey}`}>
                    <td><Link href={`/properties/${encodeURIComponent(row.propertyReference)}`} className="hh-comp-property">{row.propertyName}</Link></td>
                    <td>{row.categoryName === row.typeName ? row.typeName : <>{row.categoryName} <span className="hh-comp-sep">›</span> {row.typeName}</>}</td>
                    <td><span className={`status ${chip}`}>{label}</span></td>
                    <td className="hh-nowrap">{row.carriedOut ? formatDate(row.carriedOut) : "—"}</td>
                    <td className="hh-nowrap">{row.expiry ? <>{formatDate(row.expiry)}{when && <small className={`hh-comp-when ${row.status}`}>{when}</small>}</> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
