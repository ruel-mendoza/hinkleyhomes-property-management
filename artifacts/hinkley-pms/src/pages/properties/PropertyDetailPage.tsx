import { AlertTriangle, ArrowLeft, Briefcase, House } from "lucide-react";
import { Link } from "wouter";
import {
  getGetOccupancyQueryKey,
  getGetPropertyDetailsQueryKey,
  getListPropertiesQueryKey,
  useGetOccupancy,
  useGetPropertyDetails,
  useListProperties,
  type ComplianceRecord,
  type PropertyCompliance,
  type PropertyDetails,
} from "@workspace/api-client-react";
import { complianceTone, formatDate, formatMoney, humanize, locationLine, occupancy, statusLabel } from "@/services/properties";
import { rentText, statusText, STATUS_TONE } from "@/services/occupancy";
import { ComplianceBar } from "@/components/properties/ComplianceBar";
import { actionsPath } from "@/components/properties/PropertyCard";
import "./properties.css";

const RENTAL_TYPE = { room: "Let by the room", whole_property: "Whole property" } as const;
const RECORD_GROUPS: [ComplianceRecord["group"], string][] = [
  ["certificates", "Certificates"],
  ["fire_safety", "Fire safety"],
  ["health_and_safety", "Health & safety"],
  ["inspections", "Inspections"],
];
const RECORD_STATUS: Record<ComplianceRecord["status"], [string, string]> = {
  expired: ["Expired", "overdue"],
  missing: ["No record", "overdue"],
  expiring_soon: ["Expiring soon", "pending"],
  valid: ["In date", "completed"],
  not_required: ["Not required", "na"],
};
const STATUS_ORDER = ["expired", "missing", "expiring_soon", "valid", "not_required"];
const BILLS = { included: "Included", notIncluded: "Not included", partiallyIncluded: "Partly included", notApplicable: "Not applicable" } as Record<string, string>;
const yesNo = (value: boolean | null) => (value === null ? "Not set" : value ? "Yes" : "No");

