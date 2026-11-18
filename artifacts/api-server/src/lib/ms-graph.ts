import { readMicrosoftGraphEnv } from "./integrations-env";

// Microsoft Graph with the app's own identity (client credentials), used by the
// backup intake check. The token is cached until shortly before it expires.

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 60_000;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const env = readMicrosoftGraphEnv();
  if (!env) throw new GraphError("Microsoft 365 is not set up (MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET).");
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.clientId, client_secret: env.clientSecret, scope: "https://graph.microsoft.com/.default" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new GraphError(`Microsoft 365 sign-in failed: ${(body.error_description ?? `HTTP ${response.status}`).split("\r\n")[0]}`, response.status);
  token = { value: body.access_token, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
  return token.value;
}

async function send(method: string, pathOrUrl: string, init: { json?: unknown; body?: Buffer; contentType?: string }): Promise<Response> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" };
    let body: string | Uint8Array | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers["Content-Type"] = init.contentType ?? "application/octet-stream";
      body = new Uint8Array(init.body);
    }
    const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    // Throttled or briefly unavailable: wait as asked (at most 30 s) and try once more.
    if ((response.status === 429 || response.status === 503) && attempt === 0) {
      const wait = Math.min(Number(response.headers.get("Retry-After")) || 5, 30) * 1000;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (response.status === 401 && attempt === 0) {
      token = null;
      continue;
    }
    return response;
  }
}

async function result<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;
    throw new GraphError(`${what}: ${message}`, response.status);
  }
  return body as T;
}

export async function graphGet<T>(path: string, what = "Microsoft 365 read failed"): Promise<T> {
  return result<T>(await send("GET", path, {}), what);
}

export async function graphSend<T = unknown>(method: "POST" | "PATCH" | "PUT", path: string, json: unknown, what = "Microsoft 365 request failed"): Promise<T> {
  return result<T>(await send(method, path, { json }), what);
}

export async function graphUpload<T>(path: string, data: Buffer, contentType: string, what = "Microsoft 365 upload failed"): Promise<T> {
  return result<T>(await send("PUT", path, { body: data, contentType }), what);
}
