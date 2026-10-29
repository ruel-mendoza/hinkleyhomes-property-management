import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, ArrowRight, BellPlus, Check, Download, ExternalLink, Lightbulb, Search, X } from "lucide-react";
import { getGetFinanceBankFeedQueryKey, useGetFinanceBankFeed, useSyncRentMatchActions, type FinanceBankLine, type FinanceBankLineStatus } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { downloadText, formatDate } from "@/services/properties";
import "./finance.css";

// Rent bank feed: COHO's bank lines and whether each has been matched to rent,
// plus our suggestion of which unmatched line may pay an overdue tenancy.
// Each suggestion is also raised as a COHO action (hourly, or "Add to COHO
// actions") so staff see it in COHO; the matching itself is done in COHO.

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
// COHO's Transactions page, where the Reconcile step happens. Set
// VITE_COHO_TRANSACTIONS_URL to its exact address; COHO's API can't reconcile.
const COHO_TRANSACTIONS_URL = (import.meta.env.VITE_COHO_TRANSACTIONS_URL as string | undefined) || "https://coho.life/";

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
          <ReconcilePanel lines={suggested} unmatched={data.unmatchedCount} />
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

// Reconcile proposals, laid out like COHO's Reconcile transactions panel:
// the bank line on the left, the overdue rent it may pay on the right.
function ReconcilePanel({ lines, unmatched }: { lines: FinanceBankLine[]; unmatched: number }) {
  const queryClient = useQueryClient();
  const raise = useSyncRentMatchActions();
  const [message, setMessage] = useState("");
  const notRaised = lines.filter((line) => !line.possibleMatch?.cohoActionReference).length;
  const addToCoho = async () => {
    setMessage("");
    try {
      const result = await raise.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: getGetFinanceBankFeedQueryKey() });
      setMessage(`${result.created ? `Added ${result.created} to COHO actions` : "Nothing new to add"}${result.closed ? ` · ${result.closed} completed` : ""}${result.waiting ? ` · ${result.waiting} more next hour` : ""}.`);
    } catch (error) {
      setMessage(`Could not add to COHO actions: ${errorText(error)}`);
    }
  };
  return (
    <section className="panel hh-rec" aria-labelledby="reconcile-title">
      <div className="panel-head">
        <div>
          <div className="panel-title" id="reconcile-title"><Lightbulb size={15} /> Reconcile transactions</div>
          <div className="panel-caption">
            {lines.length
              ? `${lines.length} unmatched ${lines.length === 1 ? "payment looks" : "payments look"} like overdue rent. Check each one, then reconcile it in COHO so the arrears clear.${notRaised ? "" : " Each one is in COHO's Actions list."}`
              : `No unmatched payment matches an overdue rent amount${unmatched ? `; the ${unmatched} unmatched ${unmatched === 1 ? "line needs" : "lines need"} reviewing in COHO` : ""}.`}
          </div>
          {(raise.isPending || message) && <div className="panel-caption" role="status">{raise.isPending ? "Adding to COHO actions…" : message}</div>}
        </div>
        <div className="head-actions">
          {notRaised > 0 && <button type="button" className="button" onClick={() => void addToCoho()} disabled={raise.isPending} data-testid="button-bank-feed-coho-actions"><BellPlus size={13} /> Add to COHO actions</button>}
          <a className="button" href={COHO_TRANSACTIONS_URL} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Open COHO</a>
        </div>
      </div>
      {lines.length > 0 && (
        <ol className="hh-rec-list">
          {lines.map((line) => {
            const match = line.possibleMatch!;
            return (
              <li key={line.id} className="hh-rec-item">
                <dl className="hh-rec-card bank" aria-label="Bank transaction">
                  <div><dt>Date</dt><dd>{formatDate(line.date)}</dd></div>
                  <div><dt>Bank</dt><dd>{line.account ?? "—"}</dd></div>
                  <div><dt>Reference</dt><dd>{line.reference ?? line.description ?? "—"}</dd></div>
                  <div><dt>Name</dt><dd>{line.payer ?? "—"}</dd></div>
                  <div><dt>Amount</dt><dd className="amount">{pence.format(line.amount)}</dd></div>
                </dl>
                <div className="hh-rec-arrow" aria-hidden="true"><ArrowRight size={18} /></div>
                <div className="hh-rec-card proposal">
                  <div className="hh-rec-tag">Proposed rent</div>
                  <dl>
                    <div><dt>Property</dt><dd><Link href={`/properties/${encodeURIComponent(match.propertyReference)}`}>{match.propertyName}</Link></dd></div>
                    <div><dt>Tenant</dt><dd>{match.tenantName ?? "—"}{match.tenancyNumber ? <small> · {match.tenancyNumber}</small> : null}</dd></div>
                    <div><dt>Rent due</dt><dd>{formatDate(match.earliestDue)} · {match.daysInArrears} {match.daysInArrears === 1 ? "day" : "days"} overdue</dd></div>
                    <div><dt>Overdue</dt><dd className="amount">{pence.format(match.outstanding)}</dd></div>
                  </dl>
                  <p className="hh-rec-reason">{match.reason}</p>
                  <div className="hh-rec-actions">
                    <a className="button primary" href={COHO_TRANSACTIONS_URL} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Reconcile in COHO</a>
                    <Link className="button" href={`/properties/${encodeURIComponent(match.propertyReference)}`}>View property</Link>
                    {match.cohoActionReference && <span className="hh-rec-raised"><Check size={13} /> In COHO actions</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="hh-rec-foot">Proposals are worked out here (same amount as the overdue rent, received from a week before it was due). Each one is added to COHO's Actions list every hour and completed once the payment is matched. Linking the payment is done in COHO: Transactions → Reconcile transactions → OK.</p>
    </section>
  );
}
