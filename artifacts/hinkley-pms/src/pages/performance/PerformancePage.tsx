import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BedDouble, Building2, Download, Minus } from "lucide-react";
import { Link } from "wouter";
import {
  getGetPerformanceQueryKey,
  getGetStaysPerformanceQueryKey,
  useGetPerformance,
  useGetStaysPerformance,
  type Performance,
  type PerformancePeriod,
  type StaysPerformance,
  type StaysPerformancePeriod,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { TrendChart } from "@/components/charts/TrendChart";
import { downloadText, formatDate } from "@/services/properties";
import "./performance.css";

// Performance page: HMO lettings from COHO (modelled on COHO's Rent Roll page,
// GET /api/performance) and Stays from the bookings synced from Smoobu
// (GET /api/stays/performance). Each source loads and fails on its own.
// Colour follows the business line everywhere: HMO blue, Stays orange.

type Tone = "good" | "warn" | "bad" | "none";
const HMO = SERIES_COLOURS.blue;
const STAYS = SERIES_COLOURS.orange;
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tone = (value: number | null | undefined, good: (v: number) => boolean, warn: (v: number) => boolean): Tone =>
  value === null || value === undefined ? "none" : good(value) ? "good" : warn(value) ? "warn" : "bad";
const fixed = (value: number | null | undefined, places: number, unit = "") => (value === null || value === undefined ? "—" : `${value.toFixed(places)}${unit}`);
const money = (value: number | null | undefined, exact = false) => (value === null || value === undefined ? "—" : (exact ? pence : pounds).format(value));
const TONE_WORD: Record<Tone, string> = { good: "On track", warn: "Worth watching", bad: "Needs attention", none: "No data" };

// Shorter column names for the period tables.
const periodName = (key: string, label: string) =>
  key === "month_to_date" ? "This month" : key === "last_month" ? label.split(" ")[0] : key === "last_90_days" ? "90 days" : "12 months";

const HMO_TONES = {
  occupancy: (v: number | null | undefined) => tone(v, (x) => x >= 90, (x) => x >= 75),
  onTime: (v: number | null | undefined) => tone(v, (x) => x >= 95, (x) => x >= 85),
  daysLate: (v: number | null | undefined) => tone(v, (x) => x <= 1, (x) => x <= 3),
  voids: (v: number | null | undefined) => tone(v, (x) => x <= 14, (x) => x <= 30),
  satisfaction: (v: number | null | undefined) => tone(v, (x) => x >= 4, (x) => x >= 3),
  rentRoll: (v: number | null | undefined) => tone(v, (x) => x >= 100, (x) => x >= 90),
};
const staysOccupancyTone = (v: number | null | undefined) => tone(v, (x) => x >= 70, (x) => x >= 50);

export const performanceQuery = (propertyReference?: string) => {
  const params = propertyReference ? { propertyReference } : undefined;
  return { params, options: { query: { queryKey: getGetPerformanceQueryKey(params), staleTime: 10 * 60_000 } } };
};
export const staysPerformanceQuery = (propertyReference?: string) => {
  const params = propertyReference ? { propertyReference } : undefined;
  return { params, options: { query: { queryKey: getGetStaysPerformanceQueryKey(params), staleTime: 10 * 60_000, retry: false } } };
};

export default function PerformancePage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const hmoQuery = performanceQuery(selectedPropertyReference);
  const hmo = useGetPerformance(hmoQuery.params, hmoQuery.options);
  const staysQuery = staysPerformanceQuery(selectedPropertyReference);
  const stays = useGetStaysPerformance(staysQuery.params, staysQuery.options);
  const asOf = hmo.data?.asOf ?? stays.data?.asOf;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO and Smoobu</div>
          <h1 className="page-title">Performance</h1>
          <p className="page-sub">HMO rooms and Stays apartments · {selectedPropertyReference ? "selected property" : "all properties"}{asOf ? ` · as of ${formatDate(asOf)}` : ""}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" disabled={!hmo.data && !stays.data} onClick={() => downloadText(`hinkley-performance-${asOf ?? "today"}.csv`, performanceCsv(hmo.data, stays.data))} data-testid="button-performance-export">
            <Download size={14} /> Export (CSV)
          </button>
        </div>
      </div>

      <SectionHead icon={<Building2 size={15} />} colour={HMO} title="HMO lettings" caption="Rooms let through COHO" />
      {hmo.isLoading ? <section className="panel empty-state"><h3>Loading performance from COHO…</h3><p>The first load of the hour takes a few seconds.</p></section>
        : hmo.isError || !hmo.data ? <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> COHO performance could not be loaded: {errorText(hmo.error)}</p>
          : <HmoSection data={hmo.data} />}

      <SectionHead icon={<BedDouble size={15} />} colour={STAYS} title="Stays" caption="Serviced apartments booked through Smoobu" />
      {stays.isLoading ? <section className="panel empty-state"><h3>Working out Stays performance…</h3></section>
        : stays.isError || !stays.data ? <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Stays performance could not be loaded: {errorText(stays.error)}</p>
          : stays.data.apartments === 0 ? <section className="panel empty-state"><h3>{selectedPropertyReference ? "No Stays apartments are linked to this property" : "No Stays apartments yet"}</h3><p>Link Smoobu apartments to properties on the <Link href="/properties">Properties</Link> page.</p></section>
            : <StaysSection data={stays.data} />}

      <OccupancyTrend hmo={hmo.data} stays={stays.data?.apartments ? stays.data : undefined} />

      {(hmo.data || stays.data?.apartments) && (
        <div className="hh-perf-grid">
          {hmo.data && <HmoPeriods data={hmo.data} />}
          {stays.data && stays.data.apartments > 0 && <StaysPeriods data={stays.data} />}
        </div>
      )}
    </>
  );
}

