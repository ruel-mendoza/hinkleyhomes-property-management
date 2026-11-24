import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Landmark, RefreshCwOff, X } from "lucide-react";
import {
  getListLatestNoticesQueryKey,
  listLatestNotices,
  useListLatestNotices,
  type Notice,
} from "@workspace/api-client-react";
import "./notices.css";

// Popup notices for updates pushed in the background (server: lib/notices.ts):
// invoices checked in the accounts inbox, supplier bills coded or held, bank
// details flagged, and syncs that failed. The page asks every 30 seconds for
// what's new since its last read; opening the app starts from now, so old
// updates are not replayed. Notices someone needs to act on stay until closed;
// the rest close on their own.

const POLL_MS = 30_000;
const AUTO_CLOSE_MS = 12_000;
const MAX_SHOWN = 4;

// Lists to refresh when a notice of each kind arrives (matched by URL prefix).
const REFRESH: Record<Notice["kind"], string[]> = {
  invoice: ["/api/invoices/intake-checks", "/api/invoices/intake-reviews"],
  bill: ["/api/bill-coding"],
  bank: ["/api/checks/alerts"],
  sync: [],
};

export function BackgroundNotices() {
  const queryClient = useQueryClient();
  const since = useRef<string | null>(null);
  const shown = useRef(new Set<string>());
  const [notices, setNotices] = useState<Notice[]>([]);
  const query = useListLatestNotices(undefined, {
    query: {
      queryKey: getListLatestNoticesQueryKey(),
      queryFn: ({ signal }) => listLatestNotices(since.current ? { since: since.current } : undefined, { signal }),
      refetchInterval: POLL_MS,
      staleTime: 0,
      retry: false,
    },
  });

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    since.current = data.now;
    const fresh = data.items.filter((item) => !shown.current.has(item.id));
    if (!fresh.length) return;
    for (const item of fresh) shown.current.add(item.id);
    setNotices((current) => [...current, ...fresh].slice(-MAX_SHOWN));
    const prefixes = [...new Set(fresh.flatMap((item) => REFRESH[item.kind] ?? []))];
    if (prefixes.length) void queryClient.invalidateQueries({ predicate: ({ queryKey }) => typeof queryKey[0] === "string" && prefixes.some((prefix) => (queryKey[0] as string).startsWith(prefix)) });
  }, [query.data, queryClient]);

  const close = (id: string) => setNotices((current) => current.filter((item) => item.id !== id));

  if (!notices.length) return null;
  return (
    <div className="hh-notices" role="region" aria-label="Background updates">
      {notices.map((notice) => <NoticeCard key={notice.id} notice={notice} onClose={() => close(notice.id)} />)}
    </div>
  );
}

function NoticeCard({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (notice.sticky) return;
    const timer = setTimeout(() => closeRef.current(), AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [notice.sticky]);
  const Icon = notice.kind === "bank" ? Landmark : notice.kind === "sync" ? RefreshCwOff : notice.tone === "ok" ? CircleCheck : CircleAlert;
  return (
    <div className={`hh-notice ${notice.tone}`} role="status">
      <Icon size={17} className="hh-notice-icon" aria-hidden />
      <div className="hh-notice-body">
        <strong>{notice.title}</strong>
        <span>{notice.text}</span>
        {notice.detail && <small>{notice.detail}</small>}
        <Link href={notice.href} onClick={onClose}>{notice.link} →</Link>
      </div>
      <button type="button" className="hh-notice-close" aria-label="Close notice" onClick={onClose}><X size={13} /></button>
    </div>
  );
}
