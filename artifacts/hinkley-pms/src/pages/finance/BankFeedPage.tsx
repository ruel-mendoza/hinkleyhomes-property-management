import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, Download, Lightbulb, Search, X } from "lucide-react";
import { getGetFinanceBankFeedQueryKey, useGetFinanceBankFeed, type FinanceBankLine, type FinanceBankLineStatus } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { downloadText, formatDate } from "@/services/properties";
import "./finance.css";

// Rent bank feed: COHO's bank lines and whether each has been matched to rent,
// plus our suggestion of which unmatched line may pay an overdue tenancy.
// Read-only here; matching is done in COHO.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const bankFeedQueryOptions = { query: { queryKey: getGetFinanceBankFeedQueryKey(), staleTime: 15 * 60_000 } };

type Filter = "unmatched" | "suggested" | "matched" | "excluded" | "all";
const FILTERS: Filter[] = ["unmatched", "suggested", "matched", "excluded", "all"];
const STATUS: Record<FinanceBankLineStatus, [string, string]> = {
  unmatched: ["Unmatched", "overdue"],
  partly_matched: ["Partly matched", "pending"],
  matched: ["Matched", "completed"],
  excluded: ["Excluded", "na"],
};
const isOpen = (line: FinanceBankLine) => line.status === "unmatched" || line.status === "partly_matched";
const inFilter = (line: FinanceBankLine, filter: Filter) =>
  filter === "all" ? true
    : filter === "unmatched" ? isOpen(line)
      : filter === "suggested" ? Boolean(line.possibleMatch)
        : line.status === filter;
export const daysSince = (date: string | null, today: string) => (date ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0);

