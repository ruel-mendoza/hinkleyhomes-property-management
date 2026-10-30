import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { monthLabel } from "./MonthlyBars";
import "./charts.css";

// Twelve-month trend on one axis: bars or lines (never two scales). Months
// flagged partial (history the app doesn't fully hold) and this month "so far"
// are named in the tooltip and table, never shown by colour alone.

export type TrendFormat = "money" | "percent" | "number";
export type TrendSeries = { key: string; label: string; colour: string; kind: "bar" | "line"; dashed?: boolean };
type Row = { month: string } & Record<string, unknown>;

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const compactMoney = (value: number) => (Math.abs(value) >= 1000 ? `£${(value / 1000).toFixed(Math.abs(value) >= 10_000 ? 0 : 1)}k` : `£${Math.round(value)}`);
export const formatValue = (value: unknown, format: TrendFormat) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return format === "money" ? pounds.format(value) : format === "percent" ? `${value.toFixed(1)}%` : value.toFixed(1);
};
const axisValue = (value: number, format: TrendFormat) => (format === "money" ? compactMoney(value) : format === "percent" ? `${Math.round(value)}%` : String(Math.round(value * 10) / 10));

function monthNote(row: Row | undefined, current: string | undefined, partialKey: string | undefined, partialNote: string) {
  if (!row) return "";
  if (partialKey && row[partialKey] === false) return ` (${partialNote})`;
  return row.month === current ? " (so far)" : "";
}

function TrendTooltip({ active, payload, label, series, format, rows, current, partialKey, partialNote }: TooltipProps<number, string> & { series: TrendSeries[]; format: TrendFormat; rows: Row[]; current?: string; partialKey?: string; partialNote: string }) {
  if (!active || !payload?.length) return null;
  const row = rows.find((item) => item.month === label);
  return (
    <div className="hh-chart-tip">
      <strong>{monthLabel(String(label), true)}{monthNote(row, current, partialKey, partialNote)}</strong>
      {series.map((item) => (
        <div key={item.key}><i style={{ background: item.colour }} />{item.label}<span>{formatValue(row?.[item.key], format)}</span></div>
      ))}
    </div>
  );
}

export function TrendChart<T extends { month: string }>({ data, series, format, title, height = 210, target, domain, partialKey, partialNote = "partial history" }: {
  data: T[];
  series: TrendSeries[];
  format: TrendFormat;
  title: string;
  height?: number;
  target?: { value: number; label: string };
  domain?: [number, number];
  partialKey?: keyof T & string;
  partialNote?: string;
}) {
  const rows = data as unknown as Row[];
  const current = rows.at(-1)?.month;
  return (
    <figure className="hh-chart" aria-label={title}>
      {series.length > 1 && (
        <ul className="hh-chart-legend">
          {series.map((item) => <li key={item.key}><i className={item.dashed ? "dashed" : ""} style={{ background: item.colour }} />{item.label}</li>)}
        </ul>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="#2a374d" strokeDasharray="2 4" />
            <XAxis dataKey="month" tickFormatter={(value) => monthLabel(String(value))} tick={{ fill: "#8f9db0", fontSize: 12 }} axisLine={{ stroke: "#33425a" }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tickFormatter={(value) => axisValue(Number(value), format)} tick={{ fill: "#8f9db0", fontSize: 12 }} axisLine={false} tickLine={false} width={48} domain={domain ?? [0, "auto"]} allowDataOverflow={false} />
            {target && target.value > 0 && (
              <ReferenceLine y={target.value} stroke="#8f9db0" strokeDasharray="5 4" ifOverflow="extendDomain" label={{ value: target.label, position: "insideTopRight", fill: "#c6d1de", fontSize: 12 }} />
            )}
            <Tooltip content={<TrendTooltip series={series} format={format} rows={rows} current={current} partialKey={partialKey} partialNote={partialNote} />} cursor={series.some((item) => item.kind === "bar") ? { fill: "#ffffff0d" } : { stroke: "#5b6b82", strokeDasharray: "3 3" }} />
            {series.map((item) =>
              item.kind === "bar" ? (
                <Bar key={item.key} dataKey={item.key} name={item.label} fill={item.colour} radius={[4, 4, 0, 0]} maxBarSize={26} isAnimationActive={false} />
              ) : (
                <Line key={item.key} type="monotone" dataKey={item.key} name={item.label} stroke={item.colour} strokeWidth={2} strokeDasharray={item.dashed ? "6 4" : undefined} connectNulls
                  dot={{ r: 4, fill: item.colour, stroke: "#192538", strokeWidth: 2 }} activeDot={{ r: 5, stroke: "#192538", strokeWidth: 2 }} isAnimationActive={false} />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="hh-chart-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Month</th>{series.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.month}><td>{monthLabel(row.month, true)}{monthNote(row, current, partialKey, partialNote)}</td>{series.map((item) => <td key={item.key}>{formatValue(row[item.key], format)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
