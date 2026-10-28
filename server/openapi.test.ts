import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, fakeHook, INGEST_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "alerts-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // alerts' own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let hook: Awaited<ReturnType<typeof fakeHook>>;
  let contact = "";
  let schedule = "";
  let silence = "";
  let group = "";
  const send = (body: string, token = INGEST_TOKEN) => auth(token, body);
  const alert = JSON.stringify([{ labels: { alertname: "DiskFull", instance: "db-1", team: "db" }, annotations: { summary: "Disk full" } }]);

  beforeAll(async () => {
    hook = await fakeHook();
  });
  afterAll(() => hook.close());

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("contact points, schedules and routes", async () => {
    contact = ((await call("POST", "/api/v1/contact-points", admin({ name: "db", kind: "webhook", url: `${hook.base}/db` }))).body as { id: string }).id;
    await call("POST", "/api/v1/contact-points", admin({ name: "db", kind: "webhook", url: `${hook.base}/db` }));
    await call("POST", "/api/v1/contact-points", admin({ name: "x", kind: "email", url: "x" }));
    await call("POST", "/api/v1/contact-points", admin("nope"));
    await call("POST", "/api/v1/contact-points", { method: "POST" });
    await call("GET", "/api/v1/contact-points", admin());
    await call("GET", "/api/v1/contact-points", {});
    await call("POST", "/api/v1/contact-points/{id}/test", { method: "POST", ...admin() }, `/api/v1/contact-points/${contact}/test`);
    await call("POST", "/api/v1/contact-points/{id}/test", { method: "POST", ...admin() }, "/api/v1/contact-points/missing/test");
    await call("POST", "/api/v1/contact-points/{id}/test", { method: "POST" }, `/api/v1/contact-points/${contact}/test`);

    schedule = ((await call("POST", "/api/v1/schedules", admin({ name: "DB", members: [{ name: "Ayşe", mention: "U024BE7LH" }] }))).body as { id: string }).id;
    await call("POST", "/api/v1/schedules", admin({ name: "DB", members: [{ name: "x" }] }));
    await call("POST", "/api/v1/schedules", admin({ name: "x", members: [] }));
    await call("POST", "/api/v1/schedules", admin("nope"));
    await call("POST", "/api/v1/schedules", { method: "POST" });
    await call("GET", "/api/v1/schedules", admin());
    await call("GET", "/api/v1/schedules", {});
    const s = "/api/v1/schedules/{id}";
    await call("PUT", s, admin({ name: "DB", members: [{ name: "Ayşe" }, { name: "Can" }], shiftHours: 24 }), `/api/v1/schedules/${schedule}`);
    await call("PUT", s, admin({ name: "DB", members: [] }), `/api/v1/schedules/${schedule}`);
    await call("PUT", s, admin("nope"), `/api/v1/schedules/${schedule}`);
    await call("PUT", s, admin({ name: "x", members: [{ name: "x" }] }), "/api/v1/schedules/missing");
    await call("PUT", s, { method: "PUT" }, `/api/v1/schedules/${schedule}`);

    await call(
      "PUT",
      "/api/v1/routes",
      admin({ routes: [{ name: "DB", matchers: [{ label: "team", value: "db" }], contactPointId: contact, scheduleId: schedule }] }),
    );
    await call("PUT", "/api/v1/routes", admin({ routes: [{ name: "x", contactPointId: "nope" }] }));
    await call("PUT", "/api/v1/routes", admin("nope"));
    await call("PUT", "/api/v1/routes", { method: "PUT" });
    await call("GET", "/api/v1/routes", admin());
    await call("GET", "/api/v1/routes", {});
    await call("DELETE", "/api/v1/contact-points/{id}", admin(), `/api/v1/contact-points/${contact}`);
    await call("DELETE", s, admin(), `/api/v1/schedules/${schedule}`);
  });

  it("alerts in, both ways, and every refusal", async () => {
    await call("POST", "/api/v1/alerts", send(alert));
    await call("POST", "/api/v2/alerts", send(alert));
    await call("POST", "/api/v1/alerts", send("{nope"));
    await call("POST", "/api/v1/alerts", send("[{}]"));
    await call("POST", "/api/v2/alerts", send(alert, "wrong"));
    await call("POST", "/api/v1/alerts", { method: "POST" });
  });

  it("groups and notifications", async () => {
    await call("GET", "/api/v1/groups", admin());
    group = ((await call("GET", "/api/v1/groups", admin(), "/api/v1/groups?state=firing")).body as { groups: Array<{ key: string }> }).groups[0]!.key;
    await call("GET", "/api/v1/groups", admin(), "/api/v1/groups?state=gone");
    await call("GET", "/api/v1/groups", {});
    const g = "/api/v1/groups/{key}";
    await call("GET", g, admin(), `/api/v1/groups/${group}`);
    await call("GET", g, admin(), "/api/v1/groups/missing");
    await call("GET", g, {}, `/api/v1/groups/${group}`);
    await call("PUT", g, admin({ acknowledged: true }), `/api/v1/groups/${group}`);
    await call("PUT", g, admin({ acknowledged: "yes" }), `/api/v1/groups/${group}`);
    await call("PUT", g, admin("nope"), `/api/v1/groups/${group}`);
    await call("PUT", g, admin({ acknowledged: true }), "/api/v1/groups/missing");
    await call("PUT", g, { method: "PUT" }, `/api/v1/groups/${group}`);
    await call("GET", "/api/v1/notifications", admin());
    await call("GET", "/api/v1/notifications", admin(), "/api/v1/notifications?failed=true");
    await call("GET", "/api/v1/notifications", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
  });

  it("silences", async () => {
    const end = new Date(Date.parse("2026-10-28T02:00:00Z") + 3_600_000).toISOString();
    silence = (
      (await call("POST", "/api/v1/silences", admin({ matchers: [{ label: "instance", value: "db-1" }], endsAt: end, comment: "Disk swap" }))).body as {
        id: string;
      }
    ).id;
    await call("POST", "/api/v1/silences", admin({ matchers: [], endsAt: end, comment: "x" }));
    await call("POST", "/api/v1/silences", admin("nope"));
    await call("POST", "/api/v1/silences", { method: "POST" });
    await call("GET", "/api/v1/silences", admin());
    await call("GET", "/api/v1/silences", {});
    await call("DELETE", "/api/v1/silences/{id}", admin(), `/api/v1/silences/${silence}`);
    await call("DELETE", "/api/v1/silences/{id}", admin(), "/api/v1/silences/missing");
    await call("DELETE", "/api/v1/silences/{id}", { method: "DELETE" }, `/api/v1/silences/${silence}`);
  });

  it("refuses to delete what is in use", async () => {
    const c = ((await call("POST", "/api/v1/contact-points", admin({ name: "ops", kind: "webhook", url: `${hook.base}/ops` }))).body as { id: string }).id;
    const s = ((await call("POST", "/api/v1/schedules", admin({ name: "Ops", members: [{ name: "Ada" }] }))).body as { id: string }).id;
    await call("PUT", "/api/v1/routes", admin({ routes: [{ name: "All", contactPointId: c, scheduleId: s }] }));
    await call("DELETE", "/api/v1/contact-points/{id}", admin(), `/api/v1/contact-points/${c}`);
    await call("DELETE", "/api/v1/schedules/{id}", admin(), `/api/v1/schedules/${s}`);
    await call("DELETE", "/api/v1/contact-points/{id}", admin(), "/api/v1/contact-points/missing");
    await call("DELETE", "/api/v1/schedules/{id}", admin(), "/api/v1/schedules/missing");
    await call("DELETE", "/api/v1/contact-points/{id}", { method: "DELETE" }, `/api/v1/contact-points/${c}`);
    await call("DELETE", "/api/v1/schedules/{id}", { method: "DELETE" }, `/api/v1/schedules/${s}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
