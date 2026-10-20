export function isAllowedStaffEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf("@");

  return (
    atIndex > 0 &&
    atIndex === normalized.lastIndexOf("@") &&
    normalized.slice(atIndex + 1) === "hinkleyhomes.co.uk"
  );
}
