import { useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { AlertTriangle, Download, Search, X } from "lucide-react";
import { getGetFinanceBankFeedQueryKey, useGetFinanceBankFeed, type FinanceBankLineStatus } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { downloadText, formatDate } from "@/services/properties";
import "./finance.css";

// Rent bank feed: COHO's bank lines and whether each has been matched to rent.
// Read-only here; matching is done in COHO.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const bankFeedQueryOptions = { query: { queryKey: getGetFinanceBankFeedQueryKey(), staleTime: 15 * 60_000 } };

type Filter = "unmatched" | "matched" | "excluded" | "all";
const STATUS: Record<FinanceBankLineStatus, [string, string]> = {
  unmatched: ["Unmatched", "overdue"],
  partly_matched: ["Partly matched", "pending"],
  matched: ["Matched", "completed"],
  excluded: ["Excluded", "na"],
};
const inFilter = (status: FinanceBankLineStatus, filter: Filter) =>
  filter === "all" || (filter === "unmatched" ? status === "unmatched" || status === "partly_matched" : status === filter);
export const daysSince = (date: string | null, today: string) => (date ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0);

export default function BankFeedPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const filter = (["unmatched", "matched", "excluded", "all"].includes(params.get("status") ?? "") ? params.get("status") : "unmatched") as Filter;
  const term = params.get("q") ?? "";
  const setParams = (change: { status?: Filter; q?: string }) => {
    const next = new URLSearchParams();
    const status = change.status ?? filter;
    const q = change.q ?? term;
    if (status !== "unmatched") next.set("status", status);
    if (q) next.set("q", q);
    navigate(`/bank-feed${next.size ? `?${next}` : ""}`, { replace: true });
  };

  const query = useGetFinanceBankFeed(bankFeedQueryOptions);
  const data = query.data;
  const lines = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (data?.lines ?? []).filter((line) =>
      inFilter(line.status, filter) &&
      (!needle || [line.payer, line.reference, line.description, String(line.amount)].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [data, filter, term]);
  const oldestDays = data ? daysSince(data.oldestUnmatched, data.asOf) : 0;

  const exportCsv = () => {
    if (!data) return;
    const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) || /^[=+\-@]/.test(String(value)) ? `"${String(value).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : String(value));
    const rows = [["date", "amount", "payer", "reference", "description", "status"].join(","), ...lines.map((line) => [line.date, line.amount, line.payer, line.reference, line.description, STATUS[line.status][0]].map(cell).join(","))];
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
          {data.unmatchedCount > 0 && oldestDays > 30 && (
            <p className="hh-props-alert" role="alert">
              <AlertTriangle size={14} /> {data.unmatchedCount} bank {data.unmatchedCount === 1 ? "line is" : "lines are"} not matched to rent in COHO ({pence.format(data.unmatchedAmount)}), the oldest from {formatDate(data.oldestUnmatched)}. Rent may be being marked paid by hand; matching these in COHO keeps rent records reliable.
            </p>
          )}
          <div className="hh-fin-tiles" role="group" aria-label="Filter by match status">
            {tile("unmatched", "Unmatched", data.unmatchedCount, `${pence.format(data.unmatchedAmount)}${data.oldestUnmatched ? ` · oldest ${oldestDays} days` : ""}`, "bad")}
            {tile("matched", "Matched to rent", data.matchedCount, pence.format(data.matchedAmount), "good")}
            {tile("excluded", "Excluded", data.excludedCount, "Not rent", "neutral")}
            {tile("all", "All lines", data.lines.length, "Last 12 months", "info")}
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

          <div className="hh-fin-filter">
            <Search size={14} />
            <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Search payer, reference or amount" aria-label="Search bank lines" data-testid="input-bank-feed-search" />
            {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
          </div>

          <section className="panel table-panel">
            <div className="table-wrap">
              <table className="hh-fin-table">
                <thead><tr><th>Date</th><th className="num">Amount</th><th>Payer</th><th>Reference</th><th>Status</th></tr></thead>
                <tbody>
                  {lines.map((line) => {
                    const [label, chip] = STATUS[line.status];
                    return (
                      <tr key={line.id}>
                        <td className="hh-nowrap">{formatDate(line.date)}</td>
                        <td className="num">{pence.format(line.amount)}</td>
                        <td>{line.payer ?? "—"}{line.description && line.description !== line.payer && <small className="hh-fin-sub">{line.description}</small>}</td>
                        <td>{line.reference ?? "—"}</td>
                        <td><span className={`status ${chip}`}>{label}</span>{line.possibleDuplicate && <small className="hh-fin-sub warn">Possible duplicate</small>}</td>
                      </tr>
                    );
                  })}
                  {!lines.length && <tr><td colSpan={5}><div className="empty-state"><h3>No bank lines</h3><p>Nothing matches this filter.</p></div></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          <p className="hh-fin-foot">Matching is done in COHO. The Xero Banking panel on the overview covers every company's bank accounts; this page is only the rent account COHO watches.</p>
        </>
      )}
    </>
  );
}
