import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, Download, Search, X } from "lucide-react";
import { getGetFinanceIncomeQueryKey, useGetFinanceIncome, type FinanceItem } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { downloadText, formatDate } from "@/services/properties";
import "./finance.css";

// Rent & fees: COHO financial items (rent invoiced as client money, management
// fees as Hinkley income) for the last 12 months. Charts, tiles and tables are
// worked out from the item list, so the property and owner filters apply to all
// of them. Expenses are kept in Xero.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const incomeQueryOptions = { query: { queryKey: getGetFinanceIncomeQueryKey(), staleTime: 15 * 60_000 } };

const CATEGORY_LABEL: Record<FinanceItem["category"], string> = { rent: "Rent", management_fee: "Management fee", other: "Other" };
const PAID_LABEL: Record<string, [string, string]> = {
  paid: ["Paid", "completed"],
  manuallyPaid: ["Paid (manual)", "completed"],
  partiallyPaid: ["Part paid", "pending"],
  unpaid: ["Unpaid", "overdue"],
};
const byName = (a: string, b: string) => a.localeCompare(b, "en-GB", { numeric: true });

export default function FinanceIncomePage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/finance${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const property = selectedPropertyReference ?? get("property");
  const owner = get("owner");
  const [from, to, category, paid, min, max, term] = ["from", "to", "category", "paid", "min", "max", "q"].map(get);

  const query = useGetFinanceIncome(incomeQueryOptions);
  const data = query.data;
  const allItems = data?.items ?? [];
  const propertyOptions = useMemo(() => [...new Map(allItems.map((item) => [item.propertyReference, item.propertyName])).entries()].sort((a, b) => byName(a[1], b[1])), [allItems]);
  const ownerOptions = useMemo(() => [...new Map(allItems.filter((item) => item.ownerReference).map((item) => [item.ownerReference!, item.ownerName ?? item.ownerReference!])).entries()].sort((a, b) => byName(a[1], b[1])), [allItems]);

  // Property and owner shape everything; the remaining filters only narrow the item list.
  const scoped = allItems.filter((item) => (!property || item.propertyReference === property) && (!owner || item.ownerReference === owner));
  const listed = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const minimum = min ? Number(min) : null;
    const maximum = max ? Number(max) : null;
    return scoped.filter((item) =>
      (!from || item.invoiceDate >= from) && (!to || item.invoiceDate <= to) &&
      (!category || item.category === category) &&
      (!paid || (paid === "unpaid" ? item.unpaid > 0 : item.unpaid === 0)) &&
      (minimum === null || item.amount >= minimum) && (maximum === null || item.amount <= maximum) &&
      (!needle || [item.propertyName, item.tenantName, item.ownerName, item.categoryName].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [scoped, from, to, category, paid, min, max, term]);

  const sum = (items: FinanceItem[], kind: FinanceItem["category"]) => items.filter((item) => item.category === kind).reduce((total, item) => total + item.amount, 0);
  const rentTotal = sum(scoped, "rent");
  const feesTotal = sum(scoped, "management_fee");
  const unpaidItems = scoped.filter((item) => item.category === "rent" && item.unpaid > 0);
  const months = (data?.months ?? []).map((month) => {
    const inMonth = scoped.filter((item) => item.invoiceDate.startsWith(month.month));
    return { month: month.month, rent: sum(inMonth, "rent"), fees: sum(inMonth, "management_fee") };
  });
  const perProperty = [...scoped.reduce((map, item) => {
    const row = map.get(item.propertyReference) ?? { reference: item.propertyReference, name: item.propertyName, owner: item.ownerName, rent: 0, fees: 0, unpaid: 0, lastPaid: null as string | null };
    if (item.category === "rent") {
      row.rent += item.amount;
      row.unpaid += item.unpaid;
      if (item.paidDate && (!row.lastPaid || item.paidDate > row.lastPaid)) row.lastPaid = item.paidDate;
    } else if (item.category === "management_fee") row.fees += item.amount;
    return map.set(item.propertyReference, row);
  }, new Map<string, { reference: string; name: string; owner: string | null; rent: number; fees: number; unpaid: number; lastPaid: string | null }>()).values()].sort((a, b) => byName(a.name, b.name));
  const scopeLabel = property ? propertyOptions.find(([reference]) => reference === property)?.[1] ?? "Selected property" : owner ? ownerOptions.find(([reference]) => reference === owner)?.[1] ?? "Selected owner" : "All properties";
  const listFilters = Boolean(from || to || category || paid || min || max || term);

  const exportCsv = () => {
    if (!data) return;
    const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) || /^[=+\-@]/.test(String(value)) ? `"${String(value).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : String(value));
    const lines = [
      ["invoiceDate", "category", "property", "tenant", "owner", "amount", "unpaid", "paidStatus", "paidDate"].join(","),
      ...listed.map((item) => [item.invoiceDate, item.categoryName, item.propertyName, item.tenantName, item.ownerName, item.amount, item.unpaid, item.paidStatus, item.paidDate].map(cell).join(",")),
    ];
    downloadText(`hinkley-financial-items-${data.asOf}.csv`, lines.join("\r\n"));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO finance</div>
          <h1 className="page-title">Rent &amp; fees</h1>
          <p className="page-sub">Rent invoiced and management fees{data ? ` · ${formatDate(data.from)} to ${formatDate(data.asOf)}` : " · last 12 months"}</p>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading from COHO…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Rent and fees could not be loaded from COHO: {errorText(query.error)}</p>}

      {data && (
        <>
          <section className="hh-fin-filters" aria-label="Choose properties and owners">
            <label className="hh-fin-field">
              <span>Property</span>
              <select className="select-control" value={property} disabled={Boolean(selectedPropertyReference)} onChange={(event) => setParams({ property: event.target.value })} data-testid="select-finance-property">
                <option value="">All properties</option>
                {propertyOptions.map(([reference, name]) => <option key={reference} value={reference}>{name}</option>)}
              </select>
            </label>
            <label className="hh-fin-field">
              <span>Owner</span>
              <select className="select-control" value={owner} onChange={(event) => setParams({ owner: event.target.value })} data-testid="select-finance-owner">
                <option value="">All owners</option>
                {ownerOptions.map(([reference, name]) => <option key={reference} value={reference}>{name}</option>)}
              </select>
            </label>
            {(get("property") || owner) && <button type="button" className="button" onClick={() => setParams({ property: "", owner: "" })}><X size={13} /> Clear</button>}
          </section>

          <div className="hh-fin-tiles">
            <div className="hh-fin-tile"><span>Rent invoiced</span><strong>{pounds.format(rentTotal)}</strong><small>{scopeLabel} · client money</small></div>
            <div className="hh-fin-tile"><span>Management fees</span><strong>{pounds.format(feesTotal)}</strong><small>Hinkley Homes income</small></div>
            <div className="hh-fin-tile"><span>Fee rate</span><strong>{rentTotal ? `${((feesTotal / rentTotal) * 100).toFixed(1)}%` : "—"}</strong><small>Fees as a share of rent</small></div>
            <div className={`hh-fin-tile ${unpaidItems.length ? "bad" : ""}`}><span>Unpaid rent</span><strong>{pounds.format(unpaidItems.reduce((total, item) => total + item.unpaid, 0))}</strong><small>{unpaidItems.length} {unpaidItems.length === 1 ? "invoice" : "invoices"} · <Link href="/bank-feed?status=suggested">check bank feed</Link></small></div>
          </div>

          <div className="hh-fin-charts">
            <section className="panel">
              <div className="panel-head"><div><div className="panel-title">Rent invoiced per month</div><div className="panel-caption">{scopeLabel}</div></div></div>
              <div className="hh-fin-chart"><MonthlyBars title="Rent invoiced per month" data={months} series={[{ key: "rent", label: "Rent", colour: SERIES_COLOURS.blue }]} /></div>
            </section>
            <section className="panel">
              <div className="panel-head"><div><div className="panel-title">Management fees per month</div><div className="panel-caption">{scopeLabel} · charged when rent is paid</div></div></div>
              <div className="hh-fin-chart"><MonthlyBars title="Management fees per month" data={months} series={[{ key: "fees", label: "Management fees", colour: SERIES_COLOURS.orange }]} /></div>
            </section>
          </div>

          <section className="panel table-panel hh-fin-section">
            <div className="panel-head">
              <div><div className="panel-title">Financial items</div><div className="panel-caption">Every rent and fee item in COHO for {scopeLabel.toLowerCase() === "all properties" ? "all properties" : scopeLabel}</div></div>
              <button type="button" className="button" onClick={exportCsv} disabled={!listed.length} data-testid="button-finance-export"><Download size={14} /> Export (CSV)</button>
            </div>
            <div className="hh-fin-filters inset" aria-label="Filter financial items">
              <label className="hh-fin-field"><span>From</span><input type="date" value={from} min={data.from} max={data.asOf} onChange={(event) => setParams({ from: event.target.value })} /></label>
              <label className="hh-fin-field"><span>To</span><input type="date" value={to} min={data.from} max={data.asOf} onChange={(event) => setParams({ to: event.target.value })} /></label>
              <label className="hh-fin-field">
                <span>Category</span>
                <select className="select-control" value={category} onChange={(event) => setParams({ category: event.target.value })}>
                  <option value="">All categories</option><option value="rent">Rent</option><option value="management_fee">Management fee</option>
                </select>
              </label>
              <label className="hh-fin-field">
                <span>Paid status</span>
                <select className="select-control" value={paid} onChange={(event) => setParams({ paid: event.target.value })}>
                  <option value="">Any paid status</option><option value="unpaid">Unpaid</option><option value="paid">Paid</option>
                </select>
              </label>
              <label className="hh-fin-field"><span>Min (£)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={min} onChange={(event) => setParams({ min: event.target.value })} placeholder="0.00" /></label>
              <label className="hh-fin-field"><span>Max (£)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={max} onChange={(event) => setParams({ max: event.target.value })} placeholder="0.00" /></label>
              <label className="hh-fin-field grow">
                <span>Search</span>
                <span className="hh-fin-search"><Search size={14} /><input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Property, tenant or owner" aria-label="Search financial items" /></span>
              </label>
              {listFilters && <button type="button" className="button" onClick={() => setParams({ from: "", to: "", category: "", paid: "", min: "", max: "", q: "" })}><X size={13} /> Clear</button>}
            </div>
            <div className="table-wrap hh-fin-scroll">
              <table className="hh-fin-table">
                <thead><tr><th>Date</th><th>Category</th><th>Property</th><th>Tenant</th><th>Owner</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {listed.map((item) => {
                    const [label, chip] = PAID_LABEL[item.paidStatus] ?? [item.paidStatus, "na"];
                    return (
                      <tr key={item.id}>
                        <td className="hh-nowrap">{formatDate(item.invoiceDate)}</td>
                        <td>{CATEGORY_LABEL[item.category] ?? item.categoryName}</td>
                        <td><Link href={`/properties/${encodeURIComponent(item.propertyReference)}`} className="hh-fin-link">{item.propertyName}</Link></td>
                        <td>{item.tenantName ?? "—"}</td>
                        <td>{item.ownerName ?? "—"}</td>
                        <td className="num">{pence.format(item.amount)}</td>
                        <td><span className={`status ${chip}`}>{label}</span>{item.paidDate && <small className="hh-fin-sub">{formatDate(item.paidDate)}</small>}</td>
                      </tr>
                    );
                  })}
                  {!listed.length && <tr><td colSpan={7}><div className="empty-state"><h3>No financial items</h3><p>Nothing matches these filters.</p></div></td></tr>}
                </tbody>
              </table>
            </div>
            <p className="hh-fin-count">{listed.length} of {scoped.length} items</p>
          </section>

          <div className="hh-fin-charts hh-fin-section">
            <section className="panel table-panel">
              <div className="panel-head"><div><div className="panel-title">By property</div><div className="panel-caption">Rent, fees and unpaid rent over the period</div></div></div>
              <div className="table-wrap">
                <table className="hh-fin-table">
                  <thead><tr><th>Property</th><th className="num">Rent</th><th className="num">Fees</th><th className="num">Unpaid</th><th>Last paid</th></tr></thead>
                  <tbody>
                    {perProperty.map((row) => (
                      <tr key={row.reference}>
                        <td><Link href={`/properties/${encodeURIComponent(row.reference)}`} className="hh-fin-link">{row.name}</Link>{row.owner && <small className="hh-fin-sub">{row.owner}</small>}</td>
                        <td className="num">{pounds.format(row.rent)}</td>
                        <td className="num">{pounds.format(row.fees)}</td>
                        <td className="num">{row.unpaid ? <span className="status overdue">{pounds.format(row.unpaid)}</span> : "—"}</td>
                        <td className="hh-nowrap">{row.lastPaid ? formatDate(row.lastPaid) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><div><div className="panel-title">Also in COHO Finance</div><div className="panel-caption">Not available through COHO's API, or not in use</div></div></div>
              <ul className="hh-fin-notes">
                <li><strong>Expenses and supplier invoices:</strong> none recorded in COHO; costs are kept in Xero (see Banking on the overview).</li>
                <li><strong>Repeating financial items:</strong> none set up.</li>
                <li><strong>Profitability reports, settlements, rent statements and the Xero connection:</strong> managed in COHO.</li>
              </ul>
            </section>
          </div>
        </>
      )}
    </>
  );
}
