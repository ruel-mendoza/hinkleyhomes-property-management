import { Briefcase, House } from "lucide-react";
import { useLocation } from "wouter";
import type { PropertySummary } from "@workspace/api-client-react";
import { locationLine } from "@/services/properties";
import { ActionsBadge } from "./ActionsBadge";
import { OccupancyBar } from "./OccupancyBar";

export const propertyPath = (property: PropertySummary) => `/properties/${encodeURIComponent(property.id)}`;
export const actionsPath = (property: PropertySummary) =>
  property.cohoReference ? `/actions?property=${encodeURIComponent(property.cohoReference)}` : "/actions";

export function PropertyThumb({ property, className = "" }: { property: PropertySummary; className?: string }) {
  return property.imageUrl
    ? <img className={`hh-thumb ${className}`} src={property.imageUrl} alt="" loading="lazy" />
    : <span className={`hh-thumb empty ${className}`} aria-hidden="true"><House size={22} /></span>;
}

export function PropertyCard({ property }: { property: PropertySummary }) {
  const [, navigate] = useLocation();
  const open = () => navigate(propertyPath(property));
  return (
    // A div rather than a link so the badge buttons inside it are valid HTML.
    <div
      className={`hh-prop-card ${property.deactivated ? "inactive" : ""}`}
      role="link"
      tabIndex={0}
      aria-label={`${property.name}, ${locationLine(property)}`}
      onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter") open(); }}
      data-testid={`card-property-${property.id}`}
    >
      <div className="hh-prop-media">
        <PropertyThumb property={property} />
        <div className="hh-prop-badges">
          <button type="button" className="hh-badge" title="Property details" aria-label={`Property details for ${property.name}`} onClick={(event) => { event.stopPropagation(); open(); }}>
            <House size={11} />
          </button>
          <button type="button" className="hh-badge manage" title="Actions and management" aria-label={`Actions for ${property.name}`} onClick={(event) => { event.stopPropagation(); navigate(actionsPath(property)); }}>
            <Briefcase size={11} />
          </button>
        </div>
      </div>
      <div className="hh-prop-body">
        <OccupancyBar occupied={property.roomsOccupied} total={property.totalRooms} className="edge" />
        <strong className="hh-prop-name">{property.name}</strong>
        <span className="hh-prop-loc">
          {locationLine(property)}
          {property.source === "register" && <em className="hh-prop-flag">Not in COHO yet</em>}
          {property.deactivated && <em className="hh-prop-flag">Inactive</em>}
        </span>
      </div>
      <ActionsBadge count={property.openActionsCount} />
    </div>
  );
}
