// Open-action count: a quarter-circle in a card's top-right corner, or a pill in tables.
export function ActionsBadge({ count, variant = "corner" }: { count: number; variant?: "corner" | "pill" }) {
  if (count <= 0) return variant === "pill" ? <span className="secondary-text" style={{ margin: 0 }}>—</span> : null;
  const label = `${count} open ${count === 1 ? "action" : "actions"}`;
  return (
    <span className={variant === "corner" ? "hh-actions-corner" : "hh-actions-pill"} title={label} aria-label={label}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
