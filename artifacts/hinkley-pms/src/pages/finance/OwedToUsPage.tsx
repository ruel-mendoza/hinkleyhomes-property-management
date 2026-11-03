import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useGetReceivables } from "@workspace/api-client-react";
import { ChecksRunButton, RemindersTab, RunStatus } from "./FinanceChecks";
import { LedgerView, receivablesQueryOptions } from "./XeroLedger";
import "./finance.css";

// Owed to us: open sales invoices across the five Xero companies, with each
// overdue one's priority from the daily check, our follow-ups and reminders,
// and the log of reminders sent.

type Tab = "invoices" | "reminders";

export default function OwedToUsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/receivables${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const tab: Tab = get("tab") === "reminders" ? "reminders" : "invoices";
  const data = useGetReceivables(receivablesQueryOptions).data;
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); setTimeout(() => setToast(""), 4000); };
  // Each tab starts with its own filters.
  const openTab = (key: Tab) => navigate(key === "invoices" ? "/receivables" : `/receivables?tab=${key}`, { replace: true });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Xero</div>
          <h1 className="page-title">Owed to us</h1>
          <p className="page-sub">Open sales invoices for all five companies, with follow-ups, reminders and the daily check's priority</p>
        </div>
        <div className="head-actions hh-chk-head"><ChecksRunButton flash={flash} /></div>
      </div>

      <RunStatus />

      <div className="hh-inv-tabs" role="tablist" aria-label="Owed to us">
        <button type="button" role="tab" aria-selected={tab === "invoices"} className={tab === "invoices" ? "active" : ""} onClick={() => openTab("invoices")}>
          Invoices {data && <span>{data.invoices.length}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === "reminders"} className={tab === "reminders" ? "active" : ""} onClick={() => openTab("reminders")}>Reminders sent</button>
      </div>

      {tab === "invoices" ? <LedgerView ledger="receivables" get={get} setParams={setParams} flash={flash} /> : <RemindersTab />}

      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}
