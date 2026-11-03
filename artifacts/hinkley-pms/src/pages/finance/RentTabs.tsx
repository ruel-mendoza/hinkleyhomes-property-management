import { Link } from "wouter";
import { useGetFinanceBankFeed } from "@workspace/api-client-react";
import { bankFeedQueryOptions } from "./BankFeedPage";

// The two Rent tabs: what COHO invoiced and the fees on it, and the bank lines
// COHO received and whether each is matched to rent. Switching tab starts with
// fresh filters (both use from/to/q).
export function RentTabs({ active }: { active: "income" | "bank" }) {
  const suggested = useGetFinanceBankFeed(bankFeedQueryOptions).data?.lines.filter((line) => line.possibleMatch).length;
  return (
    <div className="hh-inv-tabs hh-rent-tabs" role="tablist" aria-label="Rent">
      <Link href="/rent" role="tab" aria-selected={active === "income"} className={active === "income" ? "active" : ""} data-testid="tab-rent-income">Invoiced &amp; fees</Link>
      <Link href="/rent?tab=bank" role="tab" aria-selected={active === "bank"} className={active === "bank" ? "active" : ""} data-testid="tab-rent-bank">
        Bank feed {suggested ? <span className="hh-chk-count" title={`${suggested} ${suggested === 1 ? "payment looks" : "payments look"} like overdue rent`}>{suggested}</span> : null}
      </Link>
    </div>
  );
}
