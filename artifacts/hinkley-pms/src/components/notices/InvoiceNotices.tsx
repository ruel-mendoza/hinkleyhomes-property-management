import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, FileWarning, X } from "lucide-react";
import {
  getListIntakeReviewsQueryKey,
  getListLatestIntakeChecksQueryKey,
  listLatestIntakeChecks,
  useListLatestIntakeChecks,
  type IntakeNotice,
} from "@workspace/api-client-react";
import "./notices.css";

// Popup notices for invoices the n8n intake check (or the app's backup check)
// has just checked: passed, sent for review or missing details. The page asks
// every 30 seconds for checks since its last read; opening the app starts from
// now, so old checks are not replayed. Passed notices close on their own; the
// others stay until closed because someone needs to act on them.

const POLL_MS = 30_000;
const PASS_CLOSE_MS = 12_000;
const MAX_SHOWN = 4;
const pounds = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const KINDS: Record<string, { title: string; href: string; link: string; Icon: typeof CircleCheck }> = {
  pass: { title: "New invoice passed", href: "/bills", link: "Open inbox", Icon: CircleCheck },
  review: { title: "New invoice for review", href: "/bills?tab=review", link: "Review", Icon: CircleAlert },
  bounce: { title: "Invoice missing details", href: "/bills", link: "Open inbox", Icon: FileWarning },
};

export function InvoiceNotices() {
  const queryClient = useQueryClient();
  const since = useRef<string | null>(null);
  const shown = useRef(new Set<string>());
  const [notices, setNotices] = useState<IntakeNotice[]>([]);
  const query = useListLatestIntakeChecks(undefined, {
    query: {
      queryKey: getListLatestIntakeChecksQueryKey(),
      queryFn: ({ signal }) => listLatestIntakeChecks(since.current ? { since: since.current } : undefined, { signal }),
      refetchInterval: POLL_MS,
      staleTime: 0,
      retry: false,
    },
  });

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    since.current = data.now;
    const fresh = data.items.filter((item) => KINDS[item.verdict] && !shown.current.has(item.id));
    if (!fresh.length) return;
    for (const item of fresh) shown.current.add(item.id);
    setNotices((current) => [...current, ...fresh].slice(-MAX_SHOWN));
    void queryClient.invalidateQueries({ queryKey: ["/api/invoices/intake-checks"] });
    void queryClient.invalidateQueries({ queryKey: getListIntakeReviewsQueryKey() });
  }, [query.data, queryClient]);

  const close = (id: string) => setNotices((current) => current.filter((item) => item.id !== id));

  if (!notices.length) return null;
  return (
    <div className="hh-notices" role="region" aria-label="Invoice notices">
      {notices.map((notice) => <Notice key={notice.id} notice={notice} onClose={() => close(notice.id)} />)}
    </div>
  );
}

function Notice({ notice, onClose }: { notice: IntakeNotice; onClose: () => void }) {
  const kind = KINDS[notice.verdict] ?? KINDS.review;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (notice.verdict !== "pass") return;
    const timer = setTimeout(() => closeRef.current(), PASS_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [notice.verdict]);
  const who = notice.supplierName || notice.subject || "Unknown supplier";
  const detail = [notice.invoiceNumber ? `No. ${notice.invoiceNumber}` : null, notice.total === null ? null : pounds.format(notice.total)].filter(Boolean).join(" · ");
  return (
    <div className={`hh-notice ${notice.verdict}`} role="status">
      <kind.Icon size={17} className="hh-notice-icon" aria-hidden />
      <div className="hh-notice-body">
        <strong>{kind.title}</strong>
        <span>{who}</span>
        {detail && <small>{detail}</small>}
        <Link href={kind.href} onClick={onClose}>{kind.link} →</Link>
      </div>
      <button type="button" className="hh-notice-close" aria-label="Close notice" onClick={onClose}><X size={13} /></button>
    </div>
  );
}
