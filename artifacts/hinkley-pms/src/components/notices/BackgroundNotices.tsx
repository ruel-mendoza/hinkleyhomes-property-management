import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, BellOff, CircleAlert, CircleCheck, Landmark, RefreshCwOff, Settings, Trash2, X } from "lucide-react";
import {
  getGetNoticeHistoryQueryKey,
  getGetNoticeSettingsQueryKey,
  getListLatestNoticesQueryKey,
  listLatestNotices,
  useClearNoticeHistory,
  useGetNoticeHistory,
  useGetNoticeSettings,
  useListLatestNotices,
  useMarkNoticesSeen,
  useUpdateNoticeSettings,
  type Notice,
  type NoticeHistory,
  type NoticeKind,
  type NoticeSettings,
} from "@workspace/api-client-react";
import "./notices.css";

// Popup notices for updates pushed in the background (server: lib/notices.ts):
// invoices checked in the accounts inbox, supplier bills coded or held, bank
// details flagged, and syncs that failed. The page asks every 30 seconds for
// what's new since its last read; opening the app starts from now, so old
// updates are not replayed. Notices someone needs to act on stay until closed;
// the rest close on their own.
//
// The bell in the top bar (NoticeBell) lists the last 7 days with an unread
// count, can be cleared, and holds each person's choices (popups on/off, kinds
// turned off), saved to their account.

const POLL_MS = 30_000;
const HISTORY_POLL_MS = 60_000;
const AUTO_CLOSE_MS = 12_000;
const MAX_SHOWN = 4;

// Lists to refresh when a notice of each kind arrives (matched by URL prefix).
const REFRESH: Record<Notice["kind"], string[]> = {
  invoice: ["/api/invoices/intake-checks", "/api/invoices/intake-reviews"],
  bill: ["/api/bill-coding"],
  bank: ["/api/checks/alerts"],
  sync: [],
};

const iconFor = (notice: Notice) => notice.kind === "bank" ? Landmark : notice.kind === "sync" ? RefreshCwOff : notice.tone === "ok" ? CircleCheck : CircleAlert;

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
    const prefixes = ["/api/notices/history", ...new Set(fresh.flatMap((item) => REFRESH[item.kind] ?? []))];
    void queryClient.invalidateQueries({ predicate: ({ queryKey }) => typeof queryKey[0] === "string" && prefixes.some((prefix) => (queryKey[0] as string).startsWith(prefix)) });
  }, [query.data, queryClient]);

  // Turning popups or a kind off in the bell also closes those already on screen.
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

