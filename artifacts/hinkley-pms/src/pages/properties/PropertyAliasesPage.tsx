import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  getGetTrackingOptionsQueryKey,
  getListCompanyAliasesQueryKey,
  getListPropertyAliasesQueryKey,
  useCreateCompanyAlias,
  useDeleteCompanyAlias,
  useListCompanyAliases,
  useUpdateCompanyAlias,
  type CompanyAlias,
  useCreatePropertyAlias,
  useDeletePropertyAlias,
  useGetTrackingOptions,
  useListPropertyAliases,
  useUpdatePropertyAlias,
  type PropertyAlias,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "@/components/properties/ModalShell";
import { CompanyTag } from "@/pages/finance/InvoicesPage";
import { TargetSelect, splitTarget } from "@/pages/finance/BillCodingTab";
import "@/pages/finance/finance.css";

// Property aliases: how properties are written on supplier invoices ("51
// Bridgwater Rd", "51 A") and the Xero company and Property option each one
// means. Bill coding uses them to put each invoice line on the right property;
// answers given for held bills are kept here too ("Bill line answers").

type Kind = "text" | "line" | "company";
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function PropertyAliasesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const get = (key: string) => params.get(key) ?? "";
  const setParams = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
    navigate(`/property-aliases${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const kind: Kind = get("kind") === "line" ? "line" : get("kind") === "company" ? "company" : "text";
  const term = get("q");
  const company = get("company");

  const query = useListPropertyAliases({ query: { queryKey: getListPropertyAliasesQueryKey(), staleTime: 60_000 } });
  const options = useGetTrackingOptions({ query: { queryKey: getGetTrackingOptionsQueryKey(), staleTime: 10 * 60_000 } });
  const [editing, setEditing] = useState<PropertyAlias | "new" | null>(null);
  const [deleting, setDeleting] = useState<PropertyAlias | null>(null);
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); setTimeout(() => setToast(""), 3200); };

  const all = query.data?.items ?? [];
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return all.filter((item) =>
      item.kind === kind &&
      (!company || item.tenantId === company) &&
      (!needle || [item.alias, item.normalizedAlias, item.option, item.company, item.propertyName].some((value) => value?.toLowerCase().includes(needle))),
    );
  }, [all, kind, company, term]);
  const count = (k: Kind) => all.filter((item) => item.kind === k).length;
  const companyAliases = useListCompanyAliases({ query: { queryKey: getListCompanyAliasesQueryKey(), staleTime: 60_000 } });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · Property register</div>
          <h1 className="page-title">Property aliases</h1>
          <p className="page-sub">How properties are written on supplier invoices, and the Xero property each one means</p>
        </div>
        <div className="head-actions">
          {kind !== "company" && <button type="button" className="button primary" onClick={() => setEditing("new")} data-testid="button-add-alias"><Plus size={14} /> Add alias</button>}
        </div>
      </div>

      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Aliases could not be loaded: {errorText(query.error)}</p>}
      {options.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Xero's property list could not be loaded: {errorText(options.error)}</p>}

      <div className="hh-inv-tabs" role="tablist" aria-label="Kind of alias">
        <button type="button" role="tab" aria-selected={kind === "text"} className={kind === "text" ? "active" : ""} onClick={() => setParams({ kind: "" })}>Spellings <span>{count("text")}</span></button>
        <button type="button" role="tab" aria-selected={kind === "line"} className={kind === "line" ? "active" : ""} onClick={() => setParams({ kind: "line" })}>Bill line answers <span>{count("line")}</span></button>
        <button type="button" role="tab" aria-selected={kind === "company"} className={kind === "company" ? "active" : ""} onClick={() => setParams({ kind: "company" })}>Company names <span>{companyAliases.data?.items.length ?? 0}</span></button>
      </div>

      {kind === "company" ? <CompanyAliases query={companyAliases} companies={options.data?.companies ?? FALLBACK_COMPANIES} term={term} company={company} flash={flash} /> : (<>

      <div className="hh-fin-filters inset">
        <label className="hh-fin-search">
          <Search size={14} />
          <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Search alias, property or company" aria-label="Search aliases" />
          {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear search"><X size={13} /></button>}
        </label>
        <label className="hh-fin-field">
          <span>Company</span>
          <select className="select-control" value={company} onChange={(event) => setParams({ company: event.target.value })}>
            <option value="">All companies</option>
            {(options.data?.companies ?? FALLBACK_COMPANIES).map((item) => <option key={item.tenantId} value={item.tenantId}>{item.name}</option>)}
          </select>
        </label>
      </div>

      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-fin-table">
            <thead><tr><th>{kind === "text" ? "Written on invoices as" : "Bill line"}</th><th>Means</th><th>Added</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {query.isLoading && <tr><td colSpan={4}><div className="empty-state"><p>Loading aliases…</p></div></td></tr>}
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.alias}</strong>
                    {kind === "text" && <small className="hh-fin-sub">Matches the words: {item.normalizedAlias}</small>}
                  </td>
                  <td>
                    {item.tenantId && item.company ? (
                      <>
                        <span className="hh-inv-head"><strong>{item.overhead ? "No property (company cost)" : item.option}</strong><CompanyTag tenantId={item.tenantId} name={item.company} /></span>
                      </>
                    ) : item.propertyName ? <span>{item.propertyName} <small className="hh-fin-sub">Property register</small></span> : <span className="hh-fin-sub warn">No target</span>}
                  </td>
                  <td className="hh-nowrap">{when(item.updatedAt)}{item.createdBy && <small className="hh-fin-sub">{item.createdBy}</small>}</td>
                  <td className="hh-inv-actions">
                    <button type="button" className="icon-btn" onClick={() => setEditing(item)} title="Edit" aria-label={`Edit ${item.alias}`}><Pencil size={15} /></button>
                    <button type="button" className="icon-btn" onClick={() => setDeleting(item)} title="Delete" aria-label={`Delete ${item.alias}`}><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
              {!query.isLoading && !visible.length && (
                <tr><td colSpan={4}><div className="empty-state"><h3>No aliases here</h3><p>{kind === "text" ? "Add how a property is written on invoices, for example \"51 Bridgwater Rd\"." : "Answers given for held bills on Finance checks > Bill coding appear here."}</p></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hh-fin-foot">
        Matching ignores capitals, punctuation and words like Road or Street, and reads "Rd" as Road. The longest alias found in an invoice line wins.
        A property name that matches exactly a Property option in Xero doesn't need an alias.
      </p>
      </>)}

      {editing && <AliasModal alias={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={(message) => { setEditing(null); flash(message); }} />}
      {deleting && <DeleteModal alias={deleting} onClose={() => setDeleting(null)} onDone={(message) => { setDeleting(null); flash(message); }} />}
      {toast && <div className="toast-msg" role="status">{toast}</div>}
    </>
  );
}

function AliasModal({ alias, onClose, onDone }: { alias: PropertyAlias | null; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const options = useGetTrackingOptions({ query: { queryKey: getGetTrackingOptionsQueryKey(), staleTime: 10 * 60_000 } });
  const [text, setText] = useState(alias?.alias ?? "");
  const [target, setTarget] = useState(alias?.tenantId ? `${alias.tenantId}|${alias.overhead ? "__overhead__" : alias.option ?? ""}` : "");
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: getListPropertyAliasesQueryKey() });
    onDone(message);
  };
  const create = useCreatePropertyAlias({ mutation: { onSuccess: (saved) => done(`Alias "${saved.alias}" added.`) } });
  const update = useUpdatePropertyAlias({ mutation: { onSuccess: (saved) => done(`Alias "${saved.alias}" saved.`) } });
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const line = alias?.kind === "line";
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const data = { alias: text.trim(), ...splitTarget(target) };
    if (alias) update.mutate({ id: alias.id, data });
    else create.mutate({ data });
  };
  return (
    <ModalShell
      title={alias ? (line ? "Change bill line answer" : "Edit alias") : "Add alias"}
      caption={line ? alias?.alias : "How a property is written on supplier invoices"}
      onClose={onClose}
      onSubmit={submit}
      testId="modal-property-alias"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={pending || !target || (!line && !text.trim())}>{pending ? "Saving…" : "Save"}</button>
      </>}
    >
      <div className="form-grid">
        {!line && (
          <label className="field full">
            Written on invoices as
            <input value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder="e.g. 51 Bridgwater Rd" required autoFocus />
          </label>
        )}
        <label className="field full">
          Means
          <TargetSelect value={target} onChange={setTarget} options={options.data} required />
        </label>
      </div>
      {options.data?.problems.map((problem) => <p key={problem} className="hh-fin-sub warn">{problem}</p>)}
      {error && <p className="hh-field-error" role="alert">{errorText(error)}</p>}
      <p className="hh-fin-foot">Bills held for this spelling are checked again on the next hourly run. Changes are written to the audit log.</p>
    </ModalShell>
  );
}

function DeleteModal({ alias, onClose, onDone }: { alias: PropertyAlias; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const mutation = useDeletePropertyAlias({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListPropertyAliasesQueryKey() });
        onDone(`Alias "${alias.alias}" deleted.`);
      },
    },
  });
  return (
    <ModalShell
      title="Delete alias?"
      caption={alias.alias}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate({ id: alias.id }); }}
      testId="modal-delete-alias"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button danger" disabled={mutation.isPending}>{mutation.isPending ? "Deleting…" : "Delete"}</button>
      </>}
    >
      <p>
        {alias.kind === "line"
          ? "The bill line this answers will be held again the next time its bill is checked."
          : `Invoices that say "${alias.alias}" will no longer be matched to ${alias.overhead ? "a company cost" : alias.option ?? "this property"} automatically.`}
      </p>
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
    </ModalShell>
  );
}

// --- Company names --------------------------------------------------------------------

// Used when Xero's property list can't be loaded, so companies can still be chosen.
const FALLBACK_COMPANIES = [
  { tenantId: "47f65b32-d0d7-4417-bb5c-89ff2d93651e", name: "Hinkley Homes Lettings", options: [] as string[] },
  { tenantId: "3ae8a283-c7e0-4287-9bcd-4c2561295890", name: "Hinkley Homes Holdings", options: [] as string[] },
  { tenantId: "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef", name: "Hinkley Homes Ltd", options: [] as string[] },
  { tenantId: "0a290129-b001-4bfb-903d-d27a8ac55738", name: "Hinkley Homes Management", options: [] as string[] },
  { tenantId: "4c807578-e0a7-49ad-9644-8e705aec0c2a", name: "Hinkley Homes Stays", options: [] as string[] },
];
type CompanyChoice = { tenantId: string; name: string };

function CompanyAliases({ query, companies, term, company, flash }: { query: { data?: { items: CompanyAlias[] }; isError: boolean; isLoading: boolean; error: unknown }; companies: CompanyChoice[]; term: string; company: string; flash: (message: string) => void }) {
  const [editing, setEditing] = useState<CompanyAlias | "new" | null>(null);
  const [deleting, setDeleting] = useState<CompanyAlias | null>(null);
  const needle = term.trim().toLowerCase();
  const visible = (query.data?.items ?? []).filter((item) => (!company || item.tenantId === company) && (!needle || [item.alias, item.company, item.notes].some((value) => value?.toLowerCase().includes(needle))));
  return (
    <>
      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Company names could not be loaded: {errorText(query.error)}</p>}
      <div className="hh-chk-banner">
        <p className="hh-fin-foot">Who supplier invoices are addressed to. The five companies' own names are always recognised; add other spellings and trading names here.</p>
        <button type="button" className="button primary" onClick={() => setEditing("new")}><Plus size={14} /> Add company name</button>
      </div>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-fin-table">
            <thead><tr><th>Written on invoices as</th><th>Means</th><th>Notes</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.alias}</strong><small className="hh-fin-sub">Matches the words: {item.normalizedAlias}</small></td>
                  <td>{item.company ? <CompanyTag tenantId={item.tenantId} name={item.company} /> : <span className="hh-fin-sub warn">Unknown company</span>}</td>
                  <td className="hh-chk-summary">{item.notes ?? "—"}</td>
                  <td className="hh-inv-actions">
                    <button type="button" className="icon-btn" onClick={() => setEditing(item)} title="Edit" aria-label={`Edit ${item.alias}`}><Pencil size={15} /></button>
                    <button type="button" className="icon-btn" onClick={() => setDeleting(item)} title="Delete" aria-label={`Delete ${item.alias}`}><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
              {!query.isLoading && !visible.length && <tr><td colSpan={4}><div className="empty-state"><h3>No company names</h3><p>Add how a company is written on invoices, for example "EDJ Investments Ltd".</p></div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <p className="hh-fin-foot">An invoice addressed to a different company from the one its bill sits in is noted on the bill (Finance checks &gt; Bill coding). Ltd, Limited and capitals are ignored.</p>
      {editing && <CompanyAliasModal alias={editing === "new" ? null : editing} companies={companies} onClose={() => setEditing(null)} onDone={(message) => { setEditing(null); flash(message); }} />}
      {deleting && <DeleteCompanyAliasModal alias={deleting} onClose={() => setDeleting(null)} onDone={(message) => { setDeleting(null); flash(message); }} />}
    </>
  );
}

function CompanyAliasModal({ alias, companies, onClose, onDone }: { alias: CompanyAlias | null; companies: CompanyChoice[]; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(alias?.alias ?? "");
  const [tenantId, setTenantId] = useState(alias?.tenantId ?? "");
  const [notes, setNotes] = useState(alias?.notes ?? "");
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: getListCompanyAliasesQueryKey() });
    onDone(message);
  };
  const create = useCreateCompanyAlias({ mutation: { onSuccess: (saved) => done(`Company name "${saved.alias}" added.`) } });
  const update = useUpdateCompanyAlias({ mutation: { onSuccess: (saved) => done(`Company name "${saved.alias}" saved.`) } });
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const data = { alias: text.trim(), tenantId, notes: notes.trim() || null };
    if (alias) update.mutate({ id: alias.id, data });
    else create.mutate({ data });
  };
  return (
    <ModalShell
      title={alias ? "Edit company name" : "Add company name"}
      caption="How a company is written on supplier invoices"
      onClose={onClose}
      onSubmit={submit}
      testId="modal-company-alias"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={pending || !tenantId || !text.trim()}>{pending ? "Saving…" : "Save"}</button>
      </>}
    >
      <div className="form-grid">
        <label className="field full">
          Written on invoices as
          <input value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder="e.g. EDJ Investments Ltd" required autoFocus />
        </label>
        <label className="field full">
          Means the Xero company
          <select className="select-control" value={tenantId} onChange={(event) => setTenantId(event.target.value)} required>
            <option value="">Choose a company…</option>
            {companies.map((item) => <option key={item.tenantId} value={item.tenantId}>{item.name}</option>)}
          </select>
        </label>
        <label className="field full">
          Notes
          <input value={notes} maxLength={500} onChange={(event) => setNotes(event.target.value)} placeholder="e.g. Common misspelling on supplier invoices" />
        </label>
      </div>
      {error && <p className="hh-field-error" role="alert">{errorText(error)}</p>}
      <p className="hh-fin-foot">Changes are written to the audit log.</p>
    </ModalShell>
  );
}

function DeleteCompanyAliasModal({ alias, onClose, onDone }: { alias: CompanyAlias; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const mutation = useDeleteCompanyAlias({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListCompanyAliasesQueryKey() });
        onDone(`Company name "${alias.alias}" deleted.`);
      },
    },
  });
  return (
    <ModalShell
      title="Delete company name?"
      caption={alias.alias}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); mutation.mutate({ id: alias.id }); }}
      testId="modal-delete-company-alias"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button danger" disabled={mutation.isPending}>{mutation.isPending ? "Deleting…" : "Delete"}</button>
      </>}
    >
      <p>Invoices addressed to "{alias.alias}" will no longer be recognised as {alias.company ?? "this company"}.</p>
      {mutation.isError && <p className="hh-field-error" role="alert">{errorText(mutation.error)}</p>}
    </ModalShell>
  );
}
