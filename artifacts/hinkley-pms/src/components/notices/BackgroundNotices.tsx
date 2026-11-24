import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CircleAlert, CircleCheck, Landmark, RefreshCwOff, X } from "lucide-react";
import {
  getGetNoticeSettingsQueryKey,
  getListLatestNoticesQueryKey,
  listLatestNotices,
  useGetNoticeSettings,
  useListLatestNotices,
  useUpdateNoticeSettings,
  type Notice,
  type NoticeKind,
  type NoticeSettings,
} from "@workspace/api-client-react";
import "./notices.css";

// Popup notices for updates pushed in the background (server: lib/notices.ts):
// invoices checked in the accounts inbox, supplier bills coded or held, bank
// details flagged, and syncs that failed. The page asks every 30 seconds for
// what's new since its last read; opening the app starts from now, so old
// updates are not replayed. Notices someone needs to act on stay until closed;
// the rest close on their own. Each person can turn them off, or turn off some
// kinds, with the bell in the top bar (NoticeBell); the server then stops
// sending those.

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

  // Turning a kind off in the bell also closes its notices already on screen.
  const settings = useNoticeSettings().data;
  const visible = settings && !settings.enabled ? [] : notices.filter((item) => !settings?.muted.includes(item.kind));
  const close = (id: string) => setNotices((current) => current.filter((item) => item.id !== id));

  if (!visible.length) return null;
  return (
    <div className="hh-notices" role="region" aria-label="Background updates">
      {visible.map((notice) => <NoticeCard key={notice.id} notice={notice} onClose={() => close(notice.id)} />)}
    </div>
  );
}

const useNoticeSettings = () => useGetNoticeSettings({ query: { queryKey: getGetNoticeSettingsQueryKey(), staleTime: 5 * 60_000, retry: false } });

const KIND_OPTIONS: { kind: NoticeKind; label: string; caption: string }[] = [
  { kind: "invoice", label: "New invoices", caption: "Accounts inbox: passed, for review or missing details" },
  { kind: "bill", label: "Supplier bills", caption: "Needs a property, written to Xero, or failed" },
  { kind: "bank", label: "Bank details", caption: "Supplier bank details that need checking" },
  { kind: "sync", label: "Failed updates", caption: "A background update that didn't work" },
];

// The bell in the top bar: this person's popup notice choices, saved to their account.
export function NoticeBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const query = useNoticeSettings();
  const update = useUpdateNoticeSettings({
    mutation: { onSuccess: (saved) => queryClient.setQueryData(getGetNoticeSettingsQueryKey(), saved) },
  });
  const settings: NoticeSettings = update.isPending && update.variables ? update.variables.data : query.data ?? { enabled: true, muted: [] };
  const save = (next: NoticeSettings) => update.mutate({ data: next });
  const toggleKind = (kind: NoticeKind) => save({ ...settings, muted: settings.muted.includes(kind) ? settings.muted.filter((item) => item !== kind) : [...settings.muted, kind] });
  const allOff = !settings.enabled || settings.muted.length === KIND_OPTIONS.length;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (query.isError) return null;
  return (
    <div className="hh-bell" ref={box}>
      <button type="button" className={`hh-bell-button ${allOff ? "off" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} title={allOff ? "Popup notices are off" : "Popup notices"} aria-label="Popup notices" data-testid="button-notice-bell">
        {allOff ? <BellOff size={15} /> : <Bell size={15} />}
      </button>
      {open && (
        <div className="hh-bell-panel" role="dialog" aria-label="Popup notices">
          <label className="hh-bell-main">
            <span><strong>Popup notices</strong><small>Updates pushed in the background, in the bottom-right corner</small></span>
            <input type="checkbox" role="switch" checked={settings.enabled} onChange={() => save({ ...settings, enabled: !settings.enabled })} disabled={query.isLoading} data-testid="switch-notices" />
          </label>
          <ul>
            {KIND_OPTIONS.map((option) => (
              <li key={option.kind}>
                <label className={settings.enabled ? "" : "disabled"}>
                  <input type="checkbox" checked={!settings.muted.includes(option.kind)} onChange={() => toggleKind(option.kind)} disabled={!settings.enabled || query.isLoading} data-testid={`check-notice-${option.kind}`} />
                  <span><strong>{option.label}</strong><small>{option.caption}</small></span>
                </label>
              </li>
            ))}
          </ul>
          <p className="hh-bell-foot">{update.isError ? "Couldn't save. Try again in a minute." : "Saved to your account, so it applies on any computer."}</p>
        </div>
      )}
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
