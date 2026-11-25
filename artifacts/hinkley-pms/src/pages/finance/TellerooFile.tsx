import { useState } from "react";
import { Download, X } from "lucide-react";
import { useCreateTellerooFile, type TellerooFile } from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import "./finance.css";

// Supplier bills > To pay: the Telleroo upload file for the ticked bills (see
// api-server lib/telleroo-file.ts). The file holds full bank details, so it is
// handed straight to the browser's download and never kept on the page.

const pence = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
type Pick = { tenantId: string; billId: string };

// Telleroo reads the header row as-is, so no byte-order mark (unlike the app's other CSV exports).
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useTellerooFile(flash: (message: string) => void, onDone: () => void) {
  const mutation = useCreateTellerooFile();
  const [result, setResult] = useState<(TellerooFile & { picks: Pick[] }) | null>(null);
  const make = (picks: Pick[], includeRepeats = false) =>
    mutation.mutate(
      { data: { bills: picks, includeRepeats } },
      {
        onSuccess: (file) => {
          if (file.csv) saveFile(file.fileName, file.csv);
          setResult({ ...file, csv: null, picks });
          if (file.included.length) onDone();
          flash(file.included.length ? `Telleroo file saved: ${file.included.length} ${file.included.length === 1 ? "bill" : "bills"}, ${pence.format(file.total)}.` : "No bills could go in the file. See why below.");
        },
        onError: (error) => flash(`The Telleroo file couldn't be made: ${errorText(error)}`),
      },
    );
  return { make, pending: mutation.isPending, result, clear: () => setResult(null) };
}

export function TellerooFileResult({ result, pending, onRepeat, onClose }: { result: TellerooFile & { picks: Pick[] }; pending: boolean; onRepeat: (picks: Pick[]) => void; onClose: () => void }) {
  const repeats = result.skipped.filter((bill) => bill.repeat);
  return (
    <section className="panel hh-tfile">
      <div className="panel-head">
        <div>
          <div className="panel-title">{result.included.length ? `Telleroo file: ${result.included.length} ${result.included.length === 1 ? "bill" : "bills"}, ${pence.format(result.total)}` : "No Telleroo file made"}</div>
          <div className="panel-caption">{result.included.length ? <>Saved as {result.fileName}. In Telleroo, choose <strong>New pay run</strong> and upload it; it's approved there as usual.</> : "None of the ticked bills could be paid from Telleroo yet."}</div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      {result.skipped.length > 0 && (
        <>
          <p className="hh-tfile-lead">Left out ({result.skipped.length}):</p>
          <ul className="hh-tfile-list">
            {result.skipped.map((bill) => (
              <li key={`${bill.tenantId}|${bill.billId}`}><strong>{bill.supplier}</strong> {bill.number ?? ""}{bill.amount !== null ? ` · ${pence.format(bill.amount)}` : ""} — {bill.reason}</li>
            ))}
          </ul>
          {repeats.length > 0 && (
            <button type="button" className="button" disabled={pending} onClick={() => onRepeat(repeats.map(({ tenantId, billId }) => ({ tenantId, billId })))}>
              <Download size={14} /> Make a file with the {repeats.length} already downloaded
            </button>
          )}
        </>
      )}
    </section>
  );
}
