import type { PropertyCompliance } from "@workspace/api-client-react";
import { complianceSummary, complianceTone } from "@/services/properties";

// COHO compliance score as a thin bar: green when everything is in date,
// amber when something is missing or expiring soon, red when anything has
// expired or less than half is in date.
export function ComplianceBar({ compliance, className = "" }: { compliance: PropertyCompliance | null; className?: string }) {
  const tone = complianceTone(compliance);
  const label = complianceSummary(compliance);
  if (tone === "unknown" || !compliance) {
    return <div className={`hh-occ unknown ${className}`} title={label} role="img" aria-label={label} />;
  }
  return (
    <div className={`hh-occ ${className}`} title={label} role="img" aria-label={label}>
      <span className={tone} style={{ width: `${Math.max(compliance.score, 3)}%` }} />
    </div>
  );
}
