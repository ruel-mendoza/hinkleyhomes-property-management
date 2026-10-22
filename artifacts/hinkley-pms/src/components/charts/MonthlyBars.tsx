import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import "./charts.css";

// Monthly bar chart in the app's dark style. Colours are fixed per entity
// (validated against the panel surface #192538: CVD ΔE 26.8, contrast >= 3:1):
//   rent / matched -> blue, fees / unmatched -> orange.
export const SERIES_COLOURS = { blue: "#3987e5", orange: "#d95926" } as const;

export type MonthlySeries = { key: string; label: string; colour: string };

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const compact = (value: number) => (Math.abs(value) >= 1000 ? `£${Math.round(value / 1000)}k` : `£${Math.round(value)}`);
export const monthLabel = (month: string, withYear = false) =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });

function ChartTooltip({ active, payload, label, series }: TooltipProps<number, string> & { series: MonthlySeries[] }) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  return (
    <div className="hh-chart-tip">
      <strong>{monthLabel(String(label), true)}</strong>
      {series.map((item) => {
        const value = payload.find((entry) => entry.dataKey === item.key)?.value;
        return (
          <div key={item.key}><i style={{ background: item.colour }} />{item.label}<span>{pounds.format(Number(value) || 0)}</span></div>
        );
      })}
      {series.length > 1 && <div className="total">Total<span>{pounds.format(total)}</span></div>}
    </div>
  );
}

export function MonthlyBars<T extends { month: string }>({ data, series, height = 220, stacked = false, title }: { data: T[]; series: MonthlySeries[]; height?: number; stacked?: boolean; title: string }) {
  const valueOf = (row: T, key: string) => Number((row as Record<string, unknown>)[key]) || 0;
  return (
    <figure className="hh-chart" aria-label={title}>
      {series.length > 1 && (
        <ul className="hh-chart-legend">
          {series.map((item) => <li key={item.key}><i style={{ background: item.colour }} />{item.label}</li>)}
        </ul>
      )}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke="#2a374d" strokeDasharray="2 4" />
            <XAxis dataKey="month" tickFormatter={(value) => monthLabel(String(value))} tick={{ fill: "#8f9db0", fontSize: 11 }} axisLine={{ stroke: "#33425a" }} tickLine={false} interval="preserveStartEnd" />
            <YAxis tickFormatter={compact} tick={{ fill: "#8f9db0", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
            <Tooltip content={<ChartTooltip series={series} />} cursor={{ fill: "#ffffff0d" }} />
            {series.map((item, index) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                name={item.label}
                fill={item.colour}
                stackId={stacked ? "stack" : undefined}
                // Only the top of a stack gets rounded ends; a 2px surface stroke separates segments.
                radius={!stacked || index === series.length - 1 ? [4, 4, 0, 0] : 0}
                stroke="#192538"
                strokeWidth={stacked ? 2 : 0}
                maxBarSize={28}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="hh-chart-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Month</th>{series.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.month}><td>{monthLabel(row.month, true)}</td>{series.map((item) => <td key={item.key}>{pounds.format(valueOf(row, item.key))}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
