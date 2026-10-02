import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  Plus,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import {
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
  useUpdateCohoMaintenance,
} from "@workspace/api-client-react";

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

function isClosed(issue: CohoMaintenance): boolean {
  return /complete|closed/i.test(issue.publicStatus);
}

export default function CohoMaintenancePage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [propertyReference, setPropertyReference] = useState("");
  const [newPropertyReference, setNewPropertyReference] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<CohoMaintenance | null>(null);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  const statusQuery = useGetCohoStatus();
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
    }),
    [page, propertyReference],
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

  const properties = propertiesQuery.data?.items ?? [];
  const selectedProperty = properties.find(
    (property) => property.reference === newPropertyReference,
  );
  const categories = categoriesQuery.data?.items ?? [];
  const allIssues = issuesQuery.data?.items ?? [];
  const visibleIssues = allIssues.filter((issue) =>
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
      .includes(search.toLowerCase()),
  );

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
              <div className="metric-value">{allIssues.length}</div>
              <div className="metric-foot">Page {issuesQuery.data?.page ?? page}</div>
            </div>
            <div className="panel metric">
              <div className="metric-top">Open on this page</div>
              <div className="metric-value">
                {allIssues.filter((issue) => !isClosed(issue)).length}
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
                    {visibleIssues.map((issue) => (
                      <tr key={issue.guid}>
                        <td>
                          <strong>{issue.jobNumber || "—"}</strong>
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
                          <span className={"status " + issue.publicStatus}>
                            {issue.publicStatus}
                          </span>
                        </td>
                        <td>
                          <button
                            className="table-action"
                            onClick={() => {
                              setNotice("");
                              setFormError("");
                              setSelected(issue);
                            }}
                          >
                            Manage
                          </button>
                        </td>
                      </tr>
                    ))}
                    {visibleIssues.length === 0 && (
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
                    key={newPropertyReference}
                    id="coho-room"
                    name="roomReference"
                    defaultValue=""
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
                      value={selected.publicStatus}
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