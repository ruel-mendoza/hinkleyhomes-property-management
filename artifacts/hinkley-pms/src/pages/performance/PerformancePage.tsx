import { AlertTriangle, Download, Info } from "lucide-react";
import { Link } from "wouter";
import { getGetPerformanceQueryKey, useGetPerformance, type Performance, type PerformancePeriod } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { downloadText, formatDate } from "@/services/properties";
import "./performance.css";

// Performance page, modelled on COHO's Rent Roll page. Figures come from
// GET /api/performance; occupancy history builds up from daily unit snapshots.

type Tone = "good" | "warn" | "bad" | "none";
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const tone = (value: number | null, good: (v: number) => boolean, warn: (v: number) => boolean): Tone =>
  value === null ? "none" : good(value) ? "good" : warn(value) ? "warn" : "bad";
const fixed = (value: number | null, places: number) => (value === null ? "—" : value.toFixed(places));

export const performanceQuery = (propertyReference?: string) => {
  const params = propertyReference ? { propertyReference } : undefined;
  return { params, options: { query: { queryKey: getGetPerformanceQueryKey(params), staleTime: 10 * 60_000 } } };
};

export default function PerformancePage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const { params, options } = performanceQuery(selectedPropertyReference);
  const query = useGetPerformance(params, options);
  const data = query.data;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO</div>
          <h1 className="page-title">Performance</h1>
          <p className="page-sub">
            Rent roll, payments, occupancy and satisfaction{data ? ` · ${data.propertyReference ? "selected property" : "all properties"} · as of ${formatDate(data.asOf)}` : ""}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" disabled={!data} onClick={() => data && downloadText(`hinkley-performance-${data.asOf}.csv`, performanceCsv(data))} data-testid="button-performance-export">
            <Download size={14} /> Export (CSV)
          </button>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-perf-loading">Loading performance from COHO… the first load of the hour takes a few seconds.</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Performance could not be loaded: {errorText(query.error)}</p>}
      {data && <PerformanceBody data={data} />}
    </>
  );
}

function PerformanceBody({ data }: { data: Performance }) {
  const periods = data.periods;
  const historyNote = data.snapshotsSince
    ? `Occupancy history is recorded daily from ${formatDate(data.snapshotsSince)}. Periods starting earlier only count tenancies that are still running, because COHO's API doesn't return ended tenancies.`
    : "Occupancy history starts recording today. Until then, earlier periods only count tenancies that are still running, because COHO's API doesn't return ended tenancies.";
  return (
    <>
      {data.snapshotError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {data.snapshotError}</p>}

      <Section title="Rent roll" info="Rent due in the month across the units in view. Target is the sum of each unit's advertised rent in COHO.">
        {[data.rentRollThisMonth, data.rentRollLastMonth].map((month, index) => (
          <Tile
            key={month.month}
            value={pounds.format(month.amount)}
            sub={`Target ${pounds.format(month.target)}${month.percent === null ? "" : ` (${month.percent}%)`}`}
            label={index === 0 ? periods[0]?.label.replace(" (to date)", "") ?? month.month : periods[1]?.label ?? month.month}
            tone={tone(month.percent, (v) => v >= 100, (v) => v >= 90)}
            wide
          />
        ))}
      </Section>

      <Section title="Occupancy" info={`Share of unit-days let. Today: ${data.occupiedToday} of ${data.units} units let.`} note={periods.some((period) => !period.occupancyComplete) ? historyNote : undefined}>
        <Tile value={fixed(data.occupancyTodayPercent, 1)} unit="%" label="Today" tone={tone(data.occupancyTodayPercent, (v) => v >= 90, (v) => v >= 75)} />
        {periods.map((period) => (
          <Tile key={period.key} value={fixed(period.occupancyPercent, 2)} unit="%" label={period.label} tone={tone(period.occupancyPercent, (v) => v >= 90, (v) => v >= 75)} partial={!period.occupancyComplete} />
        ))}
      </Section>

      <Section title="Rent paid on time" info="Share of rent payments due in the period (up to today) that COHO marks as paid on time.">
        {periods.map((period) => (
          <Tile key={period.key} value={fixed(period.paidOnTimePercent, 2)} unit="%" label={period.label} sub={`${period.rentRecords} ${period.rentRecords === 1 ? "payment" : "payments"}`} tone={tone(period.paidOnTimePercent, (v) => v >= 95, (v) => v >= 85)} />
        ))}
      </Section>

      <Section title="Rent days late" info="Average days late per rent payment due in the period: days late for late payments, days overdue so far for unpaid rent, 0 when paid on time.">
        {periods.map((period) => (
          <Tile key={period.key} value={fixed(period.averageDaysLate, 1)} unit="days" label={period.label} tone={tone(period.averageDaysLate, (v) => v <= 1, (v) => v <= 3)} />
        ))}
      </Section>

      <Section title="Days to fill voids" info="Average days a unit stood empty before its next tenancy started, for voids filled in the period. Worked out from the daily snapshots, so it fills in over time.">
        {periods.map((period) => (
          <Tile key={period.key} value={fixed(period.daysToFillVoids, 0)} unit="days" label={period.label} sub={period.voidsFilled ? `${period.voidsFilled} filled` : "No data yet"} tone={tone(period.daysToFillVoids, (v) => v <= 14, (v) => v <= 30)} />
        ))}
      </Section>

      <Section title="Average tenancy duration" info="Average length so far of the tenancies the app knows about: running tenancies up to today, plus ended ones seen in the daily snapshots.">
        <Tile value={fixed(data.averageTenancyMonths, 1)} unit="months" label={`${data.tenanciesCounted} ${data.tenanciesCounted === 1 ? "tenancy" : "tenancies"}`} tone="none" partial={!data.snapshotsSince} />
      </Section>

      <Section title="Tenant satisfaction" info="Average overall score from COHO's monthly tenant feedback (whole months overlapping the period).">
        {periods.map((period) => (
          <Tile key={period.key} value={fixed(period.satisfaction, 1)} label={period.label} sub={`${period.satisfactionResponses} ${period.satisfactionResponses === 1 ? "response" : "responses"}`} tone={tone(period.satisfaction, (v) => v >= 4, (v) => v >= 3)} />
        ))}
      </Section>
    </>
  );
}

