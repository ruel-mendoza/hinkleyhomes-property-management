import { createHash, createHmac, randomUUID } from "node:crypto";
import { smoobuCredentials } from "./integrations-env";

// Smoobu API client (Hinkley Homes Stays). Read-only on purpose: Smoobu is the
// channel manager and PriceLabs writes prices and stay rules through it, so the
// app never changes bookings, rates or availability there.
//
// Requests are signed with HMAC-SHA256 once SMOOBU_API_SECRET is set; until then
// the legacy Api-Key header is used (it stops working on 31 October 2026). Canonical string, one part per line: method,
// path, query sorted by key, timestamp, nonce, SHA-256 of the body (hex), API
// key. The signature is the Base64 HMAC of that string with the API secret.
const SMOOBU = "https://login.smoobu.com";
const TIMEOUT_MS = 30_000;
const EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex");

export class SmoobuApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type SmoobuQuery = Record<string, string | number | boolean | (string | number)[] | undefined>;

// RFC 3986: spaces as %20, and ! ' ( ) * escaped too.
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function smoobuQueryString(query: SmoobuQuery): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) pairs.push([`${key}[]`, String(item)]);
    else pairs.push([key, typeof value === "boolean" ? (value ? "true" : "false") : String(value)]);
  }
  return pairs
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function smoobuSignature(secret: string, parts: { method: string; path: string; query: string; timestamp: string; nonce: string; bodyHash: string; key: string }): string {
  const canonical = [parts.method, parts.path, parts.query, parts.timestamp, parts.nonce, parts.bodyHash, parts.key].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("base64");
}

// Signed headers when there is a secret (HMAC key); the old Api-Key header until
// it is added. The old header stops working on 31 October 2026.
function authHeaders(path: string, query: string): Record<string, string> {
  const credentials = smoobuCredentials();
  if (!credentials) throw new SmoobuApiError("SMOOBU_API_KEY is not configured.");
  if (!credentials.secret) return { "Api-Key": credentials.key };
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = randomUUID();
  const signature = smoobuSignature(credentials.secret, { method: "GET", path, query, timestamp, nonce, bodyHash: EMPTY_BODY_HASH, key: credentials.key });
  return { "X-API-Key": credentials.key, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature };
}

async function send(path: string, query: string): Promise<Response> {
  const headers = authHeaders(path, query);
  try {
    return await fetch(`${SMOOBU}${path}${query ? `?${query}` : ""}`, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmoobuApiError(`Could not reach Smoobu: ${(error as Error).message}`);
  }
}

export async function smoobuGet(path: string, query: SmoobuQuery = {}): Promise<unknown> {
  const qs = smoobuQueryString(query);
  let response = await send(path, qs);
  // 700 requests a minute; wait for the window to reset once (at most a minute).
  if (response.status === 429) {
    const resetAt = Number(response.headers.get("X-RateLimit-Retry-After")) * 1000;
    const wait = Number.isFinite(resetAt) && resetAt > Date.now() ? Math.min(resetAt - Date.now(), 60_000) : 10_000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await send(path, qs);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new SmoobuApiError(`Smoobu returned a non-JSON response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    const details = payload as { detail?: unknown; title?: unknown; message?: unknown };
    const reason = [details.detail, details.message, details.title].find((value): value is string => typeof value === "string") ?? "";
    throw new SmoobuApiError(`Smoobu returned HTTP ${response.status}${reason ? `: ${reason}` : ""}.`, response.status);
  }
  return payload;
}