export default function BankFeedPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter = (FILTERS.includes(params.get("status") as Filter) ? params.get("status") : "unmatched") as Filter;
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) {
      if (value && !(key === "status" && value === "unmatched")) next.set(key, value);
      else next.delete(key);
    }
    navigate(`/bank-feed${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const term = get("q"), from = get("from"), to = get("to"), min = get("min"), max = get("max"), showSnoozed = get("snoozed") === "1";

  const query = useGetFinanceBankFeed(bankFeedQueryOptions);
  const data = query.data;
  const lines = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const minimum = min ? Number(min) : null;
    const maximum = max ? Number(max) : null;
    return (data?.lines ?? []).filter((line) =>
      inFilter(line, filter) &&
      (showSnoozed || !line.snoozedUntil || line.snoozedUntil < (data?.asOf ?? "")) &&
      (!from || line.date >= from) && (!to || line.date <= to) &&
      (minimum === null || line.amount >= minimum) && (maximum === null || line.amount <= maximum) &&
      (!needle || [line.payer, line.reference, line.description, line.possibleMatch?.propertyName].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [data, filter, term, from, to, min, max, showSnoozed]);
  const suggested = (data?.lines ?? []).filter((line) => line.possibleMatch);
  const oldestDays = data ? daysSince(data.oldestUnmatched, data.asOf) : 0;
  const filtersOn = Boolean(term || from || to || min || max || showSnoozed);

  const exportCsv = () => {
    if (!data) return;
    const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) || /^[=+\-@]/.test(String(value)) ? `"${String(value).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : String(value));
    const rows = [
      ["date", "description", "payee", "account", "amount", "status", "possibleRentFor"].join(","),
      ...lines.map((line) => [line.date, line.reference ?? line.description, line.payer, line.account, line.amount, STATUS[line.status][0], line.possibleMatch?.propertyName ?? null].map(cell).join(",")),
    ];
    downloadText(`hinkley-rent-bank-feed-${filter}-${data.asOf}.csv`, rows.join("\r\n"));
  };

  const tile = (key: Filter, label: string, count: number, detail: string, tone: string) => (
    <button type="button" className={`hh-fin-tile button-tile ${count ? tone : ""} ${filter === key ? "active" : ""}`} aria-pressed={filter === key} onClick={() => setParams({ status: key })} data-testid={`tile-bank-feed-${key}`}>
      <span>{label}</span><strong>{count}</strong><small>{detail}</small>
    </button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO finance</div>
          <h1 className="page-title">Rent bank feed</h1>
          <p className="page-sub">Bank lines COHO receives and whether each is matched to rent{data?.accounts.length ? ` · ${data.accounts.join(", ")}` : ""}{data ? ` · since ${formatDate(data.from)}` : ""}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" onClick={exportCsv} disabled={!lines.length} data-testid="button-bank-feed-export"><Download size={14} /> Export (CSV)</button>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading from COHO…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> The bank feed could not be loaded from COHO: {errorText(query.error)}</p>}

      {data && (
        <>
          {suggested.length > 0 && (
            <section className="hh-fin-suggest" aria-labelledby="possible-rent-title">
              <Lightbulb size={17} />
              <div>
                <h2 id="possible-rent-title">{suggested.length} unmatched {suggested.length === 1 ? "payment looks" : "payments look"} like overdue rent</h2>
                <ul>
                  {suggested.map((line) => (
                    <li key={line.id}>
                      <strong>{pence.format(line.amount)}</strong> on {formatDate(line.date)}{line.payer ? ` from ${line.payer}` : ""} → <Link href={`/properties/${encodeURIComponent(line.possibleMatch!.propertyReference)}`}>{line.possibleMatch!.propertyName}</Link>, overdue {pence.format(line.possibleMatch!.outstanding)} since {formatDate(line.possibleMatch!.earliestDue)}
                    </li>
                  ))}
                </ul>
                <p>Same amount, received around the due date. If they are the rent, match them in COHO (Transactions → Reconcile) so the arrears clear.</p>
              </div>
            </section>
          )}
          {data.unmatchedCount > 0 && oldestDays > 30 && (
            <p className="hh-props-alert" role="alert">
              <AlertTriangle size={14} /> {data.unmatchedCount} bank {data.unmatchedCount === 1 ? "line is" : "lines are"} not matched to rent in COHO ({pence.format(data.unmatchedAmount)}), the oldest from {formatDate(data.oldestUnmatched)}. Rent may be being marked paid by hand; matching these in COHO keeps rent records reliable.
            </p>
          )}
          <div className="hh-fin-tiles five" role="group" aria-label="Filter by match status">
            {tile("unmatched", "Unmatched", data.unmatchedCount, `${pence.format(data.unmatchedAmount)}${data.oldestUnmatched ? ` · oldest ${oldestDays} days` : ""}`, "bad")}
            {tile("suggested", "Possible rent", suggested.length, "Same amount as overdue rent", "info")}
            {tile("matched", "Matched to rent", data.matchedCount, pence.format(data.matchedAmount), "good")}
            {tile("excluded", "Excluded", data.excludedCount, "Not rent", "neutral")}
            {tile("all", "All lines", data.lines.length, "Last 12 months", "neutral")}
          </div>

          <section className="panel hh-fin-section">
            <div className="panel-head"><div><div className="panel-title">Money in per month</div><div className="panel-caption">Matched and unmatched bank lines</div></div></div>
            <div className="hh-fin-chart">
              <MonthlyBars
                title="Bank feed money in per month, matched and unmatched"
                data={data.months}
                stacked
                series={[{ key: "matched", label: "Matched to rent", colour: SERIES_COLOURS.blue }, { key: "unmatched", label: "Unmatched", colour: SERIES_COLOURS.orange }]}
              />
            </div>
          </section>

          <section className="hh-fin-filters" aria-label="Filter bank lines">
            <label className="hh-fin-field"><span>From</span><input type="date" value={from} min={data.from} max={data.asOf} onChange={(event) => setParams({ from: event.target.value })} /></label>
            <label className="hh-fin-field"><span>To</span><input type="date" value={to} min={data.from} max={data.asOf} onChange={(event) => setParams({ to: event.target.value })} /></label>
            <label className="hh-fin-field"><span>Amount from (£)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={min} onChange={(event) => setParams({ min: event.target.value })} placeholder="0.00" /></label>
            <label className="hh-fin-field"><span>Amount to (£)</span><input type="number" inputMode="decimal" min="0" step="0.01" value={max} onChange={(event) => setParams({ max: event.target.value })} placeholder="0.00" /></label>
            <label className="hh-fin-field grow">
              <span>Search</span>
              <span className="hh-fin-search"><Search size={14} /><input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Payee, description or property" aria-label="Search bank lines" data-testid="input-bank-feed-search" /></span>
            </label>
            <label className="hh-fin-check"><input type="checkbox" checked={showSnoozed} onChange={(event) => setParams({ snoozed: event.target.checked ? "1" : "" })} /> Show snoozed</label>
            {filtersOn && <button type="button" className="button" onClick={() => setParams({ q: "", from: "", to: "", min: "", max: "", snoozed: "" })}><X size={13} /> Clear</button>}
          </section>

          <section className="panel table-panel">
            <div className="table-wrap">
              <table className="hh-fin-table">
                <thead><tr><th>Date</th><th>Description</th><th>Payee</th><th>Account</th><th className="num">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {lines.map((line) => {
                    const [label, chip] = STATUS[line.status];
                    return (
                      <tr key={line.id}>
                        <td className="hh-nowrap">{formatDate(line.date)}</td>
                        <td>{line.reference ?? line.description ?? "—"}</td>
                        <td>{line.payer ?? "—"}</td>
                        <td className="hh-nowrap">{line.account ?? "—"}</td>
                        <td className="num">{pence.format(line.amount)}</td>
                        <td>
                          <span className={`status ${chip}`}>{label}</span>
                          {line.possibleMatch && <small className="hh-fin-sub info">Possible rent for {line.possibleMatch.propertyName}</small>}
                          {line.possibleDuplicate && <small className="hh-fin-sub warn">Possible duplicate</small>}
                          {line.snoozedUntil && <small className="hh-fin-sub">Snoozed until {formatDate(line.snoozedUntil)}</small>}
                        </td>
                      </tr>
                    );
                  })}
                  {!lines.length && <tr><td colSpan={6}><div className="empty-state"><h3>No bank lines</h3><p>Nothing matches these filters.</p></div></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <p className="hh-fin-foot">Matching, match rules and rent automation are managed in COHO; its API doesn't expose them. The Xero Banking panel on the overview covers every company's bank accounts; this page is only the rent account COHO watches.</p>
        </>
      )}
    </>
  );
}
