// Rooms occupied as a thin bar: green at 75%+ occupied, amber below.
export function OccupancyBar({ occupied, total, className = "" }: { occupied: number | null; total: number; className?: string }) {
  if (occupied === null) {
    return <div className={`hh-occ unknown ${className}`} title="Occupancy not known (not in COHO yet)" role="img" aria-label="Occupancy not known" />;
  }
  const share = total > 0 ? Math.min(occupied / total, 1) : 0;
  const label = `${occupied} of ${total} ${total === 1 ? "room" : "rooms"} occupied`;
  return (
    <div className={`hh-occ ${className}`} title={label} role="img" aria-label={label}>
      <span className={share >= 0.75 ? "good" : "low"} style={{ width: `${share * 100}%` }} />
    </div>
  );
}
