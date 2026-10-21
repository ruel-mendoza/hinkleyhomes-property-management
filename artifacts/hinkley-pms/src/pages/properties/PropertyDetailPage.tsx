import { ArrowLeft, Briefcase, House } from "lucide-react";
import { Link } from "wouter";
import { getListPropertiesQueryKey, useListProperties } from "@workspace/api-client-react";
import { locationLine, occupancy, statusLabel } from "@/services/properties";
import { OccupancyBar } from "@/components/properties/OccupancyBar";
import { actionsPath } from "@/components/properties/PropertyCard";
import "./properties.css";

const RENTAL_TYPE = { room: "Let by the room", whole_property: "Whole property" } as const;

export default function PropertyDetailPage({ id }: { id: string }) {
  const listQuery = useListProperties({ query: { queryKey: getListPropertiesQueryKey() } });
  const property = listQuery.data?.items.find((item) => item.id === id);

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
  const share = occupancy(property);
  const facts: [string, string][] = [
    ["Address", [property.name, locationLine(property)].filter(Boolean).join(", ")],
    ["Status", statusLabel(property)],
    ["Rental type", RENTAL_TYPE[property.rentalType]],
    ["Rooms", property.roomsOccupied === null ? `${property.totalRooms} (occupancy not known)` : `${property.roomsOccupied} of ${property.totalRooms} occupied${share === null ? "" : ` (${Math.round(share * 100)}%)`}`],
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
          <OccupancyBar occupied={property.roomsOccupied} total={property.totalRooms} className="detail" />
          <dl className="hh-act-facts">
            {facts.map(([label, value]) => <div key={label} className={label === "Address" ? "wide" : ""}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </div>
      </section>
    </>
  );
}
