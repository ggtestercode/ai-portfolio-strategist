import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { initBrokers } from "./lib/startup";
import { startPolling } from "./notifications/telegram";
import { startCronScanner } from "./lib/cronScanner";

void initBrokers();
startPolling();     // registers Telegram notifiers (must be before cronScanner)
startCronScanner(); // starts cron after Telegram is ready; first scan in 10s

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
});
