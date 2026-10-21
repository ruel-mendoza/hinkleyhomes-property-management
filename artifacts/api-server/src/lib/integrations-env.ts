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
