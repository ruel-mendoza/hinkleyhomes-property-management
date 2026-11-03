import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { getListFinanceAlertsQueryKey, useGetReceivables, useListFinanceAlerts, useListIntakeReviews } from "@workspace/api-client-react";
import { AlertsTab, ChecksRunButton, RunStatus } from "./FinanceChecks";
import { BillCodingTab } from "./BillCodingTab";
import { IntakeChecksTab } from "./IntakeChecksTab";
import { IntakeReviewsTab, intakeReviewsQueryOptions } from "./IntakeReviewsTab";
import { LedgerView, receivablesQueryOptions } from "./XeroLedger";
import "./finance.css";

// Supplier bills, in the order a bill arrives: emails to accounts@ the intake
// check looked at (Inbox), the ones it sent for a person (For review), bills
// read and coded to a property in Xero (Bill coding), open bills across the
// five companies (To pay), and bill, bank-detail and spend alerts.

type Tab = "inbox" | "review" | "coding" | "pay" | "alerts";
const TABS: Tab[] = ["inbox", "review", "coding", "pay", "alerts"];
const SUBTITLE: Record<Tab, string> = {
  inbox: "Every email to accounts@ the intake check looked at, with the saved invoice or its link",
  review: "Bills emailed to accounts@ that the intake check sent for a person to look at",
  coding: "Supplier bills read from Xero and coded to a property, or held for an answer",
  pay: "Open bills for all five companies in Xero, with the daily check's priority",
  alerts: "Price, bank-detail and spend changes the daily check found in supplier bills",
};

export default function SupplierBillsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/bills${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const tab: Tab = TABS.find((key) => key === get("tab")) ?? "inbox";
  const reviewOpen = useListIntakeReviews(intakeReviewsQueryOptions()).data?.openCount;
  const bills = useGetReceivables(receivablesQueryOptions).data?.bills.length;
  const alerts = useListFinanceAlerts({ status: "open" }, { query: { queryKey: getListFinanceAlertsQueryKey({ status: "open" }), staleTime: 60_000 } }).data;
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); setTimeout(() => setToast(""), 4000); };
  // Each tab starts with its own filters.
  const openTab = (key: Tab) => navigate(key === "inbox" ? "/bills" : `/bills?tab=${key}`, { replace: true });
  const tabButton = (key: Tab, label: string, count?: React.ReactNode) => (
    <button type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : ""} onClick={() => openTab(key)} data-testid={`tab-bills-${key}`}>{label}{count}</button>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero and accounts@</div>
          <h1 className="page-title">Supplier bills</h1>
          <p className="page-sub">{SUBTITLE[tab]}</p>
        </div>
        <div className="head-actions hh-chk-head"><ChecksRunButton flash={flash} /></div>
      </div>

      <RunStatus />

      <div className="hh-inv-tabs" role="tablist" aria-label="Supplier bills">
        {tabButton("inbox", "Inbox")}
        {tabButton("review", "For review", reviewOpen !== undefined && <span className={reviewOpen ? "hh-chk-count bad" : ""}>{reviewOpen}</span>)}
        {tabButton("coding", "Bill coding")}
        {tabButton("pay", "To pay", bills !== undefined && <span>{bills}</span>)}
        {tabButton("alerts", "Alerts", alerts && <span className={alerts.openHighCount ? "hh-chk-count bad" : ""}>{alerts.openCount}</span>)}
      </div>

      {tab === "inbox" && <IntakeChecksTab get={get} setParams={setParams} flash={flash} />}
      {tab === "review" && <IntakeReviewsTab flash={flash} />}
      {tab === "coding" && <BillCodingTab get={get} setParams={setParams} flash={flash} />}
      {tab === "pay" && <LedgerView ledger="bills" get={get} setParams={setParams} flash={flash} />}
      {tab === "alerts" && <AlertsTab get={get} setParams={setParams} flash={flash} />}

      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}
