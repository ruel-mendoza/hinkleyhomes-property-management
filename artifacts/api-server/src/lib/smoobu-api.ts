import { createHash, createHmac, randomUUID } from "node:crypto";
import { readSmoobuGatewayEnv, smoobuCredentials } from "./integrations-env";

// Smoobu API client (Hinkley Homes Stays). Read-only on purpose: Smoobu is the
// channel manager and PriceLabs writes prices and stay rules through it, so the
// app never changes bookings, rates or availability there.
//
// With N8N_SMOOBU_GATEWAY_URL set, every read goes through the n8n gateway
// (n8n/smoobu-gateway.workflow.json), which holds the Smoobu key. Otherwise the
// app calls Smoobu itself with SMOOBU_API_KEY, as below.
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

// What came back from Smoobu, whichever way it was asked.
type Reply = { status: number; retryAt: number | null; payload: unknown };

async function direct(path: string, query: SmoobuQuery): Promise<Reply> {
  const qs = smoobuQueryString(query);
  const headers = authHeaders(path, qs);
  let response: Response;
  try {
    response = await fetch(`${SMOOBU}${path}${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmoobuApiError(`Could not reach Smoobu: ${(error as Error).message}`);
  }
  const text = await response.text();
  try {
    return { status: response.status, retryAt: Number(response.headers.get("X-RateLimit-Retry-After")) * 1000 || null, payload: text ? JSON.parse(text) : {} };
  } catch {
    throw new SmoobuApiError(`Smoobu returned a non-JSON response (HTTP ${response.status}).`, response.status);
  }
}

// The gateway answers { ok, status, retryAfter, data } or, when it rejects the
// request itself, { ok: false, status: 400, error }.
async function viaGateway(gateway: { url: string; key: string }, path: string, query: SmoobuQuery): Promise<Reply> {
  const flat = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && !Array.isArray(value)));
  let response: Response;
  try {
    response = await fetch(gateway.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Hinkley-Gateway-Key": gateway.key },
      body: JSON.stringify({ path, query: flat }),
      signal: AbortSignal.timeout(TIMEOUT_MS + 15_000),
    });
  } catch (error) {
    throw new SmoobuApiError(`Could not reach the n8n Smoobu gateway: ${(error as Error).message}`);
  }
  const text = await response.text();
  let reply: { status?: unknown; retryAfter?: unknown; data?: unknown; error?: unknown } | undefined;
  try {
    reply = text ? JSON.parse(text) : undefined;
  } catch {
    reply = undefined;
  }
  // n8n answers with its own body when the key is wrong, the workflow is
  // inactive, or the workflow itself fails.
  if (!reply || typeof reply !== "object" || typeof reply.status !== "number") {
    throw new SmoobuApiError(
      response.status === 401 || response.status === 403
        ? "The n8n Smoobu gateway rejected the key (check N8N_SMOOBU_GATEWAY_KEY or N8N_XERO_GATEWAY_KEY)."
        : response.status === 404
          ? "The n8n Smoobu gateway workflow was not found or is not published."
          : `The n8n Smoobu gateway returned an unexpected HTTP ${response.status} response.`,
    );
  }
  const payload = reply.data ?? (typeof reply.error === "string" ? { message: reply.error } : {});
  return { status: reply.status, retryAt: Number(reply.retryAfter) * 1000 || null, payload };
}

function ask(path: string, query: SmoobuQuery): Promise<Reply> {
  const gateway = readSmoobuGatewayEnv();
  return gateway ? viaGateway(gateway, path, query) : direct(path, query);
}

export async function smoobuGet(path: string, query: SmoobuQuery = {}): Promise<unknown> {
  let reply = await ask(path, query);
  // 700 requests a minute; wait for the window to reset once (at most a minute).
  if (reply.status === 429) {
    const wait = reply.retryAt && reply.retryAt > Date.now() ? Math.min(reply.retryAt - Date.now(), 60_000) : 10_000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    reply = await ask(path, query);
  }
  if (reply.status >= 400) {
    const details = (reply.payload ?? {}) as { detail?: unknown; title?: unknown; message?: unknown };
    const reason = [details.detail, details.message, details.title].find((value): value is string => typeof value === "string") ?? "";
    throw new SmoobuApiError(`Smoobu returned HTTP ${reply.status}${reason ? `: ${reason}` : ""}.`, reply.status);
  }
  return reply.payload;
}