type Fact = [string, string];
const Facts = ({ items }: { items: Fact[] }) => (
  <dl className="hh-act-facts">
    {items.map(([label, value]) => <div key={label} className={label === "Address" ? "wide" : ""}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>
);

export default function PropertyDetailPage({ id }: { id: string }) {
  const listQuery = useListProperties({ query: { queryKey: getListPropertiesQueryKey() } });
  const property = listQuery.data?.items.find((item) => item.id === id);
  const reference = property?.source === "coho" ? property.cohoReference ?? "" : "";
  const detailsQuery = useGetPropertyDetails(reference, {
    query: { queryKey: getGetPropertyDetailsQueryKey(reference), enabled: Boolean(reference), staleTime: 5 * 60_000 },
  });

  if (listQuery.isLoading) return <div className="empty-state"><House size={21} /><h3>Loading property…</h3></div>;
  if (!property) {
    return (
      <div className="empty-state">
        <House size={21} />
        <h3>Property not found</h3>
        <p>It may have been removed from COHO.</p>
        <Link href="/properties" className="button">Back to properties</Link>
      </div>
    );
  }
  const details = detailsQuery.data;
  const share = occupancy(property);
  const facts: Fact[] = [
    ["Address", [property.name, locationLine(property), details?.county].filter(Boolean).join(", ")],
    ["Status", statusLabel(property)],
    ["Rental type", RENTAL_TYPE[property.rentalType]],
    ["Occupancy", property.roomsOccupied === null
      ? `${property.totalRooms} ${property.totalRooms === 1 ? "unit" : "rooms"} (occupancy not known)`
      : property.rentalType === "whole_property" && property.totalRooms === 1
        ? property.roomsOccupied ? "Let" : "Vacant"
        : `${property.roomsOccupied} of ${property.totalRooms} rooms occupied${share === null ? "" : ` (${Math.round(share * 100)}%)`}`],
    ["Bedrooms", details?.bedrooms ? String(details.bedrooms) : "—"],
    ["Bathrooms", details?.bathrooms ? String(details.bathrooms) : "—"],
    ["Property type", details?.propertyType && details.propertyType !== "notSpecified" ? humanize(details.propertyType) : "—"],
    ["Open actions", String(property.openActionsCount)],
    ["Tags", property.tags.join(", ") || "—"],
    ["Buildings", property.buildings.join(", ") || "—"],
    ["Company", property.entityName ?? "—"],
    ["COHO reference", property.cohoReference ?? "Not in COHO yet"],
  ];

  return (
    <>
      <Link href="/properties" className="hh-back"><ArrowLeft size={14} /> All properties</Link>
      <div className="page-head">
        <div>
          <div className="eyebrow">Hinkley Homes · {property.source === "coho" ? "COHO" : "Property register"}</div>
          <h1 className="page-title">{property.name}</h1>
          <p className="page-sub">{locationLine(property)}</p>
        </div>
        {property.cohoReference && <div className="head-actions"><Link href={actionsPath(property)} className="button primary"><Briefcase size={14} /> View actions</Link></div>}
      </div>
      <section className="panel hh-detail">
        {property.imageUrl ? <img src={property.imageUrl} alt={`Photo of ${property.name}`} className="hh-detail-photo" /> : <div className="hh-detail-photo empty" aria-hidden="true"><House size={42} /></div>}
        <div>
          <ComplianceScore compliance={property.compliance} />
          <Facts items={facts} />
        </div>
      </section>

      {reference && <PropertyTenancy reference={reference} />}

      {reference && (
        detailsQuery.isLoading ? (
          <section className="panel hh-detail-note">Loading letting, ownership and compliance details from COHO…</section>
        ) : detailsQuery.isError || !details ? (
          <section className="panel hh-detail-note warn"><AlertTriangle size={14} /> COHO details could not be loaded. The summary above is still current.</section>
        ) : (
          <PropertyDetailSections details={details} />
        )
      )}
    </>
  );
}

function PropertyTenancy({ reference }: { reference: string }) {
  const query = useGetOccupancy({ query: { queryKey: getGetOccupancyQueryKey(), staleTime: 2 * 60_000 } });
  const rows = (query.data?.rows ?? []).filter((row) => row.propertyReference === reference);
  return (
    <section className="panel hh-detail-section">
      <div className="panel-head">
        <div><div className="panel-title">Tenancy</div><div className="panel-caption">Current and upcoming tenancies from COHO</div></div>
        <Link href={`/occupancy?q=${encodeURIComponent(query.data?.rows.find((row) => row.propertyReference === reference)?.propertyName ?? "")}`} className="button">Occupancy</Link>
      </div>
      {query.isLoading ? (
        <p className="hh-detail-note">Loading tenancies from COHO…</p>
      ) : query.isError ? (
        <p className="hh-detail-note warn"><AlertTriangle size={14} /> Tenancies could not be loaded from COHO.</p>
      ) : (
        <div className="table-wrap">
          <table className="hh-detail-table">
            <thead><tr><th>Unit</th><th>Tenants</th><th>Rent</th><th>Start</th><th>Fixed term</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.tenancyGuid ?? `${row.unitReference}-vacant`}>
                  <td>{row.unitsInProperty > 1 ? row.unitName : "Whole property"}</td>
                  <td>{row.tenants.length ? row.tenants.map((tenant) => tenant.name).join(", ") : "—"}{row.tenancyNumber ? <small> · {row.tenancyNumber}</small> : null}</td>
                  <td className="hh-nowrap">{rentText(row)}</td>
                  <td className="hh-nowrap">{row.startDate ? formatDate(row.startDate) : row.availableFrom ? `Available ${formatDate(row.availableFrom)}` : "—"}</td>
                  <td className="hh-nowrap">{row.fixedTermEnd ? formatDate(row.fixedTermEnd) : "—"}</td>
                  <td><span className={`status ${STATUS_TONE[row.status]}`}>{statusText(row)}</span></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="secondary-text">No units for this property in COHO.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ComplianceScore({ compliance }: { compliance: PropertyCompliance | null }) {
  const tone = complianceTone(compliance);
  if (tone === "unknown" || !compliance) {
    return (
      <div className="hh-score">
        <div className="hh-score-head"><span className="hh-score-label">Compliance</span><span className="hh-score-sub">{compliance ? "No compliance items are tracked in COHO" : "Not known"}</span></div>
        <ComplianceBar compliance={compliance} className="detail" />
      </div>
    );
  }
  return (
    <div className="hh-score">
      <div className="hh-score-head">
        <span className="hh-score-label">Compliance</span>
        <strong className={`hh-score-value ${tone}`}>{compliance.score}%</strong>
        <span className="hh-score-sub">{compliance.inDate} of {compliance.required} items in date</span>
      </div>
      <ComplianceBar compliance={compliance} className="detail" />
      {compliance.issues.length > 0 && (
        <ul className="hh-score-issues">
          {compliance.issues.map((issue) => (
            <li key={`${issue.name}-${issue.state}`} className={issue.state === "expiring_soon" ? "soon" : "due"}>
              {issue.name}<small>{issue.state === "expired" ? "Expired" : issue.state === "missing" ? "No record" : "Expiring soon"}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PropertyDetailSections({ details }: { details: PropertyDetails }) {
  const ownership = details.ownership;
  const letting: Fact[] = [
    ["Tenant type", details.allowedTenantType && details.allowedTenantType !== "unspecified" ? humanize(details.allowedTenantType) : "Any"],
    ["Minimum term", details.minimumMonths ? `${details.minimumMonths} months` : "—"],
    ["Pets allowed", yesNo(details.petsAllowed)],
    ["Smoking allowed", yesNo(details.smokingAllowed)],
  ];
  const ownershipFacts: Fact[] = ownership
    ? [
        ["Arrangement", ownership.type === "ownedByOrganisation" ? "Owned by Hinkley Homes" : ownership.type === "masterLeaseRentToRent" ? "Rent to rent (master lease)" : humanize(ownership.type)],
        ["Agency fee", ownership.agencyPercentage !== null ? `${ownership.agencyPercentage}%` : "—"],
        ["Fee due", ownership.agencyFeeDue ? humanize(ownership.agencyFeeDue) : "—"],
        ["Guaranteed rent", formatMoney(ownership.guaranteedRentAmount)],
        ["Start date", formatDate(ownership.startDate)],
        ["End date", ownership.endDate ? formatDate(ownership.endDate) : "Ongoing"],
        ["VAT", humanize(ownership.vatStatus)],
      ]
    : [];

  return (
    <>
      {details.unavailable.length > 0 && (
        <p className="hh-props-alert"><AlertTriangle size={14} /> COHO did not return: {details.unavailable.join(", ")}.</p>
      )}
      <div className="hh-detail-grid">
        <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Letting</div><div className="panel-caption">Rent and terms advertised in COHO</div></div></div>
          <div className="hh-detail-body">
            {details.rooms.length > 0 ? (
              <div className="table-wrap">
                <table className="hh-detail-table">
                  <thead><tr><th>Unit</th><th>Rent</th><th>Available</th><th>Deposit</th><th>Bills</th></tr></thead>
                  <tbody>
                    {details.rooms.map((room) => (
                      <tr key={room.reference}>
                        <td>{room.name}</td>
                        <td className="hh-nowrap">{formatMoney(room.rent)}{room.paymentFrequency ? <small> / {room.paymentFrequency}</small> : null}</td>
                        <td className="hh-nowrap">{formatDate(room.availableFrom)}</td>
                        <td>{room.depositType === "NONE" ? "None" : room.depositAmount !== null ? formatMoney(room.depositAmount) : humanize(room.depositType)}</td>
                        <td>{room.bills ? BILLS[room.bills] ?? humanize(room.bills) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="secondary-text">No rooms or tenancies are set up in COHO.</p>}
            <Facts items={letting} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><div className="panel-title">Ownership</div><div className="panel-caption">Management arrangement in COHO</div></div></div>
          <div className="hh-detail-body">
            {ownershipFacts.length ? <Facts items={ownershipFacts} /> : <p className="secondary-text">No ownership details in COHO.</p>}
          </div>
        </section>
      </div>

      <ComplianceRecords details={details} />

      {(details.description || details.amenities.length > 0) && (
        <section className="panel hh-detail-section">
          <div className="panel-head"><div><div className="panel-title">Advert</div><div className="panel-caption">Description and amenities from COHO</div></div></div>
          <div className="hh-detail-body">
            {details.amenities.length > 0 && <div className="hh-act-tags hh-amenities">{details.amenities.map((amenity) => <span key={amenity}>{amenity}</span>)}</div>}
            {details.description && <p className="hh-description">{details.description}</p>}
          </div>
        </section>
      )}
    </>
  );
}

function ComplianceRecords({ details }: { details: PropertyDetails }) {
  return (
    <section className="panel hh-detail-section">
      <div className="panel-head">
        <div>
          <div className="panel-title">Compliance records</div>
          <div className="panel-caption">
            Certificates, tests and inspections from COHO.
            {details.nextInspectionDue ? ` Next inspection due ${formatDate(details.nextInspectionDue)}.` : ""}
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="hh-detail-table">
          <thead><tr><th>Item</th><th>Status</th><th>Done / valid from</th><th>Expires / next due</th><th>Notes</th></tr></thead>
          {RECORD_GROUPS.map(([group, label]) => {
            const rows = details.records
              .filter((record) => record.group === group)
              .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
            if (!rows.length) return null;
            return (
              <tbody key={group}>
                <tr className="hh-detail-group"><th colSpan={5} scope="colgroup">{label}</th></tr>
                {rows.map((record) => {
                  const [text, tone] = RECORD_STATUS[record.status];
                  return (
                    <tr key={record.key}>
                      <td>{record.name}{!record.required && record.status !== "not_required" ? <small className="secondary-text"> (optional)</small> : null}</td>
                      <td><span className={`status ${tone}`}>{text}</span></td>
                      <td className="hh-nowrap">{formatDate(record.validFrom)}</td>
                      <td className="hh-nowrap">{formatDate(record.validTo)}</td>
                      <td>{record.detail ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>
    </section>
  );
}
