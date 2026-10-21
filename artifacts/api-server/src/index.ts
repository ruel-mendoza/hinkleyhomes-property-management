import app from "./app";
import { cohoApiKey, readXeroEnv } from "./lib/integrations-env";
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
  logger.info(
    { coho: cohoApiKey() ? "configured" : "unconfigured", xero: xero.status },
    "Integration credentials",
  );
  if (xero.status === "invalid") {
    logger.warn({ problems: xero.problems }, "Xero credentials are incomplete; Xero stays disabled");
  }
});
