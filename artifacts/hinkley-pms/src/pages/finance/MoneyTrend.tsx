import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { getGetRevenueTrendQueryKey, useGetFinanceBankFeed, useGetFinanceIncome, useGetRevenueTrend, type RevenueTrendMonth } from "@workspace/api-client-react";
import { MonthlyBars, SERIES_COLOURS, monthLabel } from "@/components/charts/MonthlyBars";
import { formatDate } from "@/services/properties";
import { bankFeedQueryOptions, daysSince } from "./BankFeedPage";
import { incomeQueryOptions } from "./FinanceIncomePage";
import "./finance.css";

// Operations overview: revenue trend from Xero (COHO rent if Xero can't be read),
// a side card (occupancy) and how much of the rent bank feed is matched.
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const compact = (value: number) => (Math.abs(value) >= 1000 ? `${value < 0 ? "-" : ""}£${Math.round(Math.abs(value) / 1000)}k` : pounds.format(value));
// Net profit green passes the palette checks beside blue and orange on #192538; its line is also dashed.
const TREND_SERIES = [
  { key: "revenue", label: "Revenue", colour: SERIES_COLOURS.blue, dashed: false },
  { key: "expenses", label: "Expenses", colour: SERIES_COLOURS.orange, dashed: false },
  { key: "netProfit", label: "Net profit", colour: "#3aa889", dashed: true },
] as const;
const ALL = "all";

export function MoneyTrend({ side }: { side?: ReactNode }) {
  return (
    <div className="hh-trend">
      <RevenueTrend />
      <div className="hh-trend-side">{side}<BankFeedMeter /></div>
    </div>
  );
}

function TrendTooltip({ active, payload, label, current }: TooltipProps<number, string> & { current?: string }) {
  if (!active || !payload?.length) return null;
  const month = String(label);
  return (
    <div className="hh-chart-tip">
      <strong>{monthLabel(month, true)}{month === current ? " (so far)" : ""}</strong>
      {TREND_SERIES.map((item) => (
        <div key={item.key}><i style={{ background: item.colour }} />{item.label}<span>{pounds.format(Number(payload.find((entry) => entry.dataKey === item.key)?.value) || 0)}</span></div>
      ))}
    </div>
  );
}

