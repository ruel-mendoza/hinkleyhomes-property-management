import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  ClipboardList,
  Eye,
  Hand,
  House,
  Megaphone,
  Plus,
  RefreshCw,
  Search,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  getListCohoActionsQueryKey,
  type CohoActionCategory,
  type CohoActionItem,
  type ListCohoActionsStatus,
  useListCohoActions,
  useSyncCohoActions,
} from "@workspace/api-client-react";
import { ActionDetailModal, CreateActionModal, errorText } from "@/components/action-modals";
import "./actions.css";

const PAGE_SIZE = 50;
// Refresh from COHO when the stored copy is older than this on page open.
const STALE_AFTER_MS = 5 * 60_000;
const UK = "Europe/London";

const TABS: { key: CohoActionCategory | "all"; label: string; Icon: typeof House }[] = [
  { key: "all", label: "All", Icon: ClipboardList },
  { key: "property", label: "Property", Icon: House },
  { key: "tenancy", label: "Tenancy", Icon: Users },
  { key: "maintenance", label: "Maintenance", Icon: Wrench },
  { key: "onboarding", label: "Onboarding", Icon: Hand },
  { key: "viewing", label: "Viewing", Icon: Eye },
  { key: "other", label: "Other", Icon: Megaphone },
];
const STATUS_LABEL: Record<CohoActionItem["status"], string> = {
  not_set: "Not set",
  new: "New",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
};
const STATUS_CLASS: Record<CohoActionItem["status"], string> = {
  not_set: "status",
  new: "status pending",
  in_progress: "status in-progress",
  on_hold: "status",
  completed: "status completed",
};