// --- Building blocks ------------------------------------------------------------

function SectionHead({ icon, colour, title, caption }: { icon: ReactNode; colour: string; title: string; caption: string }) {
  return (
    <div className="hh-perf-head">
      <span className="hh-perf-head-icon" style={{ color: colour }}>{icon}</span>
      <h2>{title}</h2>
      <span>{caption}</span>
    </div>
  );
}

function Panel({ title, caption, children, wide }: { title: string; caption: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`panel hh-perf-panel${wide ? " wide" : ""}`}>
      <div className="panel-head"><div><div className="panel-title">{title}</div><div className="panel-caption">{caption}</div></div></div>
      <div className="hh-perf-panel-body">{children}</div>
    </section>
  );
}

// Change against last month, in words and an arrow; higher isn't always better.
function Delta({ now, before, unit, against, higherIsBetter = true, places = 1 }: { now: number | null | undefined; before: number | null | undefined; unit: "pts" | "£" | "days"; against: string; higherIsBetter?: boolean; places?: number }) {
  if (now === null || now === undefined || before === null || before === undefined) return <span className="hh-perf-delta">No {against} figure to compare</span>;
  const change = now - before;
  const size = unit === "£" ? pounds.format(Math.abs(change)) : `${Math.abs(change).toFixed(places)} ${unit}`;
  if (Math.abs(change) < (unit === "£" ? 1 : 0.05)) return <span className="hh-perf-delta"><Minus size={12} /> Same as {against}</span>;
  const better = change > 0 === higherIsBetter;
  const Icon = change > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`hh-perf-delta ${better ? "better" : "worse"}`}><Icon size={12} /> {size} {change > 0 ? "up" : "down"} on {against}</span>;
}

