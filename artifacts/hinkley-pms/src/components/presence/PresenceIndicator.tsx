import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import {
  getGetPresenceQueryKey,
  useGetPresence,
  useSendPresenceHeartbeat,
  type PresenceUser,
} from "@workspace/api-client-react";
import "./presence.css";

// Who is using the app. While the app is open the browser sends a heartbeat
// every minute, when the tab is shown or hidden, and when the page changes;
// each heartbeat returns everyone's presence, which the indicator shows.

const HEARTBEAT_MS = 60_000;
const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();

function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
const since = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function usePresenceHeartbeat(displayName: string) {
  const [path] = useLocation();
  const queryClient = useQueryClient();
  const heartbeat = useSendPresenceHeartbeat({
    mutation: { onSuccess: (list) => queryClient.setQueryData(getGetPresenceQueryKey(), list) },
  });
  const send = useRef<() => void>(() => {});
  send.current = () => heartbeat.mutate({ data: { path, visible: document.visibilityState === "visible", displayName } });

  // On load and whenever the page changes.
  useEffect(() => { send.current(); }, [path]);
  useEffect(() => {
    const timer = window.setInterval(() => send.current(), HEARTBEAT_MS);
    const onVisibility = () => send.current();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

export function PresenceIndicator() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Filled by the heartbeat; fetched directly only when the list is opened.
  const query = useGetPresence({ query: { queryKey: getGetPresenceQueryKey(), enabled: false } });
  const users = query.data?.users ?? [];
  const active = users.filter((user) => user.status !== "offline");
  const online = query.data?.onlineCount ?? 0;

  useEffect(() => {
    if (!open) return;
    void query.refetch();
    const onDown = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!query.data) return null;
  return (
    <div className="hh-presence" ref={box}>
      <button type="button" className="hh-presence-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)} title="Who is using the app" data-testid="button-presence">
        <span className="hh-presence-avatars" aria-hidden="true">
          {active.slice(0, 3).map((user) => <span key={user.userId} className={`hh-presence-avatar ${user.status}`}>{initials(user.name)}</span>)}
        </span>
        <span className="hh-presence-count"><i className="dot online" aria-hidden="true" />{online} online</span>
      </button>
      {open && (
        <div className="hh-presence-panel" role="dialog" aria-label="Who is using the app">
          <div className="hh-presence-head"><Users size={14} /> Team activity</div>
          <ul>
            {users.map((user) => <PresenceRow key={user.userId} user={user} />)}
            {!users.length && <li className="hh-presence-empty">No one has used the app in the last 30 days.</li>}
          </ul>
          <p className="hh-presence-foot">Online = active in the last 2–3 minutes. Away = tab in the background or idle up to 10 minutes. Only page names are shared, never searches.</p>
        </div>
      )}
    </div>
  );
}

function PresenceRow({ user }: { user: PresenceUser }) {
  const detail = user.status === "online"
    ? `On ${user.currentPage ?? "the app"} · since ${since(user.sessionStartedAt)}`
    : user.status === "away"
      ? `Away${user.currentPage ? ` · last on ${user.currentPage}` : ""} · ${ago(user.lastSeenAt)}`
      : `Last seen ${ago(user.lastSeenAt)}`;
  return (
    <li className={`hh-presence-row ${user.status}`}>
      <span className={`hh-presence-avatar ${user.status}`} aria-hidden="true">{initials(user.name)}</span>
      <span className="hh-presence-who">
        <strong>{user.name}{user.isYou ? " (you)" : ""}</strong>
        <small>{detail}</small>
      </span>
      <span className={`hh-presence-status ${user.status}`}><i className={`dot ${user.status}`} aria-hidden="true" />{user.status === "online" ? "Online" : user.status === "away" ? "Away" : "Offline"}</span>
    </li>
  );
}