function NoticeCard({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (notice.sticky) return;
    const timer = setTimeout(() => closeRef.current(), AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [notice.sticky]);
  const Icon = iconFor(notice);
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

// --- The bell: notification list and settings --------------------------------------

const useNoticeSettings = () => useGetNoticeSettings({ query: { queryKey: getGetNoticeSettingsQueryKey(), staleTime: 5 * 60_000, retry: false } });

const KIND_OPTIONS: { kind: NoticeKind; label: string; caption: string }[] = [
  { kind: "invoice", label: "New invoices", caption: "Accounts inbox: passed, for review or missing details" },
  { kind: "bill", label: "Supplier bills", caption: "Needs a property, written to Xero, or failed" },
  { kind: "bank", label: "Bank details", caption: "Supplier bank details that need checking" },
  { kind: "sync", label: "Failed updates", caption: "A background update that didn't work" },
];

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayAndClock = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function when(iso: string) {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `Today ${clock.format(date)}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock.format(date)}`;
  return dayAndClock.format(date);
}

export function NoticeBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"list" | "settings">("list");
  // When the list was last seen before this opening, for the "Last seen" line.
  const [seenBefore, setSeenBefore] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const history = useGetNoticeHistory({ query: { queryKey: getGetNoticeHistoryQueryKey(), refetchInterval: HISTORY_POLL_MS, retry: false } });
  const settingsQuery = useNoticeSettings();
  const putHistory = (data: NoticeHistory) => queryClient.setQueryData(getGetNoticeHistoryQueryKey(), data);
  const markSeen = useMarkNoticesSeen({ mutation: { onSuccess: putHistory } });
  const clear = useClearNoticeHistory({ mutation: { onSuccess: putHistory } });
  const update = useUpdateNoticeSettings({
    mutation: {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetNoticeSettingsQueryKey(), saved);
        void queryClient.invalidateQueries({ queryKey: getGetNoticeHistoryQueryKey() });
      },
    },
  });
  const settings: NoticeSettings = update.isPending && update.variables ? update.variables.data : settingsQuery.data ?? { enabled: true, muted: [] };
  const save = (next: NoticeSettings) => update.mutate({ data: next });
  const toggleKind = (kind: NoticeKind) => save({ ...settings, muted: settings.muted.includes(kind) ? settings.muted.filter((item) => item !== kind) : [...settings.muted, kind] });
  const popupsOff = !settings.enabled || settings.muted.length === KIND_OPTIONS.length;
  const items = history.data?.items ?? [];
  const unread = history.data?.unread ?? 0;

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setSeenBefore(history.data?.lastSeenAt ?? null);
    setView("list");
    setOpen(true);
    if (unread > 0) markSeen.mutate();
  };

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

  // Not set up yet (table not pushed): no bell rather than a broken one.
  if (history.isError && settingsQuery.isError) return null;
  const isNew = (item: Notice) => !seenBefore || item.at > seenBefore;
  const newCount = items.filter(isNew).length;

  return (
    <div className="hh-bell" ref={box}>
      <button type="button" className={`hh-bell-button ${popupsOff ? "off" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={toggle} title={popupsOff ? "Notifications (popups off)" : "Notifications"} aria-label={unread ? `Notifications, ${unread} new` : "Notifications"} data-testid="button-notice-bell">
        {popupsOff ? <BellOff size={15} /> : <Bell size={15} />}
        {unread > 0 && <span className="hh-bell-count" aria-hidden>{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="hh-bell-panel" role="dialog" aria-label="Notifications">
          {view === "list" ? <>
            <div className="hh-bell-head">
              <strong>Notifications</strong>
              <button type="button" className="hh-bell-icon" title="Clear all" aria-label="Clear all" onClick={() => clear.mutate()} disabled={!items.length || clear.isPending} data-testid="button-notices-clear"><Trash2 size={14} /></button>
              <button type="button" className="hh-bell-icon" title="Settings" aria-label="Settings" onClick={() => setView("settings")} data-testid="button-notices-settings"><Settings size={14} /></button>
              <button type="button" className="hh-bell-icon" title="Close" aria-label="Close" onClick={() => setOpen(false)}><X size={14} /></button>
            </div>
            {history.isLoading ? <p className="hh-bell-empty">Loading…</p>
              : history.isError ? <p className="hh-bell-empty">The list couldn't be loaded. Try again in a minute.</p>
                : !items.length ? <div className="hh-bell-empty"><Bell size={26} aria-hidden /><strong>You're all caught up</strong><small>No updates in the last 7 days.</small></div>
                  : <ul className="hh-bell-list">
                    {items.map((item, index) => {
                      const Icon = iconFor(item);
                      const divider = seenBefore && newCount > 0 && index === newCount;
                      return <li key={item.id}>
                        {divider && <div className="hh-bell-divider"><span>Last seen</span></div>}
                        <Link href={item.href} onClick={() => setOpen(false)} className={`hh-bell-item ${item.tone} ${isNew(item) ? "new" : ""}`}>
                          <Icon size={15} className="hh-bell-item-icon" aria-hidden />
                          <span className="hh-bell-item-body">
                            <strong>{item.title}</strong>
                            <span>{item.text}</span>
                            {item.detail && <small>{item.detail}</small>}
                            <em>{when(item.at)}</em>
                          </span>
                        </Link>
                      </li>;
                    })}
                  </ul>}
            {popupsOff && <p className="hh-bell-foot">Popups are off. New updates still show here. <button type="button" className="hh-bell-link" onClick={() => setView("settings")}>Change</button></p>}
          </> : <>
            <div className="hh-bell-head">
              <button type="button" className="hh-bell-icon" title="Back" aria-label="Back to notifications" onClick={() => setView("list")}><ArrowLeft size={14} /></button>
              <strong>Notification settings</strong>
              <button type="button" className="hh-bell-icon" title="Close" aria-label="Close" onClick={() => setOpen(false)}><X size={14} /></button>
            </div>
            <label className="hh-bell-main">
              <span><strong>Popups</strong><small>Show new updates in the bottom-right corner</small></span>
              <input type="checkbox" role="switch" checked={settings.enabled} onChange={() => save({ ...settings, enabled: !settings.enabled })} disabled={settingsQuery.isLoading} data-testid="switch-notices" />
            </label>
            <p className="hh-bell-sub">Show these updates</p>
            <ul className="hh-bell-kinds">
              {KIND_OPTIONS.map((option) => (
                <li key={option.kind}>
                  <label>
                    <input type="checkbox" checked={!settings.muted.includes(option.kind)} onChange={() => toggleKind(option.kind)} disabled={settingsQuery.isLoading} data-testid={`check-notice-${option.kind}`} />
                    <span><strong>{option.label}</strong><small>{option.caption}</small></span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="hh-bell-foot">{update.isError ? "Couldn't save. Try again in a minute." : "Saved to your account, so it applies on any computer."}</p>
          </>}
        </div>
      )}
    </div>
  );
}
