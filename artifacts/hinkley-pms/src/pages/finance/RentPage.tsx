import { useSearch } from "wouter";
import BankFeedPage from "./BankFeedPage";
import FinanceIncomePage from "./FinanceIncomePage";

// Rent (COHO): "Invoiced & fees" (rent invoiced and management fees) and
// "Bank feed" (bank lines and rent matching), as ?tab=bank.
export default function RentPage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const tab = new URLSearchParams(useSearch()).get("tab");
  return tab === "bank" ? <BankFeedPage /> : <FinanceIncomePage selectedPropertyReference={selectedPropertyReference} />;
}
