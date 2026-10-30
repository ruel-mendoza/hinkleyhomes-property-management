import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Merge,
  Plus,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import {
  getGetCohoStatusQueryKey,
  getListCohoMaintenanceQueryKey,
  getListCohoMaintenanceCategoriesQueryKey,
  getListCohoPropertiesQueryKey,
  type CohoMaintenance,
  type CohoMaintenanceComplete,
  type CohoMaintenanceInput,
  type CohoMaintenanceUpdate,
  useCompleteCohoMaintenance,
  useCreateCohoMaintenance,
  useGetCohoStatus,
  useListCohoMaintenance,
  useListCohoMaintenanceCategories,
  useListCohoProperties,
  useMergeCohoMaintenance,
  useUpdateCohoMaintenance,
} from "@workspace/api-client-react";
import "./coho-maintenance.css";

const PAGE_SIZE = 50;

type FormEventWithData = FormEvent<HTMLFormElement>;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      data?: { error?: unknown };
    };
    if (typeof candidate.data?.error === "string") return candidate.data.error;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return "Something went wrong. Please try again.";
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

// COHO closes some issues (e.g. its automatic Fire Safety Review jobs) without
// changing their status, so a closed date counts as closed too.
function isClosed(issue: CohoMaintenance): boolean {
  return /complete|closed/i.test(issue.publicStatus) || Boolean(issue.dateClosed);
}

function statusText(issue: CohoMaintenance): string {
  return issue.dateClosed && !/complete/i.test(issue.publicStatus) ? "closed" : issue.publicStatus;
}

// Marked by a merge in this app (see api-server lib/maintenance-merge.ts).
const MERGED_NOTE = /Duplicate of ([^,.\n]+), merged in Hinkley PMS/;

function isMerged(issue: CohoMaintenance): boolean {
  return MERGED_NOTE.test(issue.managerNotes ?? "");
}

// The same issue reported more than once: same property, room, title and
// tenant on the same day. Shown as one row; COHO still has each record.
type IssueGroup = { main: CohoMaintenance; others: CohoMaintenance[] };

function duplicateKey(issue: CohoMaintenance): string {
  const day = String(issue.created ?? "").slice(0, 10);
  return [
    issue.propertyReference ?? issue.propertyName ?? "",
    issue.roomReference ?? "",
    (issue.title ?? "").trim().toLowerCase(),
    (issue.tenantName ?? "").trim().toLowerCase(),
    day,
  ].join("|");
}

