import { cohoApiKey } from "./integrations-env";

// Plain COHO Public API v1.1 client for background work (syncs) that isn't
// tied to an HTTP request. Route handlers use requestCoho in routes/coho.ts.
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

export async function cohoGet(path: string): Promise<unknown> {
  const apiKey = cohoApiKey();
  if (!apiKey) throw new CohoApiError("COHO_API_KEY is not configured.");

  let response: Response;
  try {
    response = await fetch(`${COHO_PUBLIC_API}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
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
    const details = payload as { detail?: unknown; title?: unknown };
    const reason = typeof details.detail === "string" ? details.detail : typeof details.title === "string" ? details.title : "";
    throw new CohoApiError(`COHO returned HTTP ${response.status}${reason ? `: ${reason}` : ""}.`, response.status);
  }
  return payload;
}
