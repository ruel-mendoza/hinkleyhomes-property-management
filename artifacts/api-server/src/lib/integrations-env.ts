// Credentials for third-party integrations. Values come from Replit Secrets
// (or the shell environment locally); see .env.example at the repo root.
// Never log the values themselves — only whether each integration is set up.

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function cohoApiKey(): string | undefined {
  return read("COHO_API_KEY");
}

// Smoobu (Hinkley Homes Stays) API key, from Smoobu Settings > Advanced > API
// Keys. With SMOOBU_API_SECRET (an HMAC key) every request is signed; without it
// the old Api-Key header is sent, which Smoobu switches off on 31 October 2026.
export function smoobuCredentials(): { key: string; secret?: string } | undefined {
  const key = read("SMOOBU_API_KEY");
  return key ? { key, secret: read("SMOOBU_API_SECRET") } : undefined;
}

// Shared secret for scheduled n8n calls into the API (e.g. the COHO actions
// sync). Too-short values are ignored so a weak key can't be used.
export function pmsSyncKey(): string | undefined {
  const key = read("PMS_SYNC_KEY");
  return key && key.length >= 32 ? key : undefined;
}

// Xero via the n8n gateway workflow (n8n/xero-gateway.workflow.json), which
// reuses n8n's existing Xero connection to all five organisations.
export type XeroGatewayEnvResult =
  | { status: "configured"; url: string; key: string }
  | { status: "unconfigured" }
  | { status: "invalid"; problems: string[] };

export function readXeroGatewayEnv(): XeroGatewayEnvResult {
  const url = read("N8N_XERO_GATEWAY_URL");
  const key = read("N8N_XERO_GATEWAY_KEY");
  if (!url && !key) return { status: "unconfigured" };

  const problems: string[] = [];
  if (!url) problems.push("N8N_XERO_GATEWAY_URL is not set");
  if (!key) problems.push("N8N_XERO_GATEWAY_KEY is not set");
  else if (key.length < 32) problems.push("N8N_XERO_GATEWAY_KEY must be at least 32 characters");
  if (url) {
    try {
      if (new URL(url).protocol !== "https:") problems.push("N8N_XERO_GATEWAY_URL must use https");
    } catch {
      problems.push("N8N_XERO_GATEWAY_URL is not a valid URL");
    }
  }
  if (problems.length) return { status: "invalid", problems };
  return { status: "configured", url: url!, key: key! };
}

// The n8n "Xero overdue reminders" workflow's webhook, used to send a reminder,
// re-send an invoice or add a Xero note on request. It shares the gateway's key.
export type ReminderWebhookEnvResult = { status: "configured"; url: string; key: string } | { status: "unconfigured" };

export function readReminderWebhookEnv(): ReminderWebhookEnvResult {
  const url = read("N8N_REMINDER_WEBHOOK_URL");
  const gateway = readXeroGatewayEnv();
  if (!url || gateway.status !== "configured") return { status: "unconfigured" };
  try {
    if (new URL(url).protocol !== "https:") return { status: "unconfigured" };
  } catch {
    return { status: "unconfigured" };
  }
  return { status: "configured", url, key: gateway.key };
}

export type XeroConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  // Refresh tokens rotate on every use, so they are stored (encrypted with
  // this key) in the database rather than in an environment variable.
  tokenEncryptionKey: Buffer;
  // Only needed once Xero webhooks are enabled for the app.
  webhookKey?: string;
};

const XERO_REQUIRED = [
  "XERO_CLIENT_ID",
  "XERO_CLIENT_SECRET",
  "XERO_REDIRECT_URI",
  "XERO_TOKEN_ENCRYPTION_KEY",
] as const;

const DEFAULT_XERO_SCOPES =
  "offline_access accounting.settings.read accounting.contacts accounting.transactions";

export type XeroEnvResult =
  | { status: "configured"; config: XeroConfig }
  | { status: "unconfigured" }
  | { status: "invalid"; problems: string[] };

export function readXeroEnv(): XeroEnvResult {
  const present = XERO_REQUIRED.filter((name) => read(name));
  if (present.length === 0) return { status: "unconfigured" };

  const problems = XERO_REQUIRED.filter((name) => !read(name)).map((name) => `${name} is not set`);

  const redirectUri = read("XERO_REDIRECT_URI");
  if (redirectUri) {
    try {
      const url = new URL(redirectUri);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !local) problems.push("XERO_REDIRECT_URI must use https");
    } catch {
      problems.push("XERO_REDIRECT_URI is not a valid URL");
    }
  }

  const rawKey = read("XERO_TOKEN_ENCRYPTION_KEY");
  const tokenEncryptionKey = rawKey ? Buffer.from(rawKey, "base64") : Buffer.alloc(0);
  if (rawKey && tokenEncryptionKey.length !== 32) {
    problems.push("XERO_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  }

  if (problems.length) return { status: "invalid", problems };
  return {
    status: "configured",
    config: {
      clientId: read("XERO_CLIENT_ID")!,
      clientSecret: read("XERO_CLIENT_SECRET")!,
      redirectUri: redirectUri!,
      scopes: read("XERO_SCOPES") ?? DEFAULT_XERO_SCOPES,
      tokenEncryptionKey,
      webhookKey: read("XERO_WEBHOOK_KEY"),
    },
  };
}
