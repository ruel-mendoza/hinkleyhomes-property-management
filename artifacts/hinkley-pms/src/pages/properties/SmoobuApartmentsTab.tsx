import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { BedDouble, ExternalLink, PlugZap, RefreshCw, Wand2 } from "lucide-react";
import {
  getGetStaysQueryKey,
  getListStayApartmentsQueryKey,
  useAutoLinkStayApartments,
  useLinkStayApartment,
  useSyncStays,
  type PropertySummary,
  type StayApartment,
  type StayApartmentList,
} from "@workspace/api-client-react";
import { errorText } from "@/components/action-modals";
import { formatDate } from "@/services/properties";

// Smoobu apartments (Hinkley Homes Stays) beside the COHO properties. Staff link
// each apartment to the property it is in; that link lives only in this app.
// Smoobu itself is never changed. Every sync links clear matches by name or
// address and postcode; staff link the rest or correct them here.

type Query = { data?: StayApartmentList; isLoading: boolean; isError: boolean; error: unknown };

const linkValue = (apartment: StayApartment) =>
  apartment.cohoReference ? `coho:${apartment.cohoReference}` : apartment.propertyId ? `register:${apartment.propertyId}` : "";
const propertyHref = (apartment: StayApartment) => {
  const id = apartment.cohoReference ?? apartment.propertyId;
  return id ? `/properties/${encodeURIComponent(id)}` : null;
};
const byName = (a: PropertySummary, b: PropertySummary) => a.name.localeCompare(b.name, "en-GB", { numeric: true });