function Section({ title, info, note, children }: { title: string; info: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="hh-perf-section">
      <h2>{title} <span className="hh-perf-info" title={info} aria-label={info} role="img"><Info size={13} /></span></h2>
      <div className="hh-perf-tiles">{children}</div>
      {note && <p className="hh-perf-note">{note}</p>}
    </section>
  );
}

function Tile({ value, unit, label, sub, tone, wide, partial }: { value: string; unit?: string; label: string; sub?: string; tone: Tone; wide?: boolean; partial?: boolean }) {
  return (
    <div className={`hh-perf-tile ${value === "—" ? "none" : tone} ${wide ? "wide" : ""} ${partial ? "partial" : ""}`} title={partial ? "Incomplete: ended tenancies before snapshots began are not counted" : undefined}>
      <strong>{value}{unit && value !== "—" && <small>{unit === "%" ? "%" : ` ${unit}`}</small>}</strong>
      {sub && <span className="hh-perf-sub">{sub}</span>}
      <span className="hh-perf-label">{label}{partial ? " *" : ""}</span>
    </div>
  );
}

function performanceCsv(data: Performance): string {
  const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const rows: (string | number | null)[][] = [
    ["metric", "period", "from", "to", "value", "detail"],
    ["Rent roll", data.rentRollThisMonth.month, null, null, data.rentRollThisMonth.amount, `target ${data.rentRollThisMonth.target}`],
    ["Rent roll", data.rentRollLastMonth.month, null, null, data.rentRollLastMonth.amount, `target ${data.rentRollLastMonth.target}`],
    ["Occupancy %", "Today", data.asOf, data.asOf, data.occupancyTodayPercent, `${data.occupiedToday} of ${data.units} units`],
    ...data.periods.flatMap((period: PerformancePeriod) => [
      ["Occupancy %", period.label, period.from, period.to, period.occupancyPercent, period.occupancyComplete ? "" : "incomplete history"],
      ["Rent paid on time %", period.label, period.from, period.to, period.paidOnTimePercent, `${period.rentRecords} payments`],
      ["Rent days late", period.label, period.from, period.to, period.averageDaysLate, ""],
      ["Days to fill voids", period.label, period.from, period.to, period.daysToFillVoids, `${period.voidsFilled} filled`],
      ["Tenant satisfaction", period.label, period.from, period.to, period.satisfaction, `${period.satisfactionResponses} responses`],
    ]),
    ["Average tenancy duration (months)", "Known tenancies", null, data.asOf, data.averageTenancyMonths, `${data.tenanciesCounted} tenancies`],
  ];
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

// Headline figures for the Operations overview, linking to the full page.
export function PerformanceStrip({ propertyReference }: { propertyReference?: string }) {
  const { params, options } = performanceQuery(propertyReference);
  const query = useGetPerformance(params, options);
  const data = query.data;
  const monthToDate = data?.periods.find((period) => period.key === "month_to_date");
  const stat = (label: string, value: string, toneClass: Tone) => (
    <div><span>{label}</span><strong className={toneClass}>{value}</strong></div>
  );
  return (
    <section className="panel hh-perf-strip" aria-label="Performance">
      <div><div className="panel-title">Performance</div><div className="panel-caption">This month, from COHO</div></div>
      <div className="hh-perf-strip-stats">
        {query.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>Performance could not be loaded</span></div>
            : (
              <>
                {stat("Rent roll", `${pounds.format(data.rentRollThisMonth.amount)}${data.rentRollThisMonth.percent === null ? "" : ` (${data.rentRollThisMonth.percent}%)`}`, tone(data.rentRollThisMonth.percent, (v) => v >= 100, (v) => v >= 90))}
                {stat("Paid on time", monthToDate?.paidOnTimePercent === null || !monthToDate ? "—" : `${monthToDate.paidOnTimePercent.toFixed(1)}%`, tone(monthToDate?.paidOnTimePercent ?? null, (v) => v >= 95, (v) => v >= 85))}
                {stat("Avg days late", fixed(monthToDate?.averageDaysLate ?? null, 1), tone(monthToDate?.averageDaysLate ?? null, (v) => v <= 1, (v) => v <= 3))}
              </>
            )}
      </div>
      <Link href="/performance" className="button">Open performance</Link>
    </section>
  );
}