function Kpi({ label, value, foot, delta, toneValue, meter }: { label: string; value: string; foot: ReactNode; delta?: ReactNode; toneValue?: Tone; meter?: { percent: number; colour: string } }) {
  return (
    <div className="panel metric hh-perf-kpi">
      <div className="metric-top">{label}{toneValue && toneValue !== "none" && <span className={`hh-perf-flag ${toneValue}`}>{TONE_WORD[toneValue]}</span>}</div>
      <div className="metric-value">{value}</div>
      {meter && <div className="hh-perf-meter" role="img" aria-label={`${Math.round(meter.percent)}%`}><i style={{ width: `${Math.min(Math.max(meter.percent, 0), 100)}%`, background: meter.colour }} /></div>}
      <div className="metric-foot">{foot}</div>
      {delta}
    </div>
  );
}

function PeriodTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: { label: string; hint: string; cells: { value: string; tone?: Tone; partial?: boolean }[] }[] }) {
  return (
    <div className="table-wrap">
      <table className="hh-perf-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th>Measure</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" title={row.hint}>{row.label}</th>
              {row.cells.map((cell, index) => (
                <td key={index} title={cell.tone && cell.tone !== "none" ? TONE_WORD[cell.tone] : undefined}>
                  {cell.tone && cell.tone !== "none" && cell.value !== "—" && <i className={`hh-perf-dot ${cell.tone}`} aria-label={TONE_WORD[cell.tone]} />}
                  {cell.value}{cell.partial && cell.value !== "—" ? <sup title="Partial history">*</sup> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- HMO (COHO) -----------------------------------------------------------------

function HmoSection({ data }: { data: Performance }) {
  const [thisMonth, lastMonth] = data.periods;
  const last90 = data.periods.find((period) => period.key === "last_90_days");
  const lastName = lastMonth ? periodName(lastMonth.key, lastMonth.label) : "last month";
  const roll = data.rentRollThisMonth;
  return (
    <>
      {data.snapshotError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> {data.snapshotError}</p>}
      <div className="hh-perf-kpis">
        <Kpi label="Rent roll this month" value={money(roll.amount)} toneValue={HMO_TONES.rentRoll(roll.percent)}
          meter={roll.target ? { percent: roll.percent ?? 0, colour: HMO } : undefined}
          foot={roll.target ? `${roll.percent ?? 0}% of the ${money(roll.target)} target` : "No advertised rents to compare"}
          delta={<Delta now={roll.amount} before={data.rentRollLastMonth.amount} unit="£" against={lastName} />} />
        <Kpi label="Rooms let today" value={fixed(data.occupancyTodayPercent, 1, "%")} toneValue={HMO_TONES.occupancy(data.occupancyTodayPercent)}
          meter={{ percent: data.occupancyTodayPercent ?? 0, colour: HMO }}
          foot={`${data.occupiedToday} of ${data.units} ${data.units === 1 ? "room" : "rooms"}`}
          delta={<Delta now={thisMonth?.occupancyPercent} before={lastMonth?.occupancyPercent} unit="pts" against={lastName} />} />
        <Kpi label="Rent paid on time" value={fixed(thisMonth?.paidOnTimePercent, 1, "%")} toneValue={HMO_TONES.onTime(thisMonth?.paidOnTimePercent)}
          foot={`${thisMonth?.rentRecords ?? 0} ${thisMonth?.rentRecords === 1 ? "payment" : "payments"} due so far · ${fixed(thisMonth?.averageDaysLate, 1)} days late on average`}
          delta={<Delta now={thisMonth?.paidOnTimePercent} before={lastMonth?.paidOnTimePercent} unit="pts" against={lastName} />} />
        <Kpi label="Tenant satisfaction" value={last90?.satisfaction === null || last90?.satisfaction === undefined ? "—" : `${last90.satisfaction.toFixed(1)} / 5`} toneValue={HMO_TONES.satisfaction(last90?.satisfaction)}
          foot={`Last 90 days · ${last90?.satisfactionResponses ?? 0} ${last90?.satisfactionResponses === 1 ? "response" : "responses"}`}
          delta={<span className="hh-perf-delta">Tenancies last {fixed(data.averageTenancyMonths, 1)} months on average</span>} />
      </div>
      <div className="hh-perf-grid">
        <Panel title="Rent roll · last 12 months" caption="Rent due each month against the target (each room's advertised rent)">
          <TrendChart title="Rent roll per month" format="money" data={data.months} series={[{ key: "rentRoll", label: "Rent roll", colour: HMO, kind: "bar" }]} target={{ value: roll.target, label: `Target ${money(roll.target)}` }} />
        </Panel>
        <Panel title="Rent paid on time · last 12 months" caption="Share of rent payments due each month that COHO marks as paid on time">
          <TrendChart title="Rent paid on time per month" format="percent" domain={[0, 100]} data={data.months} series={[{ key: "paidOnTimePercent", label: "Paid on time", colour: HMO, kind: "line" }]} />
        </Panel>
      </div>
    </>
  );
}

function HmoPeriods({ data }: { data: Performance }) {
  const periods = data.periods;
  const cells = (pick: (period: PerformancePeriod) => { value: string; tone?: Tone; partial?: boolean }) => periods.map(pick);
  const partial = periods.some((period) => !period.occupancyComplete);
  return (
    <Panel title="HMO by period" caption="From COHO · coloured dots show on track, worth watching or needs attention">
      <PeriodTable caption="HMO measures by period" columns={periods.map((period) => periodName(period.key, period.label))} rows={[
        { label: "Occupancy", hint: "Share of room-days let", cells: cells((period) => ({ value: fixed(period.occupancyPercent, 1, "%"), tone: HMO_TONES.occupancy(period.occupancyPercent), partial: !period.occupancyComplete })) },
        { label: "Paid on time", hint: "Rent payments due in the period that were paid on time", cells: cells((period) => ({ value: fixed(period.paidOnTimePercent, 1, "%"), tone: HMO_TONES.onTime(period.paidOnTimePercent) })) },
        { label: "Days late", hint: "Average days late per rent payment due (0 when on time)", cells: cells((period) => ({ value: fixed(period.averageDaysLate, 1), tone: HMO_TONES.daysLate(period.averageDaysLate) })) },
        { label: "Days to fill voids", hint: "Average days a room stood empty before its next tenancy", cells: cells((period) => ({ value: period.voidsFilled ? fixed(period.daysToFillVoids, 0) : "—", tone: HMO_TONES.voids(period.daysToFillVoids) })) },
        { label: "Satisfaction", hint: "Average score out of 5 from COHO's monthly tenant feedback", cells: cells((period) => ({ value: fixed(period.satisfaction, 1), tone: HMO_TONES.satisfaction(period.satisfaction) })) },
        { label: "Rent payments", hint: "Rent payments due in the period, up to today", cells: cells((period) => ({ value: String(period.rentRecords) })) },
      ]} />
      {partial && <p className="hh-perf-note">* {data.snapshotsSince ? `Room history is recorded daily from ${formatDate(data.snapshotsSince)}.` : "Room history starts recording today."} Before that, only tenancies still running are counted, because COHO doesn't return ended ones.</p>}
    </Panel>
  );
}

// --- Stays (Smoobu) -------------------------------------------------------------

function StaysSection({ data }: { data: StaysPerformance }) {
  const [thisMonth, lastMonth] = data.periods;
  const lastName = lastMonth ? periodName(lastMonth.key, lastMonth.label) : "last month";
  const totalNights = data.channels.reduce((sum, channel) => sum + channel.bookedNights, 0);
  return (
    <>
      <div className="hh-perf-kpis">
        <Kpi label="Nights booked this month" value={fixed(thisMonth?.occupancyPercent, 1, "%")} toneValue={staysOccupancyTone(thisMonth?.occupancyPercent)}
          meter={{ percent: thisMonth?.occupancyPercent ?? 0, colour: STAYS }}
          foot={`${thisMonth?.bookedNights ?? 0} of ${thisMonth?.availableNights ?? 0} nights so far · ${data.apartments} ${data.apartments === 1 ? "apartment" : "apartments"}`}
          delta={<Delta now={thisMonth?.occupancyPercent} before={lastMonth?.occupancyPercent} unit="pts" against={lastName} />} />
        <Kpi label="Average nightly rate" value={money(thisMonth?.averageDailyRate, true)}
          foot={`Room revenue this month ${money(thisMonth?.roomRevenue)}`}
          delta={<Delta now={thisMonth?.averageDailyRate} before={lastMonth?.averageDailyRate} unit="£" against={lastName} />} />
        <Kpi label="Revenue per available night" value={money(thisMonth?.revPar, true)}
          foot="Room revenue ÷ every night on offer"
          delta={<Delta now={thisMonth?.revPar} before={lastMonth?.revPar} unit="£" against={lastName} />} />
        <Kpi label="Next 30 nights on the books" value={fixed(data.ahead.occupancyPercent, 1, "%")}
          meter={{ percent: data.ahead.occupancyPercent ?? 0, colour: STAYS }}
          foot={`${data.ahead.bookedNights} nights booked · ${money(data.ahead.roomRevenue)} room revenue`}
          delta={<span className="hh-perf-delta">To {formatDate(data.ahead.to)}</span>} />
      </div>
      <div className="hh-perf-grid">
        <Panel title="Room revenue · last 12 months" caption="Booking price less cleaning fees, counted on the nights stayed (before channel commission)">
          <TrendChart title="Stays room revenue per month" format="money" data={data.months} partialKey="complete" partialNote="before bookings history" series={[{ key: "roomRevenue", label: "Room revenue", colour: STAYS, kind: "bar" }]} />
        </Panel>
        <Panel title="Where bookings come from · last 90 days" caption="Nights booked by channel, from Smoobu">
          {data.channels.length === 0 ? <div className="empty-state"><h3>No nights booked in the last 90 days</h3></div> : (
            <ul className="hh-perf-channels">
              {data.channels.map((channel) => {
                const share = totalNights ? (channel.bookedNights / totalNights) * 100 : 0;
                return (
                  <li key={channel.channel} title={`${channel.bookedNights} nights · ${money(channel.roomRevenue)} room revenue`}>
                    <span className="name">{channel.channel}</span>
                    <span className="bar"><i style={{ width: `${share}%`, background: STAYS }} /></span>
                    <span className="value">{Math.round(share)}%</span>
                    <span className="detail">{channel.bookedNights} nights · {money(channel.roomRevenue)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function StaysPeriods({ data }: { data: StaysPerformance }) {
  const periods = data.periods;
  const cells = (pick: (period: StaysPerformancePeriod) => { value: string; tone?: Tone; partial?: boolean }) => periods.map(pick);
  return (
    <Panel title="Stays by period" caption="From bookings synced from Smoobu · blocked nights count as free">
      <PeriodTable caption="Stays measures by period" columns={periods.map((period) => periodName(period.key, period.label))} rows={[
        { label: "Occupancy", hint: "Nights booked ÷ nights on offer", cells: cells((period) => ({ value: fixed(period.occupancyPercent, 1, "%"), tone: staysOccupancyTone(period.occupancyPercent), partial: !period.complete })) },
        { label: "Nightly rate", hint: "Room revenue per night booked", cells: cells((period) => ({ value: money(period.averageDailyRate, true), partial: !period.complete })) },
        { label: "RevPAR", hint: "Room revenue per night on offer", cells: cells((period) => ({ value: money(period.revPar, true), partial: !period.complete })) },
        { label: "Room revenue", hint: "Booking price less cleaning fees, on the nights stayed", cells: cells((period) => ({ value: money(period.roomRevenue), partial: !period.complete })) },
        { label: "Arrivals", hint: "Bookings arriving in the period", cells: cells((period) => ({ value: String(period.arrivals), partial: !period.complete })) },
        { label: "Average stay", hint: "Nights per booking, for arrivals in the period", cells: cells((period) => ({ value: fixed(period.averageStayNights, 1, " nights") })) },
      ]} />
      {periods.some((period) => !period.complete) && <p className="hh-perf-note">* {data.historyFrom ? `The app holds every booking from ${formatDate(data.historyFrom)}.` : "Bookings haven't been synced from Smoobu yet."} Earlier figures may be missing stays.</p>}
    </Panel>
  );
}

// --- Both -------------------------------------------------------------------------

function OccupancyTrend({ hmo, stays }: { hmo?: Performance; stays?: StaysPerformance }) {
  if (!hmo && !stays) return null;
  const months = (hmo?.months ?? stays?.months ?? []).map((row) => row.month);
  const rows = months.map((month) => {
    const room = hmo?.months.find((row) => row.month === month);
    const stay = stays?.months.find((row) => row.month === month);
    return { month, hmo: room?.occupancyPercent ?? null, stays: stay?.occupancyPercent ?? null, complete: (room?.occupancyComplete ?? true) && (stay?.complete ?? true) };
  });
  const series = [
    ...(hmo ? [{ key: "hmo", label: "HMO rooms let", colour: HMO, kind: "line" as const }] : []),
    ...(stays ? [{ key: "stays", label: "Stays nights booked", colour: STAYS, kind: "line" as const, dashed: true }] : []),
  ];
  return (
    <Panel wide title="Occupancy · last 12 months" caption={hmo && stays ? "HMO rooms let (share of room-days) beside Stays nights booked (share of apartment-nights)" : hmo ? "Share of room-days let, from COHO" : "Share of apartment-nights booked, from Smoobu"}>
      <TrendChart title="Occupancy per month" format="percent" domain={[0, 100]} height={230} data={rows} series={series} partialKey="complete" />
    </Panel>
  );
}

function performanceCsv(hmo: Performance | undefined, stays: StaysPerformance | undefined): string {
  const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const rows: (string | number | null)[][] = [["source", "metric", "period", "from", "to", "value", "detail"]];
  if (hmo) {
    rows.push(
      ["COHO", "Rent roll", hmo.rentRollThisMonth.month, null, null, hmo.rentRollThisMonth.amount, `target ${hmo.rentRollThisMonth.target}`],
      ["COHO", "Rent roll", hmo.rentRollLastMonth.month, null, null, hmo.rentRollLastMonth.amount, `target ${hmo.rentRollLastMonth.target}`],
      ["COHO", "Occupancy %", "Today", hmo.asOf, hmo.asOf, hmo.occupancyTodayPercent, `${hmo.occupiedToday} of ${hmo.units} rooms`],
      ...hmo.periods.flatMap((period): (string | number | null)[][] => [
        ["COHO", "Occupancy %", period.label, period.from, period.to, period.occupancyPercent, period.occupancyComplete ? "" : "incomplete history"],
        ["COHO", "Rent paid on time %", period.label, period.from, period.to, period.paidOnTimePercent, `${period.rentRecords} payments`],
        ["COHO", "Rent days late", period.label, period.from, period.to, period.averageDaysLate, ""],
        ["COHO", "Days to fill voids", period.label, period.from, period.to, period.daysToFillVoids, `${period.voidsFilled} filled`],
        ["COHO", "Tenant satisfaction", period.label, period.from, period.to, period.satisfaction, `${period.satisfactionResponses} responses`],
      ]),
      ["COHO", "Average tenancy duration (months)", "Known tenancies", null, hmo.asOf, hmo.averageTenancyMonths, `${hmo.tenanciesCounted} tenancies`],
      ...hmo.months.flatMap((month): (string | number | null)[][] => [
        ["COHO", "Rent roll", month.month, null, null, month.rentRoll, ""],
        ["COHO", "Occupancy %", month.month, null, null, month.occupancyPercent, month.occupancyComplete ? "" : "incomplete history"],
        ["COHO", "Rent paid on time %", month.month, null, null, month.paidOnTimePercent, ""],
      ]),
    );
  }
  if (stays && stays.apartments) {
    const figures = (label: string, from: string | null, to: string | null, row: StaysPerformance["ahead"] | StaysPerformancePeriod | StaysPerformance["months"][number]): (string | number | null)[][] => [
      ["Smoobu", "Stays occupancy %", label, from, to, row.occupancyPercent, `${row.bookedNights} of ${row.availableNights} nights${row.complete ? "" : ", incomplete history"}`],
      ["Smoobu", "Stays room revenue", label, from, to, row.roomRevenue, ""],
      ["Smoobu", "Stays average nightly rate", label, from, to, row.averageDailyRate, ""],
      ["Smoobu", "Stays RevPAR", label, from, to, row.revPar, ""],
    ];
    rows.push(
      ...stays.periods.flatMap((period) => figures(period.label, period.from, period.to, period)),
      ...figures("Next 30 nights", stays.ahead.from, stays.ahead.to, stays.ahead),
      ...stays.months.flatMap((month) => figures(month.month, null, null, month)),
      ...stays.channels.map((channel): (string | number | null)[] => ["Smoobu", "Stays nights by channel (90 days)", channel.channel, null, null, channel.bookedNights, `room revenue ${channel.roomRevenue}`]),
    );
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

// Headline figures for the Operations overview, linking to the full page.
export function PerformanceStrip({ propertyReference }: { propertyReference?: string }) {
  const hmoQuery = performanceQuery(propertyReference);
  const hmo = useGetPerformance(hmoQuery.params, hmoQuery.options);
  const staysQuery = staysPerformanceQuery(propertyReference);
  const stays = useGetStaysPerformance(staysQuery.params, staysQuery.options);
  const data = hmo.data;
  const monthToDate = data?.periods.find((period) => period.key === "month_to_date");
  const staysMonth = stays.data?.apartments ? stays.data.periods.find((period) => period.key === "month_to_date") : undefined;
  const stat = (label: string, value: string, toneClass: Tone) => (
    <div><span>{label}</span><strong className={toneClass}>{value}</strong></div>
  );
  return (
    <section className="panel hh-perf-strip" aria-label="Performance">
      <div><div className="panel-title">Performance</div><div className="panel-caption">This month · HMO from COHO, Stays from Smoobu</div></div>
      <div className="hh-perf-strip-stats">
        {hmo.isLoading ? <div><span>Loading…</span></div>
          : !data ? <div><span>COHO performance could not be loaded</span></div>
            : (
              <>
                {stat("Rent roll", `${pounds.format(data.rentRollThisMonth.amount)}${data.rentRollThisMonth.percent === null ? "" : ` (${data.rentRollThisMonth.percent}%)`}`, HMO_TONES.rentRoll(data.rentRollThisMonth.percent))}
                {stat("Paid on time", fixed(monthToDate?.paidOnTimePercent, 1, "%"), HMO_TONES.onTime(monthToDate?.paidOnTimePercent))}
                {stat("Avg days late", fixed(monthToDate?.averageDaysLate, 1), HMO_TONES.daysLate(monthToDate?.averageDaysLate))}
              </>
            )}
        {staysMonth && (
          <>
            {stat("Stays nights booked", fixed(staysMonth.occupancyPercent, 1, "%"), staysOccupancyTone(staysMonth.occupancyPercent))}
            {stat("Stays nightly rate", money(staysMonth.averageDailyRate), "none")}
          </>
        )}
      </div>
      <Link href="/performance" className="button">Open performance</Link>
    </section>
  );
}
