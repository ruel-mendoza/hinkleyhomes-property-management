import app from "./app";
import { chargeAutomationCredentials, cohoApiKey, readXeroEnv, readXeroGatewayEnv, smoobuMode } from "./lib/integrations-env";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const xero = readXeroEnv();
  const xeroGateway = readXeroGatewayEnv();
  logger.info(
    {
      coho: cohoApiKey() ? "configured" : "unconfigured",
      chargeAutomation: chargeAutomationCredentials() ? "configured" : "unconfigured",
      smoobu: smoobuMode() === "old key" ? "old Api-Key (ends 31 Oct 2026)" : smoobuMode() ?? "unconfigured",
      xeroGateway: xeroGateway.status,
      xeroDirect: xero.status,
    },
    "Integration credentials",
  );
  if (xeroGateway.status === "invalid") {
    logger.warn({ problems: xeroGateway.problems }, "n8n Xero gateway settings are incomplete; gateway stays disabled");
  }
  if (xero.status === "invalid") {
    logger.warn({ problems: xero.problems }, "Xero credentials are incomplete; Xero stays disabled");
  }
});