function groupIssues(issues: CohoMaintenance[]): IssueGroup[] {
  const byKey = new Map<string, CohoMaintenance[]>();
  const byJob = new Map(issues.map((issue) => [issue.jobNumber, issue]));
  for (const issue of issues) {
    // A merged duplicate stays with the issue it was merged into.
    const into = MERGED_NOTE.exec(issue.managerNotes ?? "")?.[1];
    const target = into && byJob.get(into);
    const key = target ? duplicateKey(target) : duplicateKey(issue);
    byKey.set(key, [...(byKey.get(key) ?? []), issue]);
  }
  return [...byKey.values()].map((members) => {
    const oldestFirst = [...members].sort(
      (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
    );
    const main =
      oldestFirst.find((issue) => !isMerged(issue) && !isClosed(issue)) ??
      oldestFirst.find((issue) => !isMerged(issue)) ??
      oldestFirst[0]!;
    return { main, others: oldestFirst.filter((issue) => issue !== main) };
  });
}

export default function CohoMaintenancePage() {
  const queryClient = useQueryClient();
  // ?report=1&property=…&room=… (from the calendar) opens "New issue" prefilled.
  const urlSearch = useSearch();
  const [, navigate] = useLocation();
  const [prefill] = useState(() => {
    const params = new URLSearchParams(urlSearch);
    return {
      open: params.get("report") === "1",
      property: params.get("property") ?? "",
      room: params.get("room") ?? "",
    };
  });
  const [page, setPage] = useState(1);
  const [propertyReference, setPropertyReference] = useState("");
  const [newPropertyReference, setNewPropertyReference] = useState(prefill.property);
  const [search, setSearch] = useState("");
  // Searched on the server across every page (COHO's list can't search), after a pause in typing.
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchTerm(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);
  // Hidden by default, as on COHO's own maintenance screen.
  const [showClosed, setShowClosed] = useState(false);
  const [createOpen, setCreateOpen] = useState(prefill.open);
  useEffect(() => {
    // Drop the query so a refresh doesn't reopen the form.
    if (prefill.open) navigate("/maintenance", { replace: true });
  }, []);
  const [selected, setSelected] = useState<CohoMaintenance | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [mergeGroup, setMergeGroup] = useState<IssueGroup | null>(null);
  const [keepGuid, setKeepGuid] = useState("");
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  const statusQuery = useGetCohoStatus({
    query: {
      queryKey: getGetCohoStatusQueryKey(),
      refetchInterval: 15_000,
    },
  });
  const configured = statusQuery.data?.configured === true;
  const propertiesQuery = useListCohoProperties(
    { page: 1, pageSize: 100 },
    {
      query: {
        enabled: configured,
        queryKey: getListCohoPropertiesQueryKey({ page: 1, pageSize: 100 }),
      },
    },
  );
  const categoriesQuery = useListCohoMaintenanceCategories({
    query: {
      enabled: configured,
      queryKey: getListCohoMaintenanceCategoriesQueryKey(),
    },
  });
  const listParams = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      ...(propertyReference ? { propertyReference } : {}),
      ...(searchTerm ? { search: searchTerm } : {}),
      ...(showClosed ? { includeClosed: true } : {}),
    }),
    [page, propertyReference, searchTerm, showClosed],
  );
  const issuesQuery = useListCohoMaintenance(listParams, {
    query: {
      enabled: configured,
      queryKey: getListCohoMaintenanceQueryKey(listParams),
    },
  });

  const createMutation = useCreateCohoMaintenance();
  const updateMutation = useUpdateCohoMaintenance();
  const completeMutation = useCompleteCohoMaintenance();
  const mergeMutation = useMergeCohoMaintenance();

  const refreshIssues = async () => {
    await queryClient.invalidateQueries({
      queryKey: getListCohoMaintenanceQueryKey(),
    });
  };

  const afterMutation = async (message: string) => {
    await refreshIssues();
    setNotice(message);
    setFormError("");
    setCreateOpen(false);
    setSelected(null);
  };

  const createIssue = async (event: FormEventWithData) => {
    event.preventDefault();
    setFormError("");
    const form = new FormData(event.currentTarget);
    const payload: CohoMaintenanceInput = {
      propertyReference: String(form.get("propertyReference") || ""),
      roomReference: String(form.get("roomReference") || "") || null,
      title: String(form.get("title") || "").trim(),
      requestMessage: String(form.get("requestMessage") || "").trim() || null,
      managerNotes: String(form.get("managerNotes") || "").trim() || null,
      severity: String(form.get("severity") || "medium") as
        | "unknown"
        | "low"
        | "medium"
        | "high",
      maintenanceCategoryGuid:
        String(form.get("maintenanceCategoryGuid") || "") || null,
    };
    try {
      const created = await createMutation.mutateAsync({ data: payload });
      await afterMutation(
        `Maintenance issue ${created.jobNumber || "created"} in COHO.`,
      );
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const updateIssue = async (event: FormEventWithData) => {
    event.preventDefault();
    if (!selected) return;
    setFormError("");
    const form = new FormData(event.currentTarget);
    const payload: CohoMaintenanceUpdate = {
      severity: String(form.get("severity") || "medium") as
        | "unknown"
        | "low"
        | "medium"
        | "high",
      managerNotes: String(form.get("managerNotes") || "").trim() || null,
    };
    try {
      await updateMutation.mutateAsync({
        guid: selected.guid,
        data: payload,
      });
      await afterMutation("COHO maintenance issue updated.");
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const completeIssue = async (event: FormEventWithData) => {
    event.preventDefault();
    if (!selected) return;
    setFormError("");
    const form = new FormData(event.currentTarget);
    const payload: CohoMaintenanceComplete = {
      awaitingDecision: String(form.get("awaitingDecision") || "complete") as
        | "complete"
        | "awaitingInvoice"
        | "awaitingOther",
      completionNotes: String(form.get("completionNotes") || "").trim() || null,
      dateMaintenanceCarriedOut: new Date().toISOString(),
    };
    try {
      await completeMutation.mutateAsync({
        guid: selected.guid,
        data: payload,
      });
      await afterMutation("COHO maintenance issue marked complete.");
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const openMerge = (group: IssueGroup) => {
    setNotice("");
    setFormError("");
    setKeepGuid(group.main.guid);
    setMergeGroup(group);
  };

  const mergeIssues = async () => {
    if (!mergeGroup) return;
    const members = [mergeGroup.main, ...mergeGroup.others];
    const keep = members.find((issue) => issue.guid === keepGuid) ?? mergeGroup.main;
    const duplicates = members
      .filter((issue) => issue.guid !== keep.guid && !isMerged(issue))
      .map((issue) => ({
        guid: issue.guid,
        jobNumber: issue.jobNumber ?? null,
        managerNotes: issue.managerNotes ?? null,
        closed: isClosed(issue),
      }));
    setFormError("");
    try {
      const result = await mergeMutation.mutateAsync({
        guid: keep.guid,
        data: { keepJobNumber: keep.jobNumber ?? null, duplicates },
      });
      await refreshIssues();
      if (result.failed.length) {
        setFormError(
          `Merged ${result.merged}. Not merged: ${result.failed.map((item) => `${item.jobNumber} (${item.error})`).join("; ")}`,
        );
        return;
      }
      setNotice(
        `Merged ${result.merged} ${result.merged === 1 ? "duplicate" : "duplicates"} into ${keep.jobNumber || "the kept issue"} in COHO.`,
      );
      setMergeGroup(null);
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const toggleExpanded = (guid: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(guid)) next.delete(guid);
      else next.add(guid);
      return next;
    });

  const properties = propertiesQuery.data?.items ?? [];
  const selectedProperty = properties.find(
    (property) => property.reference === newPropertyReference,
  );
  const categories = categoriesQuery.data?.items ?? [];
  const allIssues = issuesQuery.data?.items ?? [];
  const groups = useMemo(() => groupIssues(allIssues), [allIssues]);
  const duplicateCount = allIssues.length - groups.length;
  const matches = (issue: CohoMaintenance) =>
    [
      issue.jobNumber,
      issue.title,
      issue.requestMessage,
      issue.propertyName,
      issue.roomName,
      issue.tenantName,
      issue.publicStatus,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase());
  const visibleGroups = groups.filter(
    (group) => matches(group.main) || group.others.some(matches),
  );
  const manage = (issue: CohoMaintenance) => {
    setNotice("");
    setFormError("");
    setSelected(issue);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Operations</div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-sub">
            Live issues from COHO Public API {statusQuery.data?.apiVersion ?? "1.1"}
          </p>
        </div>
        <div className="head-actions">
          {configured && <span className="demo-pill">COHO KEY CONFIGURED</span>}
          <button
            className="button"
            onClick={() => {
              setNotice("");
              void statusQuery.refetch();
              void issuesQuery.refetch();
            }}
            disabled={!configured || issuesQuery.isFetching}
          >
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            className="button primary"
            onClick={() => {
              setNotice("");
              setFormError("");
              setNewPropertyReference(propertyReference);
              setCreateOpen(true);
            }}
            disabled={!configured || properties.length === 0}
          >
            <Plus size={14} /> New issue
          </button>
        </div>
      </div>

      {statusQuery.isLoading && (
        <section className="panel" style={{ padding: 16 }}>
          Checking COHO connection…
        </section>
      )}
      {statusQuery.isError && (
        <section className="panel" role="alert" style={{ padding: 16, marginBottom: 14 }}>
          <AlertCircle size={15} /> Could not check the COHO connection.{" "}
          {errorMessage(statusQuery.error)}
        </section>
      )}
      {statusQuery.data?.configured === false && (
        <section className="panel" style={{ padding: 20, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <Wrench size={19} color="#398875" />
            <div>
              <div className="panel-title">COHO API key needed</div>
              <p className="page-sub" style={{ margin: "6px 0 0" }}>
                Add <strong>COHO_API_KEY</strong> in Replit Secrets to load
                properties and maintenance issues. The key is used only by the
                server and is never sent to the browser.
              </p>
            </div>
          </div>
        </section>
      )}
      {configured && propertiesQuery.isError && (
        <section
          className="panel"
          role="alert"
          style={{ padding: 16, marginBottom: 14 }}
        >
          <AlertCircle size={15} /> Could not load COHO properties.{" "}
          {errorMessage(propertiesQuery.error)}
        </section>
      )}

      {notice && (
        <div className="status ready" role="status" style={{ marginBottom: 12 }}>
          <Check size={13} /> {notice}
        </div>
      )}

      {configured && (
        <>
          <div
            className="metrics"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}
          >
            <div className="panel metric">
              <div className="metric-top">Issues on this page</div>
              <div className="metric-value">{groups.length}</div>
              <div className="metric-foot">
                Page {issuesQuery.data?.page ?? page}
                {duplicateCount > 0 &&
                  ` · ${duplicateCount} ${duplicateCount === 1 ? "duplicate" : "duplicates"} grouped`}
              </div>
            </div>
            <div className="panel metric">
              <div className="metric-top">Open on this page</div>
              <div className="metric-value">
                {groups.filter((group) => !isClosed(group.main)).length}
              </div>
              <div className="metric-foot">Not marked complete or closed</div>
            </div>
            <div className="panel metric">
              <div className="metric-top">COHO properties</div>
              <div className="metric-value">
                {propertiesQuery.data?.totalCount ?? "—"}
              </div>
              <div className="metric-foot">Available for issue mapping</div>
            </div>
          </div>

          <section className="panel table-panel">
            <div className="table-toolbar">
              <div className="global-search">
                <ClipboardList size={14} />
                <input
                  aria-label="Search maintenance issues"
                  placeholder="Search job, issue, property or tenant…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button className="icon-btn" onClick={() => setSearch("")}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="filter-bar">
                <select
                  className="select-control"
                  aria-label="Filter by COHO property"
                  value={propertyReference}
                  onChange={(event) => {
                    setPropertyReference(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All properties</option>
                  {properties.map((property) => (
                    <option
                      key={property.reference ?? property.name}
                      value={property.reference ?? ""}
                      disabled={!property.reference}
                    >
                      {property.name || property.reference || "Unnamed property"}
                    </option>
                  ))}
                </select>
                <span className="panel-caption">
                  {issuesQuery.data?.totalCount ?? 0} issues
                </span>
                <label className="panel-caption" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={showClosed}
                    onChange={(event) => {
                      setShowClosed(event.target.checked);
                      setPage(1);
                    }}
                    data-testid="toggle-maintenance-closed"
                  />
                  Show closed{!showClosed && issuesQuery.data?.closedCount ? ` (${issuesQuery.data.closedCount})` : ""}
                </label>
              </div>
            </div>

            {issuesQuery.isLoading && (
              <div className="empty-state">Loading COHO maintenance issues…</div>
            )}
            {issuesQuery.isError && (
              <div className="empty-state" role="alert">
                <AlertCircle size={20} />
                <h3>Could not load maintenance issues</h3>
                <p>{errorMessage(issuesQuery.error)}</p>
              </div>
            )}
            {!issuesQuery.isLoading && !issuesQuery.isError && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Issue</th>
                      <th>Property / room</th>
                      <th>Reported</th>
                      <th>Severity</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleGroups.flatMap((group) => {
                      const issue = group.main;
                      const open = expanded.has(issue.guid);
                      const unmerged = group.others.filter((other) => !isMerged(other));
                      return [
                        <tr key={issue.guid}>
                          <td>
                            <strong>{issue.jobNumber || "—"}</strong>
                            {group.others.length > 0 && (
                              <button
                                type="button"
                                className="mnt-dup-toggle"
                                aria-expanded={open}
                                onClick={() => toggleExpanded(issue.guid)}
                              >
                                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                +{group.others.length}{" "}
                                {group.others.length === 1 ? "duplicate" : "duplicates"}
                              </button>
                            )}
                          </td>
                          <td>
                            <strong>{issue.title || "Maintenance issue"}</strong>
                            <span className="secondary-text">
                              {issue.tenantName || issue.requestMessage || "—"}
                            </span>
                          </td>
                          <td>
                            {issue.propertyName || issue.propertyReference || "—"}
                            <span className="secondary-text">
                              {issue.roomName || issue.roomReference || " "}
                            </span>
                          </td>
                          <td>{formatDate(issue.created)}</td>
                          <td>
                            <span className={"status " + issue.severity}>
                              {issue.severity}
                            </span>
                          </td>
                          <td>
                            <span className={"status " + statusText(issue)}>
                              {statusText(issue)}
                            </span>
                          </td>
                          <td>
                            <div className="mnt-actions">
                              <button className="table-action" onClick={() => manage(issue)}>
                                Manage
                              </button>
                              {unmerged.length > 0 && (
                                <button className="table-action" onClick={() => openMerge(group)}>
                                  <Merge size={12} /> Merge
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>,
                        ...(open
                          ? group.others.map((other) => (
                              <tr key={other.guid} className="mnt-dup-row">
                                <td>
                                  <span className="secondary-text">↳ {other.jobNumber || "—"}</span>
                                </td>
                                <td>
                                  <span className="secondary-text">
                                    {isMerged(other)
                                      ? `Merged into ${MERGED_NOTE.exec(other.managerNotes ?? "")?.[1] ?? "another issue"}`
                                      : "Same issue reported again"}
                                  </span>
                                </td>
                                <td>
                                  <span className="secondary-text">
                                    {other.roomName || other.roomReference || " "}
                                  </span>
                                </td>
                                <td>{formatDate(other.created)}</td>
                                <td>
                                  <span className={"status " + other.severity}>
                                    {other.severity}
                                  </span>
                                </td>
                                <td>
                                  <span className={"status " + statusText(other)}>
                                    {statusText(other)}
                                  </span>
                                </td>
                                <td>
                                  <button className="table-action" onClick={() => manage(other)}>
                                    Manage
                                  </button>
                                </td>
                              </tr>
                            ))
                          : []),
                      ];
                    })}
                    {visibleGroups.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <div className="empty-state">
                            <ClipboardList size={20} />
                            <h3>No maintenance issues found</h3>
                            <p>Try another search or property filter.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {issuesQuery.data && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "12px 15px",
                  borderTop: "1px solid #e5eaf0",
                  alignItems: "center",
                }}
              >
                <span className="panel-caption">
                  Page {issuesQuery.data.page} of{" "}
                  {Math.max(1, Math.ceil(issuesQuery.data.totalCount / PAGE_SIZE))}
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="button"
                    disabled={!issuesQuery.data.hasPreviousPage || issuesQuery.isFetching}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    <ArrowLeft size={13} /> Previous
                  </button>
                  <button
                    className="button"
                    disabled={!issuesQuery.data.hasNextPage || issuesQuery.isFetching}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {createOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCreateOpen(false);
          }}
        >
          <form className="modal" onSubmit={createIssue}>
            <div className="modal-head">
              <div>
                <h2>New COHO maintenance issue</h2>
                <div className="panel-caption">
                  Creates the issue directly in COHO.
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                onClick={() => setCreateOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                <div className="field full">
                  <label htmlFor="coho-property">Property</label>
                  <select
                    id="coho-property"
                    name="propertyReference"
                    required
                    value={newPropertyReference}
                    onChange={(event) =>
                      setNewPropertyReference(event.target.value)
                    }
                  >
                    <option value="" disabled>
                      Select a COHO property
                    </option>
                    {properties.map((property) => (
                      <option
                        key={property.reference ?? property.name}
                        value={property.reference ?? ""}
                        disabled={!property.reference}
                      >
                        {property.name || property.reference || "Unnamed property"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="coho-room">Room (optional)</label>
                  <select
                    // Remount once properties load so a prefilled room can be selected.
                    key={`${newPropertyReference}:${properties.length}`}
                    id="coho-room"
                    name="roomReference"
                    defaultValue={
                      newPropertyReference === prefill.property ? prefill.room : ""
                    }
                  >
                    <option value="">No specific room</option>
                    {(selectedProperty?.rooms ?? []).map((room) => (
                      <option
                        key={room.reference ?? room.name}
                        value={room.reference ?? ""}
                        disabled={!room.reference}
                      >
                        {room.name || room.reference || "Unnamed room"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="coho-severity">Severity</label>
                  <select id="coho-severity" name="severity" defaultValue="medium">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
                <div className="field full">
                  <label htmlFor="coho-title">Issue title</label>
                  <input
                    id="coho-title"
                    name="title"
                    required
                    maxLength={160}
                    placeholder="e.g. Boiler not heating"
                  />
                </div>
                <div className="field full">
                  <label htmlFor="coho-message">Request details</label>
                  <textarea
                    id="coho-message"
                    name="requestMessage"
                    rows={3}
                    maxLength={4000}
                  />
                </div>
                <div className="field">
                  <label htmlFor="coho-category">Category (optional)</label>
                  <select
                    id="coho-category"
                    name="maintenanceCategoryGuid"
                    defaultValue=""
                  >
                    <option value="">No category</option>
                    {categories.map((category) => (
                      <option key={category.guid} value={category.guid}>
                        {[category.hierarchy, category.name]
                          .filter(Boolean)
                          .join(" / ") || "Unnamed category"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="coho-create-notes">Manager notes</label>
                  <textarea
                    id="coho-create-notes"
                    name="managerNotes"
                    rows={2}
                    maxLength={2000}
                  />
                </div>
              </div>
              {formError && (
                <p className="status overdue" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={createMutation.isPending}
                >
                  <Plus size={14} />
                  {createMutation.isPending ? "Creating…" : "Create in COHO"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {mergeGroup && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMergeGroup(null);
          }}
        >
          <div className="modal">
            <div className="modal-head">
              <div>
                <h2>Merge duplicate issues</h2>
                <div className="panel-caption">
                  {mergeGroup.main.title || "Maintenance issue"} ·{" "}
                  {mergeGroup.main.propertyName || mergeGroup.main.propertyReference || "Property"}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                onClick={() => setMergeGroup(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              <p className="page-sub" style={{ marginTop: 0 }}>
                Choose the issue to keep. COHO can't delete issues, so each other
                one is marked complete in COHO with the note "Duplicate of …".
                The kept issue isn't changed.
              </p>
              <div className="mnt-merge-list" role="radiogroup" aria-label="Issue to keep">
                {[mergeGroup.main, ...mergeGroup.others]
                  .filter((issue) => !isMerged(issue))
                  .map((issue) => (
                    <label key={issue.guid} className={keepGuid === issue.guid ? "active" : ""}>
                      <input
                        type="radio"
                        name="keep"
                        value={issue.guid}
                        checked={keepGuid === issue.guid}
                        onChange={() => setKeepGuid(issue.guid)}
                      />
                      <strong>{issue.jobNumber || "—"}</strong>
                      <span className="secondary-text">
                        Reported {formatDate(issue.created)} · {statusText(issue)}
                      </span>
                      {keepGuid === issue.guid && <span className="status ready">Keep</span>}
                    </label>
                  ))}
              </div>
              {formError && (
                <p className="status overdue" role="alert">
                  {formError}
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="button" onClick={() => setMergeGroup(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={mergeMutation.isPending}
                  onClick={() => void mergeIssues()}
                >
                  <Merge size={14} />
                  {mergeMutation.isPending ? "Merging…" : "Merge in COHO"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <div className="modal">
            <div className="modal-head">
              <div>
                <h2>{selected.title || "Maintenance issue"}</h2>
                <div className="panel-caption">
                  {selected.jobNumber || selected.guid} ·{" "}
                  {selected.propertyName || selected.propertyReference || "Property"}
                  {selected.roomName ? ` · ${selected.roomName}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close"
                onClick={() => setSelected(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              <p className="page-sub" style={{ marginTop: 0 }}>
                {selected.requestMessage || "No request details provided."}
              </p>
              <form onSubmit={updateIssue}>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="edit-severity">Severity</label>
                    <select
                      id="edit-severity"
                      name="severity"
                      defaultValue={selected.severity}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="unknown">Unknown</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="edit-status">COHO status</label>
                    <input
                      id="edit-status"
                      value={statusText(selected)}
                      readOnly
                    />
                  </div>
                  <div className="field full">
                    <label htmlFor="edit-manager-notes">Manager notes</label>
                    <textarea
                      id="edit-manager-notes"
                      name="managerNotes"
                      defaultValue={selected.managerNotes || ""}
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                </div>
                {formError && (
                  <p className="status overdue" role="alert">
                    {formError}
                  </p>
                )}
                <div className="modal-actions">
                  <button type="button" className="button" onClick={() => setSelected(null)}>
                    Close
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={updateMutation.isPending}
                  >
                    <Check size={14} />
                    {updateMutation.isPending ? "Saving…" : "Save updates"}
                  </button>
                </div>
              </form>

              {!isClosed(selected) && (
                <form
                  onSubmit={completeIssue}
                  style={{
                    marginTop: 18,
                    paddingTop: 16,
                    borderTop: "1px solid #e5eaf0",
                  }}
                >
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="complete-decision">After completion</label>
                      <select
                        id="complete-decision"
                        name="awaitingDecision"
                        defaultValue="complete"
                      >
                        <option value="complete">Complete</option>
                        <option value="awaitingInvoice">Awaiting invoice</option>
                        <option value="awaitingOther">Awaiting other</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="completion-notes">Completion notes</label>
                      <input id="completion-notes" name="completionNotes" />
                    </div>
                  </div>
                  <div className="modal-actions">
                    <span className="panel-caption">
                      Marks the issue complete in COHO.
                    </span>
                    <button
                      type="submit"
                      className="button"
                      disabled={completeMutation.isPending}
                    >
                      <Check size={14} />
                      {completeMutation.isPending ? "Updating…" : "Complete issue"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}