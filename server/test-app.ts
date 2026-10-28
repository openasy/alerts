// Starts the app on a random port for tests, with a fake Slack that keeps what it is sent.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createAlerts, type AlertsOptions } from "./alerts.ts";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { sealer } from "./seal.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const T0 = Date.parse("2026-10-28T02:00:00Z");

/** A webhook receiver: Slack, Teams or anything else, as the tests need. It can be made to fail. */
export async function fakeHook() {
  const received: Array<{ path: string; body: any }> = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(status).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { received, base, fail: (s: number) => (status = s), close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; alertsOptions?: Partial<AlertsOptions> }) {
  const db = openDb(":memory:");
  let now = T0;
  const { alertsOptions, ...appOptions } = opts;
  const alerts = createAlerts(db, { sealer: sealer(Buffer.alloc(32, 5)), publicUrl: "https://alerts.example.com", clock: () => now, ...alertsOptions });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "alerts", productName: "OpenAsy Alerts", origin: base });
  handler = createApp({ db, alerts, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...appOptions });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const ingest = as(INGEST_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, alerts, auth, base, admin, ingest, get, send, close, later: (ms: number) => (now += ms) };
}