// COHO due dates are UK dates stored as UTC (e.g. 23:00Z the day before), so
// always show them in UK time whatever the viewer's computer is set to.
const ukDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString("en-GB", { timeZone: UK, day: "2-digit", month: "short", year: "numeric" }) : "—";
const ukDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-GB", { timeZone: UK, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export default function ActionsPage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<CohoActionCategory | "all">("all");
  const [status, setStatus] = useState<ListCohoActionsStatus>("open");
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CohoActionItem | null>(null);
  const [creating, setCreating] = useState(false);

  // Debounce typing so each keystroke doesn't hit the database.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => setPage(1), [category, status, includeSnoozed, search, selectedPropertyReference]);

  const params = useMemo(
    () => ({
      ...(category === "all" ? {} : { category }),
      status,
      ...(includeSnoozed ? { includeSnoozed: true } : {}),
      ...(search ? { search } : {}),
      ...(selectedPropertyReference ? { propertyReference: selectedPropertyReference } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [category, status, includeSnoozed, search, selectedPropertyReference, page],
  );
  const listQuery = useListCohoActions(params, {
    query: { queryKey: getListCohoActionsQueryKey(params), placeholderData: (previous) => previous },
  });
  const syncMutation = useSyncCohoActions();
  const [syncMessage, setSyncMessage] = useState("");

  const runSync = async (trigger: "manual" | "page-open") => {
    setSyncMessage("");
    try {
      const result = await syncMutation.mutateAsync({ params: { trigger } });
      await queryClient.invalidateQueries({ queryKey: getListCohoActionsQueryKey() });
      if (trigger === "manual" || result.created > 0) {
        setSyncMessage(
          result.status === "skipped"
            ? "A sync is already running."
            : `Synced ${result.fetched} actions · ${result.created} new · ${result.updated} changed${result.removed ? ` · ${result.removed} removed in COHO` : ""}.`,
        );
      }
    } catch (error) {
      setSyncMessage(`Sync failed: ${errorText(error)}`);
    }
  };

  // On first load, refresh from COHO if the stored copy is stale.
  const checkedStaleness = useRef(false);
  const lastSync = listQuery.data?.lastSync ?? null;
  useEffect(() => {
    if (checkedStaleness.current || !listQuery.isSuccess) return;
    checkedStaleness.current = true;
    const finished = lastSync?.finishedAt ? new Date(lastSync.finishedAt).getTime() : 0;
    if (Date.now() - finished > STALE_AFTER_MS) void runSync("page-open");
  }, [listQuery.isSuccess, lastSync]);

  const data = listQuery.data;
  const items = data?.items ?? [];
  const counts = data?.categoryCounts;
  const allCount = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
  const firstRow = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastRow = data ? firstRow + items.length - 1 : 0;
  const dayAgo = Date.now() - 86_400_000;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO</div>
          <h1 className="page-title">Actions</h1>
          <p className="page-sub">Every COHO action, saved to Supabase and kept up to date. Click an action to change its status, assign it or snooze it.</p>
        </div>
        <div className="head-actions hh-act-sync">
          <span className={syncMessage.startsWith("Sync failed") ? "failed" : ""} role="status">
            {syncMutation.isPending ? "Syncing with COHO…" : syncMessage || (lastSync?.finishedAt ? `Last synced ${ukDateTime(lastSync.finishedAt)}` : "Not synced yet")}
          </span>
          <button className="button" onClick={() => void runSync("manual")} disabled={syncMutation.isPending} data-testid="button-sync-actions">
            <RefreshCw size={14} className={syncMutation.isPending ? "spin" : ""} /> Sync now
          </button>
          <button className="button primary" onClick={() => setCreating(true)} data-testid="button-new-action">
            <Plus size={14} /> New action
          </button>
        </div>
      </div>

      <div className="hh-act-tabs" role="tablist" aria-label="Action categories">
        {TABS.map(({ key, label, Icon }) => {
          const count = key === "all" ? allCount : (counts?.[key] ?? 0);
          return (
            <button key={key} role="tab" aria-selected={category === key} className={`hh-act-tab ${category === key ? "active" : ""}`} onClick={() => setCategory(key)} data-testid={`tab-actions-${key}`}>
              <Icon size={18} />
              <span><strong>{label}</strong><small>{counts ? `${count} ${count === 1 ? "action" : "actions"}` : "…"}</small></span>
            </button>
          );
        })}
      </div>

      <section className="panel table-panel">
        <div className="table-toolbar" style={{ flexWrap: "wrap" }}>
          <div className="global-search">
            <Search size={14} />
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search action, property, room or person…" aria-label="Search actions" data-testid="input-search-actions" />
            {searchInput && <button className="icon-btn" onClick={() => setSearchInput("")} aria-label="Clear search"><X size={13} /></button>}
          </div>
          <div className="hh-act-filters">
            <select className="select-control" value={status} onChange={(event) => setStatus(event.target.value as ListCohoActionsStatus)} aria-label="Status">
              <option value="open">Open</option>
              <option value="completed">Completed</option>
              <option value="all">All (incl. archived)</option>
            </select>
            <label><input type="checkbox" checked={includeSnoozed} onChange={(event) => setIncludeSnoozed(event.target.checked)} /> Include snoozed</label>
            {selectedPropertyReference && <span className="status upcoming"><Building2 size={12} /> Selected property only</span>}
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead><tr><th>Action</th><th>Property</th><th>Due</th><th>Status</th><th>Assigned</th><th>Tags</th><th>First saved</th></tr></thead>
            <tbody>
              {listQuery.isError ? (
                <tr><td colSpan={7}><div className="empty-state"><ClipboardList size={21} /><h3>Actions could not be loaded</h3><p>{errorText(listQuery.error)}</p></div></td></tr>
              ) : !data ? (
                <tr><td colSpan={7}><div className="empty-state"><ClipboardList size={21} /><h3>Loading actions…</h3></div></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={7}><div className="empty-state"><ClipboardList size={21} /><h3>No actions match</h3><p>{lastSync ? "Try another tab, status or search." : "Run Sync now to pull actions from COHO."}</p></div></td></tr>
              ) : items.map((action) => (
                <tr
                  key={action.reference}
                  className="hh-act-row"
                  tabIndex={0}
                  aria-label={`Open ${action.title || action.typeName || "action"}`}
                  onClick={() => setSelected(action)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(action); } }}
                  data-testid={`row-action-${action.reference}`}
                >
                  <td>
                    <div className="hh-act-title">
                      <strong>{action.title || action.typeName || "Untitled action"}{new Date(action.firstSeenAt).getTime() > dayAgo && <span className="hh-act-new">NEW</span>}</strong>
                      <small>{action.typeName}{action.progressionStepsCount > 0 ? ` · step ${action.progressionStepsCompleted}/${action.progressionStepsCount}` : ""}</small>
                    </div>
                  </td>
                  <td>{action.propertyName || action.propertyReference || "—"}{action.roomName && <div className="hh-act-sub">{action.roomName}</div>}</td>
                  <td className="hh-act-due">{ukDate(action.dueDate)}{action.overdue && action.status !== "completed" && <div><span className="status overdue">Overdue</span></div>}</td>
                  <td>
                    <span className={STATUS_CLASS[action.status]}>{STATUS_LABEL[action.status]}</span>
                    {action.snoozed && <div className="hh-act-sub">Snoozed{action.snoozedUntil ? ` to ${ukDate(action.snoozedUntil)}` : ""}</div>}
                    {action.removedFromCoho && <div className="hh-act-sub">No longer in COHO</div>}
                  </td>
                  <td>{action.assignedToName || <span className="secondary-text">Unassigned</span>}</td>
                  <td><div className="hh-act-tags">{action.tags.length ? action.tags.map((tag) => <span key={tag}>{tag}</span>) : <span className="secondary-text" style={{ background: "none", padding: 0 }}>—</span>}</div></td>
                  <td className="hh-act-due">{ukDate(action.firstSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data && data.totalCount > 0 && (
          <div className="hh-act-pager">
            <span>{firstRow}–{lastRow} of {data.totalCount}</span>
            <div>
              <button className="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} aria-label="Previous page"><ArrowLeft size={13} /></button>
              <button className="button" onClick={() => setPage((p) => p + 1)} disabled={!data.hasNextPage} aria-label="Next page"><ArrowRight size={13} /></button>
            </div>
          </div>
        )}
      </section>

      {selected && <ActionDetailModal key={selected.reference} action={selected} onClose={() => setSelected(null)} />}
      {creating && (
        <CreateActionModal
          initialPropertyReference={selectedPropertyReference}
          onClose={() => setCreating(false)}
          onCreated={(created) => { setCreating(false); setSyncMessage(`Created “${created.title}” in COHO.`); setSelected(created); }}
        />
      )}
    </>
  );
}
