import { Link } from "wouter";
import { AlertTriangle, Download } from "lucide-react";
import { getGetFinanceIncomeQueryKey, useGetFinanceIncome } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { MonthlyBars, SERIES_COLOURS } from "@/components/charts/MonthlyBars";
import { downloadText, formatDate } from "@/services/properties";
import "./finance.css";

// Rent & fees: COHO financial items (rent invoiced as client money, management
// fees as Hinkley income) for the last 12 months. Expenses are kept in Xero.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const incomeQueryOptions = { query: { queryKey: getGetFinanceIncomeQueryKey(), staleTime: 15 * 60_000 } };

export default function FinanceIncomePage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const query = useGetFinanceIncome(incomeQueryOptions);
  const data = query.data;
  const properties = (data?.properties ?? []).filter((property) => !selectedPropertyReference || property.propertyReference === selectedPropertyReference);

  const exportCsv = () => {
    if (!data) return;
    const cell = (value: string | number | null) => (value === null ? "" : /[",\r\n]/.test(String(value)) || /^[=+\-@]/.test(String(value)) ? `"${String(value).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : String(value));
    const lines = [
      ["property", "owner", "rent", "managementFees", "unpaid", "lastPaid"].join(","),
      ...properties.map((property) => [property.propertyName, property.ownerName, property.rent, property.fees, property.unpaid, property.lastPaid].map(cell).join(",")),
    ];
    downloadText(`hinkley-rent-and-fees-${data.asOf}.csv`, lines.join("\r\n"));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO finance</div>
          <h1 className="page-title">Rent &amp; fees</h1>
          <p className="page-sub">Rent invoiced and management fees{data ? ` · ${formatDate(data.from)} to ${formatDate(data.asOf)}` : " · last 12 months"}</p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" onClick={exportCsv} disabled={!properties.length} data-testid="button-finance-export"><Download size={14} /> Export (CSV)</button>
        </div>
      </div>

      {query.isLoading && <section className="panel hh-fin-note">Loading from COHO…</section>}
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Rent and fees could not be loaded from COHO: {errorText(query.error)}</p>}

      {data && (
        <>
          <div className="hh-fin-tiles">
            <div className="hh-fin-tile"><span>Rent invoiced</span><strong>{pounds.format(data.rentTotal)}</strong><small>Last 12 months · client money</small></div>
            <div className="hh-fin-tile"><span>Management fees</span><strong>{pounds.format(data.feesTotal)}</strong><small>Hinkley Homes income</small></div>
            <div className="hh-fin-tile"><span>Fee rate</span><strong>{data.feeRatePercent === null ? "—" : `${data.feeRatePercent.toFixed(1)}%`}</strong><small>Fees as a share of rent</small></div>
            <div className={`hh-fin-tile ${data.unpaidTotal > 0 ? "bad" : ""}`}><span>Unpaid rent</span><strong>{pounds.format(data.unpaidTotal)}</strong><small>{data.unpaidCount} {data.unpaidCount === 1 ? "invoice" : "invoices"} · <Link href="/dashboard">see arrears</Link></small></div>
          </div>

          <div className="hh-fin-charts">
            <section className="panel">
              <div className="panel-head"><div><div className="panel-title">Rent invoiced per month</div><div className="panel-caption">All properties{selectedPropertyReference ? " (the property selector doesn't apply to charts)" : ""}</div></div></div>
              <div className="hh-fin-chart"><MonthlyBars title="Rent invoiced per month" data={data.months} series={[{ key: "rent", label: "Rent", colour: SERIES_COLOURS.blue }]} /></div>
            </section>
            <section className="panel">
              <div className="panel-head"><div><div className="panel-title">Management fees per month</div><div className="panel-caption">Charged when rent is paid</div></div></div>
              <div className="hh-fin-chart"><MonthlyBars title="Management fees per month" data={data.months} series={[{ key: "fees", label: "Management fees", colour: SERIES_COLOURS.orange }]} /></div>
            </section>
          </div>

          <section className="panel table-panel hh-fin-section">
            <div className="panel-head"><div><div className="panel-title">By property</div><div className="panel-caption">Rent, fees and unpaid rent over the period</div></div></div>
            <div className="table-wrap">
              <table className="hh-fin-table">
                <thead><tr><th>Property</th><th>Owner</th><th className="num">Rent</th><th className="num">Fees</th><th className="num">Unpaid</th><th>Last paid</th></tr></thead>
                <tbody>
                  {properties.map((property) => (
                    <tr key={property.propertyReference}>
                      <td><Link href={`/properties/${encodeURIComponent(property.propertyReference)}`} className="hh-fin-link">{property.propertyName}</Link></td>
                      <td>{property.ownerName ?? "—"}</td>
                      <td className="num">{pence.format(property.rent)}</td>
                      <td className="num">{pence.format(property.fees)}</td>
                      <td className="num">{property.unpaid ? <span className="status overdue">{pence.format(property.unpaid)}</span> : "—"}</td>
                      <td className="hh-nowrap">{property.lastPaid ? formatDate(property.lastPaid) : "—"}</td>
                    </tr>
                  ))}
                  {!properties.length && <tr><td colSpan={6}><div className="empty-state"><h3>No rent or fees recorded</h3><p>COHO has no financial items for this property in the period.</p></div></td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          {data.owners.length > 0 && !selectedPropertyReference && (
            <section className="panel table-panel hh-fin-section">
              <div className="panel-head"><div><div className="panel-title">By owner</div><div className="panel-caption">Property owners in COHO</div></div></div>
              <div className="table-wrap">
                <table className="hh-fin-table">
                  <thead><tr><th>Owner</th><th className="num">Properties</th><th className="num">Rent</th><th className="num">Fees</th></tr></thead>
                  <tbody>
                    {data.owners.map((owner) => (
                      <tr key={owner.ownerReference}><td>{owner.ownerName}</td><td className="num">{owner.properties}</td><td className="num">{pence.format(owner.rent)}</td><td className="num">{pence.format(owner.fees)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {data.otherTotal === 0 && <p className="hh-fin-foot">COHO holds no expenses or supplier invoices for this account; those are recorded in Xero.</p>}
        </>
      )}
    </>
  );
}
