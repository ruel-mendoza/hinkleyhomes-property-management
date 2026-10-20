export const STAFF_EMAIL_DOMAIN = "hinkleyhomes.co.uk";
export const RESTRICTED_EMAIL_MESSAGE =
  "Access restricted: Only @hinkleyhomes.co.uk email addresses are allowed to register.";

export function isAllowedStaffEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.indexOf("@");

  return (
    separator > 0 &&
    separator === normalized.lastIndexOf("@") &&
    normalized.slice(separator + 1) === STAFF_EMAIL_DOMAIN
  );
}
