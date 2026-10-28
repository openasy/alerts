import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { fakeHook, INGEST_TOKEN, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let hook: Awaited<ReturnType<typeof fakeHook>>;

beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
  hook = await fakeHook();
});
afterAll(async () => {
  await app.close();
  await hook.close();
});

describe("alerts in", () => {
  it("are taken from Prometheus at Alertmanager's path, gzipped too, with an empty answer", async () => {
    const body = gzipSync(
      JSON.stringify([{ labels: { alertname: "HighLatency", service: "api" }, startsAt: "2026-10-28T01:59:00Z", generatorURL: "http://prom/graph" }]),
    );
    const res = await fetch(`${app.base}/api/v2/alerts`, {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, "content-type": "application/json", "content-encoding": "gzip" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const [g] = (await app.get("/api/v1/groups")).groups;
    expect(g).toMatchObject({ labels: { alertname: "HighLatency" }, state: "firing", route: null });
    expect(g.alerts[0]).toMatchObject({ startsAt: "2026-10-28T01:59:00.000Z", generatorUrl: "http://prom/graph" });
  });

  it("need the ingest token or a signed-in editor", async () => {
    expect((await fetch(`${app.base}/api/v1/alerts`, { method: "POST", body: "[]" })).status).toBe(401);
    expect((await app.send("POST", "/api/v1/alerts", [{ labels: { alertname: "ByHand" } }])).status).toBe(200);
  });
});

describe("routing over the API", () => {
  it("sends the group to the route's contact point, and keeps the address hidden", async () => {
    const cp = (await (await app.send("POST", "/api/v1/contact-points", { name: "api-team", kind: "webhook", url: `${hook.base}/api?key=SECRET` })).json()) as {
      id: string;
      target: string;
    };
    expect(cp.target).toBe(`${new URL(hook.base).host}/api/…`);
    expect(JSON.stringify(await app.get("/api/v1/contact-points"))).not.toContain("SECRET");
    await app.send("PUT", "/api/v1/routes", { routes: [{ name: "API", matchers: [{ label: "service", value: "api" }], contactPointId: cp.id }] });
    expect(await app.alerts.tick()).toBe(1);
    expect(hook.received[0]).toMatchObject({ path: "/api?key=SECRET", body: { title: "[FIRING:1] HighLatency" } });
    const summary = await app.get("/api/v1/summary");
    expect(summary).toMatchObject({ groups: { firing: 2, unacknowledged: 1, unrouted: 1 }, notifications: { lastDay: 1, failedLastDay: 0 } });
    expect(summary.notifications.perHour).toHaveLength(24);
  });
});

describe("the product", () => {
  it("names itself, and has metrics for Prometheus", async () => {
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "alerts", version: "0.1.0" });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="alerts",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_alerts_firing 2");
    expect(metrics).toContain("openasy_alerts_notifications_failed 0");
  });
});
