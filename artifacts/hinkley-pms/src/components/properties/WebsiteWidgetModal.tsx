import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { ModalShell } from "./ModalShell";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function WebsiteWidgetModal({ onClose }: { onClose: () => void }) {
  const widgetUrl = `${window.location.origin}${basePath}/widget`;
  const snippet = `<iframe src="${widgetUrl}" title="Hinkley Homes available properties" width="100%" height="560" style="border:0;max-width:960px" loading="lazy"></iframe>`;
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2200);
  };

  return (
    <ModalShell
      title="Website widget"
      caption="Paste this into any page of the Hinkley Homes website to list properties with a room available. It shows the street, town, postcode area and photo, never the house number."
      onClose={onClose}
      wide
      testId="modal-website-widget"
      footer={<button type="button" className="button" onClick={onClose}>Done</button>}
    >
      <div className="field full">
        <label htmlFor="widget-code">Embed code</label>
        <textarea id="widget-code" readOnly value={snippet} rows={3} className="hh-code" onFocus={(event) => event.currentTarget.select()} />
      </div>
      <div className="hh-act-inline" style={{ marginTop: 8 }}>
        <button type="button" className="button primary" onClick={() => void copy()} data-testid="button-copy-widget">
          {copied === "done" ? <Check size={14} /> : <Copy size={14} />} {copied === "done" ? "Copied" : "Copy"}
        </button>
        {copied === "failed" && <span className="hh-field-error" role="alert">Couldn't copy. Select the code and copy it by hand.</span>}
        <span className="hh-act-hint" style={{ margin: 0 }}>Availability updates from COHO every 5 minutes.</span>
      </div>
      <div className="hh-widget-preview">
        <div className="hh-label">Preview</div>
        <iframe src={`${basePath}/widget`} title="Website widget preview" loading="lazy" />
      </div>
    </ModalShell>
  );
}
