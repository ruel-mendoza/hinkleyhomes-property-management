import { cohoApiKey } from "./integrations-env";

// Plain COHO Public API v1.1 client for work that isn't a straight proxy of
// one request (syncs, action writes). Simple proxies use requestCoho in routes/coho.ts.
const COHO_PUBLIC_API = "https://api.coho.life/v1.1/public";
const TIMEOUT_MS = 30_000;

export class CohoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function cohoRequest(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
  const apiKey = cohoApiKey();
  if (!apiKey) throw new CohoApiError("COHO_API_KEY is not configured.");

  let response: Response;
  try {
    response = await fetch(`${COHO_PUBLIC_API}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new CohoApiError(`Could not reach the COHO API: ${(error as Error).message}`);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new CohoApiError(`COHO returned a non-JSON response (HTTP ${response.status}).`, response.status);
  }
  if (!response.ok) {
    const details = payload as { detail?: unknown; title?: unknown; errors?: unknown };
    const fieldErrors =
      details.errors && typeof details.errors === "object"
        ? Object.values(details.errors as Record<string, unknown>).flat().filter((e): e is string => typeof e === "string")
        : [];
    const reason =
      typeof details.detail === "string" ? details.detail : fieldErrors[0] ?? (typeof details.title === "string" ? details.title : "");
    throw new CohoApiError(`COHO returned HTTP ${response.status}${reason ? `: ${reason}` : ""}.`, response.status);
  }
  return payload;
}

export const cohoGet = (path: string): Promise<unknown> => cohoRequest("GET", path);