function RevenueTrend() {
  const trend = useGetRevenueTrend({ query: { queryKey: getGetRevenueTrendQueryKey(), staleTime: 15 * 60_000, retry: false } });
  const [company, setCompany] = useState(ALL);
  const data = trend.data;
  const readable = (data?.companies ?? []).filter((item) => !item.error);
  const failed = (data?.companies ?? []).filter((item) => item.error);
  const xeroDown = trend.isError || (!!data && (!!data.error || readable.length === 0));
  // COHO rent is only fetched when Xero can't give a profit and loss.
  const income = useGetFinanceIncome({ query: { ...incomeQueryOptions.query, enabled: xeroDown } });
  const chosen = readable.some((item) => item.tenantId === company) ? company : ALL;
  const months: RevenueTrendMonth[] = (data?.months ?? []).map((month) => {
    const rows = readable.filter((item) => chosen === ALL || item.tenantId === chosen).map((item) => item.months.find((row) => row.month === month));
    const sum = (key: "revenue" | "expenses" | "netProfit") => Math.round(rows.reduce((total, row) => total + (row?.[key] ?? 0), 0));
    return { month, revenue: sum("revenue"), expenses: sum("expenses"), netProfit: sum("netProfit") };
  });
  const current = data?.months.at(-1);
  const totalNet = months.reduce((total, row) => total + row.netProfit, 0);
  const scope = chosen === ALL ? `${readable.length === 1 ? readable[0].name : "All companies"}` : readable.find((item) => item.tenantId === chosen)?.name;
  const xeroProblem = trend.isError ? "the profit and loss could not be loaded" : data?.error ?? failed[0]?.error ?? "";

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Revenue trend · last 6 months</div>
          <div className="panel-caption">{xeroDown ? "Rent invoiced, from COHO" : data ? `${scope} · net profit ${pounds.format(totalNet)} · from Xero profit and loss` : "From Xero profit and loss"}</div>
        </div>
        <div className="hh-trend-head-actions">
          {readable.length > 1 && (
            <select className="hh-trend-select" value={chosen} onChange={(event) => setCompany(event.target.value)} aria-label="Company" data-testid="select-revenue-company">
              <option value={ALL}>All companies</option>
              {readable.map((item) => <option key={item.tenantId} value={item.tenantId}>{item.name}</option>)}
            </select>
          )}
          <Link href="/finance">Rent &amp; fees →</Link>
        </div>
      </div>
      <div className="hh-fin-chart">
        {trend.isLoading ? <p className="hh-fin-note">Loading profit and loss from Xero…</p>
          : xeroDown ? (
            <>
              <p className="hh-fin-note">Xero profit and loss isn't available ({xeroProblem}), so this shows rent invoiced in COHO.</p>
              {income.isLoading ? <p className="hh-fin-note">Loading from COHO…</p>
                : income.data ? <MonthlyBars title="Rent invoiced per month" height={190} data={income.data.months.slice(-6)} series={[{ key: "rent", label: "Rent", colour: SERIES_COLOURS.blue }]} />
                  : <p className="hh-fin-note">Rent could not be loaded from COHO either.</p>}
            </>
          ) : (
            <figure className="hh-chart" aria-label="Revenue, expenses and net profit per month">
              <ul className="hh-chart-legend">
                {TREND_SERIES.map((item) => <li key={item.key}><i className={item.dashed ? "dashed" : ""} style={{ background: item.colour }} />{item.label}</li>)}
              </ul>
              <div style={{ height: 230 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={months} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="#2a374d" strokeDasharray="2 4" />
                    <XAxis dataKey="month" tickFormatter={(value) => `${monthLabel(String(value))}${value === current ? " (so far)" : ""}`} tick={{ fill: "#8f9db0", fontSize: 12 }} axisLine={{ stroke: "#33425a" }} tickLine={false} />
                    <YAxis tickFormatter={compact} tick={{ fill: "#8f9db0", fontSize: 12 }} axisLine={false} tickLine={false} width={50} />
                    <ReferenceLine y={0} stroke="#41516a" />
                    <Tooltip content={<TrendTooltip current={current} />} cursor={{ stroke: "#5b6b82", strokeDasharray: "3 3" }} />
                    {TREND_SERIES.map((item) => (
                      <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.colour} strokeWidth={2} strokeDasharray={item.dashed ? "6 4" : undefined}
                        dot={{ r: 4, fill: item.colour, stroke: "#192538", strokeWidth: 2 }} activeDot={{ r: 5, stroke: "#192538", strokeWidth: 2 }} isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <details className="hh-chart-table">
                <summary>Show as table</summary>
                <table>
                  <thead><tr><th>Month</th>{TREND_SERIES.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead>
                  <tbody>{months.map((row) => <tr key={row.month}><td>{monthLabel(row.month, true)}{row.month === current ? " (so far)" : ""}</td>{TREND_SERIES.map((item) => <td key={item.key}>{pounds.format(row[item.key])}</td>)}</tr>)}</tbody>
                </table>
              </details>
              {failed.length > 0 && <p className="hh-meter-flag"><AlertTriangle size={12} /> Not included: {failed.map((item) => item.name).join(", ")} ({failed[0].error})</p>}
            </figure>
          )}
      </div>
    </section>
  );
}

function BankFeedMeter() {
  const feed = useGetFinanceBankFeed(bankFeedQueryOptions);
  const feedData = feed.data;
  const total = feedData ? feedData.matchedAmount + feedData.unmatchedAmount : 0;
  const share = (amount: number) => (total ? `${(amount / total) * 100}%` : "0%");
  const oldestDays = feedData ? daysSince(feedData.oldestUnmatched, feedData.asOf) : 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <div><div className="panel-title">Rent bank feed</div><div className="panel-caption">Bank lines matched to rent in COHO</div></div>
        <Link href="/bank-feed">Bank feed →</Link>
      </div>
      <div className="hh-meter">
        {feed.isLoading ? <p className="hh-fin-note">Loading from COHO…</p>
          : !feedData ? <p className="hh-fin-note">The bank feed could not be loaded from COHO.</p>
            : (
              <>
                <div className="hh-meter-headline">{feedData.matchedCount} of {feedData.matchedCount + feedData.unmatchedCount}<small>lines matched</small></div>
                <div className="hh-meter-bar" role="img" aria-label={`${pounds.format(feedData.matchedAmount)} matched, ${pounds.format(feedData.unmatchedAmount)} unmatched`}>
                  <span style={{ width: share(feedData.matchedAmount), background: SERIES_COLOURS.blue }} title={`Matched ${pounds.format(feedData.matchedAmount)}`} />
                  <span style={{ width: share(feedData.unmatchedAmount), background: SERIES_COLOURS.orange }} title={`Unmatched ${pounds.format(feedData.unmatchedAmount)}`} />
                </div>
                <ul className="hh-meter-legend">
                  <li><i style={{ background: SERIES_COLOURS.blue }} />Matched to rent<b>{pounds.format(feedData.matchedAmount)}</b></li>
                  <li><i style={{ background: SERIES_COLOURS.orange }} />Unmatched<b>{pounds.format(feedData.unmatchedAmount)}</b></li>
                </ul>
                {feedData.unmatchedCount > 0 && oldestDays > 30 && (
                  <p className="hh-meter-flag"><AlertTriangle size={12} /> Unmatched since {formatDate(feedData.oldestUnmatched)} ({oldestDays} days).</p>
                )}
              </>
            )}
      </div>
    </section>
  );
}
