import { rentalNinjaCredentials } from "./integrations-env";

// Rental Ninja Client API v1 (docs: "Client API Documentation", Nov 2026).
// Read-only by design: the token only asks for accounting:read, and only GETs
// under /accounting/ are allowed, so this can never change prices, bookings or
// statements. Rental Ninja is used only for monthly owner statements; Smoobu
// stays the source of truth for bookings.

const TOKEN_URL = "https://rental-ninja.com/oauth/token";
const BASE_URL = "https://rental-ninja.com/client-api/v1";
const TIMEOUT_MS = 30_000;

export class RentalNinjaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const rentalNinjaConfigured = () => Boolean(rentalNinjaCredentials());

// Tokens last a year; keep one in memory and renew it a day early or on a 401.
let token: { value: string; expiresAt: number } | null = null;

async function accessToken(renew = false): Promise<string> {
  if (!renew && token && Date.now() < token.expiresAt) return token.value;
  const credentials = rentalNinjaCredentials();
  if (!credentials) throw new RentalNinjaError("Rental Ninja isn't connected: add RENTAL_NINJA_API_KEY and RENTAL_NINJA_SECRET.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.secret, scope: "accounting:read" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token) {
    throw new RentalNinjaError(response.status === 401 ? "Rental Ninja refused the API key: check it in Settings > Billing > API access." : `Rental Ninja sign-in failed (HTTP ${response.status}).`, response.status);
  }
  token = { value: body.access_token, expiresAt: Date.now() + Math.max((body.expires_in ?? 86_400) - 86_400, 3_600) * 1000 };
  return token.value;
}

export async function rentalNinjaGet<T = unknown>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  if (!path.startsWith("/accounting/")) throw new RentalNinjaError(`Only accounting reads are allowed (${path}).`);
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  for (const renew of [false, true]) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${await accessToken(renew)}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 && !renew) continue;
    if (response.ok) return (await response.json()) as T;
    const message =
      response.status === 403 ? "Rental Ninja says this key can't read accounting: give it \"Read accounting\" in Settings > Billing > API access."
        : response.status === 429 ? "Rental Ninja is rate limiting; try again in a minute."
          : `Rental Ninja returned HTTP ${response.status}.`;
    throw new RentalNinjaError(message, response.status);
  }
  throw new RentalNinjaError("Rental Ninja refused the access token.", 401);
}

type Page<T> = { data?: T[]; meta?: { last_page?: number } };

// Every page of a list endpoint (200 per page, at most 20 pages).
export async function rentalNinjaList<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const body = await rentalNinjaGet<Page<T>>(path, { ...query, page, per_page: 200 });
    items.push(...(body.data ?? []));
    if (!body.meta?.last_page || page >= body.meta.last_page) break;
  }
  return items;
}
