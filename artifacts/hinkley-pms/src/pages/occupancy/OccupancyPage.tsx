import { useMemo, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle, ArrowLeftRight, BedDouble, DoorOpen, Download, Search, Users, X } from "lucide-react";
import { getGetOccupancyQueryKey, useGetOccupancy, useGetPerformance, useGetStayAvailability } from "@workspace/api-client-react";
import { performanceQuery } from "@/pages/performance/PerformancePage";
import { availabilityQueryOptions } from "@/pages/stays/StaysPage";
import { errorText } from "@/components/action-modals";
import { downloadText, formatDate } from "@/services/properties";
import {
  STATUS_TILES,
  STATUS_TONE,
  groupByProperty,
  matchesStatus,
  occupancyCsv,
  rentText,
  statusText,
  unitLabel,
  type StatusFilter,
} from "@/services/occupancy";
import "./occupancy.css";

const STATUS_KEYS = new Set<string>(["all", ...STATUS_TILES.map((tile) => tile.key)]);

export default function OccupancyPage({ selectedPropertyReference }: { selectedPropertyReference?: string }) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const term = params.get("q") ?? "";
  const status = (STATUS_KEYS.has(params.get("status") ?? "") ? params.get("status") : "all") as StatusFilter;
  const setParams = (change: { q?: string; status?: StatusFilter }) => {
    const next = new URLSearchParams();
    const q = change.q ?? term;
    const s = change.status ?? status;
    if (q) next.set("q", q);
    if (s !== "all") next.set("status", s);
    navigate(`/occupancy${next.size ? `?${next}` : ""}`, { replace: true });
  };

  const query = useGetOccupancy({ query: { queryKey: getGetOccupancyQueryKey(), refetchInterval: 5 * 60_000 } });
  const data = query.data;
  // Property filters (global selector and search) set the tile counts; the status tile then narrows the table.
  const inScope = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return (data?.rows ?? []).filter((row) =>
      (!selectedPropertyReference || row.propertyReference === selectedPropertyReference) &&
      (!needle || [row.propertyName, row.unitName, ...row.tenants.map((tenant) => tenant.name), row.tenancyNumber ?? ""].some((value) => value.toLowerCase().includes(needle))),
    );
  }, [data, term, selectedPropertyReference]);
  const visible = useMemo(() => inScope.filter((row) => matchesStatus(row, status)), [inScope, status]);
  const groups = useMemo(() => groupByProperty(visible), [visible]);

  const units = new Set(inScope.map((row) => `${row.propertyReference}/${row.unitReference}`)).size;
  const occupants = inScope.filter((row) => matchesStatus(row, "occupied")).reduce((sum, row) => sum + row.tenants.length, 0);
  const changes = inScope.filter((row) => row.status === "ending" || row.status === "future").length;
  const countFor = (key: StatusFilter) => inScope.filter((row) => matchesStatus(row, key)).length;

  const exportCsv = () => {
    downloadText(`hinkley-occupancy-${data?.asOf ?? "export"}.csv`, occupancyCsv(visible));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · COHO</div>
          <h1 className="page-title">Occupancy</h1>
          <p className="page-sub">
            Current and upcoming tenancies for every unit{data ? ` · as of ${formatDate(data.asOf)}` : ""}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="button" onClick={exportCsv} disabled={!visible.length} data-testid="button-occupancy-export"><Download size={14} /> Export (CSV)</button>
        </div>
      </div>

      <div className="hh-occ-filter">
        <div className="hh-search">
          <Search size={14} />
          <input value={term} onChange={(event) => setParams({ q: event.target.value })} placeholder="Filter by property, unit, tenant or tenancy number" aria-label="Filter occupancy" data-testid="input-occupancy-search" />
          {term && <button type="button" className="icon-btn" onClick={() => setParams({ q: "" })} aria-label="Clear filter"><X size={13} /></button>}
        </div>
      </div>

      {query.isError && <p className="hh-props-alert" role="alert"><AlertTriangle size={14} /> Occupancy could not be loaded from COHO: {errorText(query.error)}</p>}

      <div className="hh-occ-summary">
        <div className="hh-occ-sum"><DoorOpen size={17} /><strong>{data ? units : "…"}</strong> {units === 1 ? "unit" : "units"}</div>
        <div className="hh-occ-sum good"><Users size={17} /><strong>{data ? occupants : "…"}</strong> {occupants === 1 ? "occupant" : "occupants"}</div>
        <div className={`hh-occ-sum ${changes ? "warn" : ""}`}><ArrowLeftRight size={17} /><strong>{data ? changes || "No" : "…"}</strong> tenancy {changes === 1 ? "change" : "changes"}</div>
      </div>

      <div className="hh-occ-tiles" role="group" aria-label="Filter by tenancy status">
        {STATUS_TILES.map((tile) => {
          const active = status === tile.key;
          return (
            <button
              key={tile.key}
              type="button"
              className={`hh-occ-tile ${tile.tone} ${active ? "active" : ""}`}
              aria-pressed={active}
              onClick={() => setParams({ status: active ? "all" : tile.key })}
              title={tile.key === "becoming_periodic" && data ? `Fixed term ends within ${data.becomingPeriodicDays} days` : undefined}
              data-testid={`tile-occupancy-${tile.key}`}
            >
              <strong>{data ? countFor(tile.key) : "…"}</strong>
              <span>{tile.label}</span>
            </button>
          );
        })}
      </div>

      <ul className="hh-occ-legend" aria-label="Tenant bullet colours">
        <li><i className="joined" aria-hidden="true" /> Using the COHO tenant app</li>
        <li><i aria-hidden="true" /> Not using the app yet (invited or not invited)</li>
      </ul>

      <section className="panel table-panel">
        <div className="table-wrap">
          <table className="hh-occ-table">
            <thead>
              <tr><th>Property / Unit</th><th>Tenant</th><th>Rent</th><th>Start</th><th>Fixed term</th><th>Available</th><th>Status</th></tr>
            </thead>
            {query.isLoading ? (
              <tbody><tr><td colSpan={7}><div className="empty-state"><h3>Loading occupancy from COHO…</h3></div></td></tr></tbody>
            ) : !groups.length ? (
              <tbody><tr><td colSpan={7}><div className="empty-state"><h3>No units match</h3><p>Try another status or clear the filter.</p></div></td></tr></tbody>
            ) : groups.map((group) => (
              <tbody key={group.reference}>
                <tr className="hh-occ-group"><th colSpan={7} scope="colgroup"><Link href={`/properties/${encodeURIComponent(group.reference)}`}>{group.name}</Link></th></tr>
                {group.rows.map((row) => (
                  <tr key={row.tenancyGuid ?? `${row.unitReference}-vacant`} data-testid={`row-occupancy-${row.tenancyGuid ?? row.unitReference}`}>
                    <td>{unitLabel(row)}</td>
                    <td className="hh-occ-tenants">
                      {row.tenants.length ? (
                        <>
                          {row.tenants.map((tenant) => (
                            <span key={tenant.name} className="hh-occ-tenant">
                              <i className={tenant.cohoAccount === "joined" ? "joined" : ""} title={tenant.cohoAccount === "joined" ? "Using the COHO app" : `COHO app: ${tenant.cohoAccount ?? "not invited"}`} />
                              {tenant.name}
                            </span>
                          ))}
                          {row.tenancyNumber && <small>{row.tenancyNumber}</small>}
                        </>
                      ) : <span className="secondary-text">—</span>}
                    </td>
                    <td className="hh-nowrap">{rentText(row)}</td>
                    <td className="hh-nowrap">{row.startDate ? formatDate(row.startDate) : "—"}</td>
                    <td className="hh-nowrap">{row.fixedTermEnd ? formatDate(row.fixedTermEnd) : "—"}</td>
                    <td className="hh-nowrap">{row.availableFrom ? formatDate(row.availableFrom) : "—"}</td>
                    <td><span className={`status ${STATUS_TONE[row.status]}`}>{statusText(row)}</span></td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </section>
    </>
  );
}

// Overview card: HMO rooms let today (COHO, via Performance) and Stays apartments
// booked tonight (Smoobu availability; blocked nights count as taken).
export function OccupancyCard({ propertyReference }: { propertyReference?: string }) {
  const { params, options } = performanceQuery(propertyReference);
  const performance = useGetPerformance(params, options);
  const stays = useGetStayAvailability(undefined, availabilityQueryOptions);
  const data = performance.data;
  const tonight = stays.data?.dates[0];
  const apartments = (stays.data?.apartments ?? []).filter((apartment) => !propertyReference || apartment.cohoPropertyReference === propertyReference);
  const freeTonight = apartments.filter((apartment) => apartment.nights.find((night) => night.date === tonight)?.available).length;
  const bookedTonight = apartments.length - freeTonight;
  return (
    <section className="panel" aria-label="Occupancy">
      <div className="panel-head">
        <div><div className="panel-title">Occupancy</div><div className="panel-caption">{propertyReference ? "Selected property" : "All properties"} · rooms from COHO, Stays from Smoobu</div></div>
        <Link href="/occupancy">Occupancy →</Link>
      </div>
      <div className="hh-occ-card">
        <OccupancyRow
          title="HMO rooms let today" icon={<DoorOpen size={13} />}
          state={performance.isLoading ? "Loading from COHO…" : !data ? "Occupancy could not be loaded from COHO." : data.units === 0 ? "No rooms in COHO for this property." : null}
          taken={data?.occupiedToday ?? 0} total={data?.units ?? 0} unit="room"
          takenLink={{ href: "/occupancy?status=occupied", label: "Let" }} freeLink={{ href: "/occupancy?status=vacant", label: "Vacant" }}
        />
        <OccupancyRow
          title="Stays apartments booked tonight" icon={<BedDouble size={13} />}
          state={stays.isLoading ? "Loading from Smoobu…" : stays.isError ? `Smoobu availability could not be loaded: ${errorText(stays.error)}` : apartments.length === 0 ? (propertyReference ? "No Stays apartments are linked to this property." : "No Stays apartments in Smoobu.") : null}
          taken={bookedTonight} total={apartments.length} unit="apartment"
          takenLink={{ href: "/stays", label: "Booked" }} freeLink={{ href: "/stays", label: "Free" }}
        />
      </div>
    </section>
  );
}

function OccupancyRow({ title, icon, state, taken, total, unit, takenLink, freeLink }: { title: string; icon: ReactNode; state: string | null; taken: number; total: number; unit: string; takenLink: { href: string; label: string }; freeLink: { href: string; label: string } }) {
  const percent = total ? (taken / total) * 100 : 0;
  return (
    <div className="hh-occ-card-row">
      <div className="hh-occ-card-top">
        <div><span>{icon} {title}</span><strong>{state ? "—" : `${percent.toFixed(1)}%`}</strong></div>
        {!state && <div className="right"><span>Capacity</span><strong>{total} {total === 1 ? unit : `${unit}s`}</strong></div>}
      </div>
      {state ? <p className="hh-fin-note">{state}</p> : (
        <>
          <div className="hh-meter-bar" role="img" aria-label={`${taken} of ${total} ${unit}s taken`}><span style={{ width: `${percent}%`, background: "#3aa889" }} /></div>
          <div className="hh-occ-card-split">
            <Link href={takenLink.href}><span>{takenLink.label}</span><strong>{taken}</strong></Link>
            <Link href={freeLink.href}><span>{freeLink.label}</span><strong className={total - taken ? "warn" : ""}>{total - taken}</strong></Link>
          </div>
        </>
      )}
    </div>
  );
}
