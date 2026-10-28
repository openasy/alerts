import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createAlerts } from "./alerts.ts";
import { createApp, createMetricsHandler } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { sealer } from "./seal.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.ALERTS_DB ?? "/data/alerts.db";
const retentionDays = Number(process.env.ALERTS_RETENTION_DAYS ?? 90);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.ALERTS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.ALERTS_METRICS_PORT ? Number(process.env.ALERTS_METRICS_PORT) : undefined;
const seconds = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < 0 || v > 86_400) throw new Error(`${name} must be a whole number of seconds, 0 to 86400`);
  return v * 1000;
};
const timing = {
  groupWaitMs: seconds("ALERTS_GROUP_WAIT_SECONDS", 30),
  groupIntervalMs: seconds("ALERTS_GROUP_INTERVAL_SECONDS", 300),
  resolveTimeoutMs: seconds("ALERTS_RESOLVE_TIMEOUT_SECONDS", 300),
};

if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("ALERTS_RETENTION_DAYS must be a number of days, 1 or more");

const db = openDb(dbPath);
// The address people open alerts at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// links in notifications use it.
const publicUrl = (process.env.ALERTS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.ALERTS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "alerts",
  productName: "OpenAsy Alerts",
  origin: publicUrl,
  // Locally the same alerts is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.ALERTS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "ALERTS_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const alerts = createAlerts(db, { sealer: sealer(secretsKey), publicUrl, timing, retentionDays });
const server = createServer(
  createApp({
    db,
    alerts,
    version,
    auth,
    ingestToken: process.env.ALERTS_INGEST_TOKEN,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(alerts, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "alerts started", { version, port, db: dbPath, headless, retentionDays, ...timing }));
if (!process.env.ALERTS_INGEST_TOKEN)
  log("warn", "ALERTS_INGEST_TOKEN is not set; Prometheus and products need an API token with the editor role (Settings, API tokens) to send alerts");
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "ALERTS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put alerts behind TLS (ADR 0026)", { url: publicUrl });
}
if (!secretsKey)
  log("warn", "no secrets key: TOTP secrets and contact point addresses are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", {
    file: secretsKeyFile,
  });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

// One turn at a time: a slow contact point must not have two turns send the same notification.
let ticking = false;
const tick = () => {
  if (ticking) return;
  ticking = true;
  void alerts
    .tick()
    .catch((err: unknown) => log("error", "notifier", { error: String(err) }))
    .finally(() => (ticking = false));
};
alerts.purge();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => alerts.purge(), 3_600_000), setInterval(tick, 5_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