export function SmoobuApartmentsTab({ query, properties, onToast }: { query: Query; properties: PropertySummary[]; onToast: (message: string) => void }) {
  const queryClient = useQueryClient();
  const sync = useSyncStays();
  const link = useLinkStayApartment();
  const autoLink = useAutoLinkStayApartments();
  const [saving, setSaving] = useState<number | null>(null);
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);

  const coho = useMemo(() => properties.filter((property) => property.source === "coho").sort(byName), [properties]);
  const register = useMemo(() => properties.filter((property) => property.source === "register" && !property.deactivated).sort(byName), [properties]);
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const property of properties) names.set(`${property.source === "coho" ? "coho" : "register"}:${property.id}`, property.name);
    return names;
  }, [properties]);

  const items = query.data?.items ?? [];
  const linked = items.filter((apartment) => linkValue(apartment)).length;
  const visible = onlyUnlinked ? items.filter((apartment) => !linkValue(apartment)) : items;

  const runSync = async () => {
    try {
      const result = await sync.mutateAsync();
      await Promise.all([queryClient.invalidateQueries({ queryKey: getListStayApartmentsQueryKey() }), queryClient.invalidateQueries({ queryKey: getGetStaysQueryKey() })]);
      onToast(result.status === "skipped" ? "A sync was already running." : `Read ${result.apartments} ${result.apartments === 1 ? "apartment" : "apartments"} from Smoobu.`);
    } catch (error) {
      onToast(`Sync failed: ${errorText(error)}`);
    }
  };

  const runAutoLink = async () => {
    try {
      const result = await autoLink.mutateAsync();
      await Promise.all([queryClient.invalidateQueries({ queryKey: getListStayApartmentsQueryKey() }), queryClient.invalidateQueries({ queryKey: getGetStaysQueryKey() })]);
      onToast(result.error ? `Couldn't match apartments: ${result.error}`
        : `Linked ${result.linked} ${result.linked === 1 ? "apartment" : "apartments"}.${result.notMatched ? ` ${result.notMatched} still need linking by hand.` : ""}`);
    } catch (error) {
      onToast(`Couldn't match apartments: ${errorText(error)}`);
    }
  };

  const choose = async (apartment: StayApartment, value: string) => {
    const [kind, ...rest] = value.split(":");
    const id = rest.join(":");
    setSaving(apartment.smoobuApartmentId);
    try {
      const saved = await link.mutateAsync({
        apartmentId: apartment.smoobuApartmentId,
        data: { cohoReference: kind === "coho" ? id : null, propertyId: kind === "register" ? id : null },
      });
      queryClient.setQueryData<StayApartmentList>(getListStayApartmentsQueryKey(), (old) => old && { ...old, items: old.items.map((item) => (item.smoobuApartmentId === saved.smoobuApartmentId ? saved : item)) });
      void queryClient.invalidateQueries({ queryKey: getGetStaysQueryKey() });
      onToast(value ? `${apartment.name} linked to ${nameOf.get(value) ?? id}.` : `${apartment.name} unlinked.`);
    } catch (error) {
      onToast(`Couldn't save the link: ${errorText(error)}`);
    } finally {
      setSaving(null);
    }
  };

  if (query.isLoading) return <section className="panel hh-apt-note">Loading Smoobu apartments…</section>;
  if (query.isError) return <section className="panel"><div className="empty-state"><PlugZap size={21} /><h3>Smoobu isn't connected</h3><p>{errorText(query.error)}</p></div></section>;

  return (
    <section className="panel table-panel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Smoobu apartments</div>
          <div className="panel-caption">
            {items.length ? `${linked} of ${items.length} linked to a property. ` : ""}Link each apartment to the property it's in, so its stays and cleaning allowances sit with that property.
          </div>
        </div>
        <div className="hh-apt-actions">
          {items.length > 0 && linked < items.length && (
            <label className="hh-apt-filter"><input type="checkbox" checked={onlyUnlinked} onChange={(event) => setOnlyUnlinked(event.target.checked)} /> Not linked only</label>
          )}
          {linked < items.length && (
            <button type="button" className="button" onClick={() => void runAutoLink()} disabled={autoLink.isPending} title="Link apartments whose name or address and postcode match one COHO or register property" data-testid="button-auto-link">
              <Wand2 size={14} /> {autoLink.isPending ? "Matching…" : "Link automatically"}
            </button>
          )}
          <button type="button" className="button" onClick={() => void runSync()} disabled={sync.isPending} data-testid="button-sync-apartments">
            <RefreshCw size={14} className={sync.isPending ? "spin" : ""} /> {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
          <Link href="/stays" className="button">Open stays</Link>
        </div>
      </div>
      <div className="table-wrap">
        <table className="hh-apt-table">
          <thead><tr><th>Apartment</th><th>Size</th><th>Tonight</th><th>Property</th></tr></thead>
          <tbody>
            {visible.map((apartment) => {
              const value = linkValue(apartment);
              const href = propertyHref(apartment);
              const size = [apartment.bedrooms !== null ? `${apartment.bedrooms} ${apartment.bedrooms === 1 ? "bedroom" : "bedrooms"}` : null, apartment.maxOccupancy !== null ? `sleeps ${apartment.maxOccupancy}` : null].filter(Boolean).join(" · ");
              return (
                <tr key={apartment.smoobuApartmentId}>
                  <td><strong>{apartment.name}</strong>{apartment.address && <small className="hh-apt-sub">{apartment.address}</small>}</td>
                  <td>{size || "—"}</td>
                  <td>
                    {apartment.inHouse ? <span className="status occupied">In house</span>
                      : apartment.nextArrival ? <>Empty<small className="hh-apt-sub">Next arrival {formatDate(apartment.nextArrival)}</small></>
                        : <span className="secondary-text">No arrivals booked</span>}
                  </td>
                  <td>
                    <div className="hh-apt-link">
                      <select
                        className={value ? "" : "unlinked"}
                        value={value}
                        disabled={saving === apartment.smoobuApartmentId}
                        onChange={(event) => void choose(apartment, event.target.value)}
                        aria-label={`Property for ${apartment.name}`}
                      >
                        <option value="">Not linked</option>
                        {value && !nameOf.has(value) && <option value={value}>{apartment.cohoReference ?? "Linked property"}</option>}
                        {coho.length > 0 && <optgroup label="COHO properties">{coho.map((property) => <option key={property.id} value={`coho:${property.id}`}>{property.name}</option>)}</optgroup>}
                        {register.length > 0 && <optgroup label="Register only">{register.map((property) => <option key={property.id} value={`register:${property.id}`}>{property.name}</option>)}</optgroup>}
                      </select>
                      {href && <Link href={href} className="icon-btn" aria-label="Open property" title="Open property"><ExternalLink size={13} /></Link>}
                    </div>
                    {apartment.linkedBy === "auto" && value && <small className="hh-apt-sub">Matched automatically</small>}
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr><td colSpan={4}><div className="empty-state"><BedDouble size={21} />
                {items.length ? <h3>Every apartment is linked</h3>
                  : <><h3>No Smoobu apartments yet</h3><p>{query.data?.lastSync ? "Smoobu has no apartments." : "Press Sync now to read the apartments from Smoobu."}</p></>}
              </div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
