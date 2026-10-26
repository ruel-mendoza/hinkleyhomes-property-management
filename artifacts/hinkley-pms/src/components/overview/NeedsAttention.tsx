import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";
import {
  getGetAttentionQueryKey,
  useGetAttention,
  useGetReceivables,
  type AttentionItem,
  type MoneyOverview,
} from "@workspace/api-client-react";
import { receivablesQueryOptions } from "@/pages/finance/InvoicesPage";
import "./money.css";

// Operations overview, top: what someone should act on today, ranked. The
// server reads the app's own tables and COHO compliance (GET /overview/attention);
// money items come from figures this page already loads (COHO money, Xero
// receivables and banking), so nothing is fetched twice.

const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const RANK: Record<AttentionItem["severity"], number> = { high: 0, warn: 1, info: 2 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const daysSince = (date: string | null) => (date ? Math.floor((Date.now() - Date.parse(`${date}T12:00:00Z`)) / 86_400_000) : 0);
const propertyLink = (reference: string) => `/properties/${encodeURIComponent(reference)}`;

function moneyItems(money: MoneyOverview | undefined, propertyReference: string | undefined): AttentionItem[] {
  const items: AttentionItem[] = [];
  const coho = money?.coho && !money.coho.error ? money.coho : undefined;
  if (coho) {
    const inScope = <T extends { propertyReference: string }>(rows: T[]) => rows.filter((row) => !propertyReference || row.propertyReference === propertyReference);
    const arrears = inScope(coho.arrears).sort((a, b) => b.daysInArrears - a.daysInArrears);
    const late = arrears.filter((row) => row.daysInArrears >= 14);
    const recent = arrears.filter((row) => row.daysInArrears < 14);
    if (late.length) {
      const worst = late[0];
      items.push({
        key: "arrears_late", severity: "high", label: "Rent arrears 14+ days", count: late.length, amount: late.reduce((sum, row) => sum + row.outstanding, 0),
        detail: `worst ${plural(worst.daysInArrears, "day")}: ${worst.tenantName ?? "tenant"}, ${worst.propertyName}`, href: propertyLink(worst.propertyReference),
      });
    }
    if (recent.length) {
      items.push({
        key: "arrears_new", severity: "info", label: "New rent arrears", count: recent.length, amount: recent.reduce((sum, row) => sum + row.outstanding, 0),
        detail: "under 14 days", href: propertyLink(recent[0].propertyReference),
      });
    }
    const possible = arrears.filter((row) => row.possiblePayment);
    if (possible.length) {
      items.push({ key: "possible_payments", severity: "info", label: "Payments not yet matched in COHO", count: possible.length, amount: null, detail: "tenants in arrears who may have paid", href: "/bank-feed?status=suggested" });
    }
    const noDeposit = inScope(coho.tenanciesWithoutDeposit);
    if (noDeposit.length) {
      items.push({
        key: "no_deposit", severity: "warn", label: "Tenancies with no deposit record", count: noDeposit.length, amount: null,
        detail: noDeposit.slice(0, 2).map((row) => row.propertyName).join(", ") + (noDeposit.length > 2 ? ` and ${noDeposit.length - 2} more` : ""), href: propertyLink(noDeposit[0].propertyReference),
      });
    }
    if (coho.depositsClosingOverdue && !propertyReference) {
      items.push({ key: "deposits_closing", severity: "warn", label: "Deposits overdue to return", count: coho.depositsClosingOverdue, amount: null, detail: "closing deposits past their deadline", href: "#tenant-money" });
    }
    const reviews = inScope(coho.rentReviews).filter((row) => row.overdue);
    if (reviews.length) {
      items.push({ key: "rent_reviews", severity: "info", label: "Rent reviews overdue", count: reviews.length, amount: null, detail: reviews[0].propertyName, href: propertyLink(reviews[0].propertyReference) });
    }
  }
  const old = (money?.xero.companies ?? []).filter((company) => !company.error && company.unreconciledCount > 0 && daysSince(company.oldestUnreconciled) > 30);
  if (old.length) {
    const worst = [...old].sort((a, b) => daysSince(b.oldestUnreconciled) - daysSince(a.oldestUnreconciled))[0];
    items.push({
      key: "unreconciled", severity: "info", label: "Bank lines unreconciled 30+ days", count: old.reduce((sum, company) => sum + company.unreconciledCount, 0), amount: null,
      detail: `oldest ${daysSince(worst.oldestUnreconciled)} days in ${worst.name.replace(/^Hinkley Homes /, "")}`, href: "#banking",
    });
  }
  return items;
}

function Row({ item }: { item: AttentionItem }) {
  return (
    <>
      <i aria-hidden="true" />
      <span className="hh-attn-label">{item.label}</span>
      <strong>{item.count}{item.amount ? <small> · {pounds.format(item.amount)}</small> : null}</strong>
      <span className="hh-attn-detail">{item.detail}</span>
      <ArrowUpRight size={14} aria-hidden="true" />
    </>
  );
}

export function NeedsAttention({ money, propertyReference }: { money?: MoneyOverview; propertyReference?: string }) {
  const params = propertyReference ? { property: propertyReference } : undefined;
  const attention = useGetAttention(params, { query: { queryKey: getGetAttentionQueryKey(params), staleTime: 60_000, refetchInterval: 5 * 60_000 } });
  const receivables = useGetReceivables(receivablesQueryOptions);

  const items = [...(attention.data?.items ?? []), ...moneyItems(money, propertyReference)];
  const data = receivables.data;
  if (data && !propertyReference) {
    const due = data.invoices.filter((invoice) => invoice.followUp?.nextChaseDate && invoice.followUp.nextChaseDate <= data.asOf);
    if (due.length) items.push({ key: "chase_today", severity: "warn", label: "Invoices to chase today", count: due.length, amount: due.reduce((sum, invoice) => sum + invoice.amountDue, 0), detail: "next chase date reached", href: "/invoices?chase=1" });
  }
  items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.amount ?? 0) - (a.amount ?? 0) || b.count - a.count);

  const loading = attention.isLoading && !items.length;
  const problems = [...(attention.data?.problems ?? []), ...(attention.isError ? ["Alerts, reviews and COHO compliance could not be checked."] : [])];

  return (
    <section className="panel hh-attn" aria-labelledby="attention-title">
      <div className="panel-head">
        <div>
          <div className="panel-title" id="attention-title">Needs attention</div>
          <div className="panel-caption">{loading ? "Checking…" : items.length ? `${plural(items.length, "thing")} to look at${propertyReference ? " · rent and actions for this property, the rest group-wide" : ""}` : "Nothing waiting"}</div>
        </div>
        {items.some((item) => item.severity === "high") && <span className="status overdue">{items.filter((item) => item.severity === "high").length} urgent</span>}
      </div>
      {!loading && !items.length && !problems.length && (
        <p className="hh-attn-clear"><CheckCircle2 size={15} aria-hidden="true" /> All clear: no alerts, reviews, held bills, arrears, overdue actions or compliance problems.</p>
      )}
      {items.length > 0 && (
        <ul className="hh-attn-list">
          {items.map((item) => (
            <li key={item.key} className={item.severity}>
              {item.href.startsWith("#")
                ? <a href={item.href}><Row item={item} /></a>
                : <Link href={item.href}><Row item={item} /></Link>}
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && <p className="hh-attn-problem">{problems.join(" ")}</p>}
    </section>
  );
}
