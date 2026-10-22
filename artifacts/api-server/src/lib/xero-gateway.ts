import { readXeroGatewayEnv } from "./integrations-env";

// Read-only Xero access through the n8n gateway workflow. The resources and
// query keys accepted here mirror the allowlist in n8n/xero-gateway.workflow.json;
// the workflow re-validates everything, so this list is for type safety only.
export type XeroResource =
  | "organisation"
  | "accounts"
  | "trackingCategories"
  | "contacts"
  | "invoices"
  | "onlineInvoice"
  | "creditNotes"
  | "payments"
  | "bankTransactions"
  | "profitAndLoss"
  | "balanceSheet"
  | "agedPayables"
  | "bankSummary";

export type XeroGatewayRequest = {
  tenantId: string;
  resource: XeroResource;
  // Xero GUID for a single record (contacts, invoices, onlineInvoice, creditNotes, payments, bankTransactions).
  id?: string;
  query?: Record<string, string | number | boolean>;
  // Only records changed since this time (sent to Xero as If-Modified-Since).
  ifModifiedSince?: Date;
};

export type XeroGatewayResponse<T = unknown> = {
  ok: boolean;
  // Xero's HTTP status (or the gateway's 400 for a rejected request).
  status: number;
  tenantId?: string;
  tenantName?: string;
  resource?: XeroResource;
  // Seconds to wait when Xero rate-limits (status 429).
  retryAfter?: string | null;
  error?: string;
  data?: T;
};

export class XeroGatewayError extends Error {}

// Xero's JSON dates look like "/Date(1696118400000+0000)/"; the *String
// variants (e.g. DueDateString) are ISO without a timezone. Both mean UTC.
export function parseXeroDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const msDate = value.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  const date = msDate ? new Date(Number(msDate[1])) : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const TIMEOUT_MS = 45_000;

export async function xeroGatewayRequest<T = unknown>(
  request: XeroGatewayRequest,
): Promise<XeroGatewayResponse<T>> {
  const env = readXeroGatewayEnv();
  if (env.status !== "configured") {
    throw new XeroGatewayError(
      env.status === "invalid" ? env.problems.join("; ") : "The n8n Xero gateway is not configured.",
    );
  }

  let response: Response;
  try {
    response = await fetch(env.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Hinkley-Gateway-Key": env.key,
      },
      body: JSON.stringify({
        ...request,
        ifModifiedSince: request.ifModifiedSince?.toISOString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new XeroGatewayError(`Could not reach the n8n Xero gateway: ${(error as Error).message}`);
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  // n8n answers with its own non-JSON or {message} body when the key is wrong,
  // the workflow is inactive, or the workflow itself fails.
  if (!payload || typeof payload !== "object" || !("status" in payload)) {
    throw new XeroGatewayError(
      response.status === 403 || response.status === 401
        ? "The n8n gateway rejected the key (check N8N_XERO_GATEWAY_KEY)."
        : response.status === 404
          ? "The n8n gateway workflow was not found or is not active."
          : `The n8n gateway returned an unexpected HTTP ${response.status} response.`,
    );
  }
  return payload as XeroGatewayResponse<T>;
}
