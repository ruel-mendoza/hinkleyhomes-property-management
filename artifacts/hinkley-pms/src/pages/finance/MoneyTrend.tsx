import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { useGetFinanceBankFeed, useGetFinanceIncome } from "@workspace/api-client-react";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { formatDate } from "@/services/properties";
import { bankFeedQueryOptions, daysSince } from "./BankFeedPage";
import { incomeQueryOptions } from "./FinanceIncomePage";
import "./finance.css";

// Operations overview: rent trend and how much of the rent bank feed is matched.
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

export function MoneyTrend() {
  const income = useGetFinanceIncome(incomeQueryOptions);
  const feed = useGetFinanceBankFeed(bankFeedQueryOptions);
  const feedData = feed.data;
  const total = feedData ? feedData.matchedAmount + feedData.unmatchedAmount : 0;
  const share = (amount: number) => (total ? `${(amount / total) * 100}%` : "0%");
  const oldestDays = feedData ? daysSince(feedData.oldestUnmatched, feedData.asOf) : 0;

  return (
    <div className="hh-trend">
      <section className="panel">
        <div className="panel-head">
          <div><div className="panel-title">Rent invoiced · last 12 months</div><div className="panel-caption">{income.data ? `${pounds.format(income.data.rentTotal)} rent · ${pounds.format(income.data.feesTotal)} management fees` : "From COHO"}</div></div>
          <Link href="/finance">Rent &amp; fees →</Link>
        </div>
        <div className="hh-fin-chart">
          {income.isLoading ? <p className="hh-fin-note">Loading from COHO…</p>
            : income.data ? <MonthlyBars title="Rent invoiced per month" height={170} data={income.data.months} series={[{ key: "rent", label: "Rent", colour: SERIES_COLOURS.blue }]} />
              : <p className="hh-fin-note">Rent could not be loaded from COHO.</p>}
        </div>
      </section>
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
    </div>
  );
}
