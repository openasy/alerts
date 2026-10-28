import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAlerts, DEFAULT_TIMING } from "./alerts.ts";
import { openDb } from "./db.ts";
import { sealer } from "./seal.ts";
import { fakeHook, T0 } from "./test-app.ts";

const MIN = 60_000;
let hook: Awaited<ReturnType<typeof fakeHook>>;
beforeEach(async () => {
  hook = await fakeHook();
});
afterEach(() => hook.close());

function setup() {
  let now = T0;
  const db = openDb(":memory:");
  const a = createAlerts(db, { sealer: sealer(Buffer.alloc(32, 9)), publicUrl: "https://alerts.example.com/", clock: () => now });
  const slack = a.createContactPoint({ name: "db-team", kind: "webhook", url: `${hook.base}/db` });
  const pager = a.createContactPoint({ name: "pager", kind: "webhook", url: `${hook.base}/pager` });
  const later = (ms: number) => (now += ms);
  const fire = (labels: Record<string, string>, extra: Record<string, unknown> = {}) =>
    a.ingest([{ labels, annotations: { summary: `${labels.instance} is full` }, ...extra }]);
  const sent = () => hook.received.map((r) => `${r.path} ${r.body.kind} ${r.body.alerts.length}`);
  return { db, a, slack, pager, later, fire, sent, now: () => now };
}

describe("alerts in", () => {
  it("are kept by their labels, and resolve when no longer sent", () => {
    const { a, fire, later } = setup();
    expect(fire({ alertname: "DiskFull", instance: "db-1" })).toEqual({ received: 1, firing: 1 });
    later(2 * MIN);
    fire({ alertname: "DiskFull", instance: "db-1" });
    const [g] = a.groups();
    expect(g).toMatchObject({ route: null, state: "firing", firing: 1, labels: { alertname: "DiskFull" } });
    expect(g!.alerts[0]!.startsAt).toBe("2026-10-28T02:00:00.000Z");
    later(DEFAULT_TIMING.resolveTimeoutMs + 1);
    expect(a.groups()[0]).toMatchObject({ state: "resolved", firing: 0 });
  });

  it("take Alertmanager's webhook, with a status", () => {
    const { a } = setup();
    a.ingest({ alerts: [{ status: "resolved", labels: { alertname: "X" }, startsAt: "2026-10-28T01:00:00Z", endsAt: "0001-01-01T00:00:00Z" }] });
    expect(a.groups()[0]!.state).toBe("resolved");
  });

  it("refuse what is not an alert, and keep nothing of the call", () => {
    const { a } = setup();
    expect(() => a.ingest({})).toThrow(/list of alerts/);
    expect(() => a.ingest([{ labels: {} }])).toThrow(/at least one label/);
    expect(() => a.ingest([{ labels: { alertname: "ok" } }, { labels: { "bad-name": "x" } }])).toThrow(/not a label name/);
    expect(() => a.ingest([{ labels: { a: "1" }, startsAt: "soon" }])).toThrow(/time/);
    expect(a.groups()).toEqual([]);
  });
});

describe("the notifier", () => {
  it("waits for the group, then tells the route's contact point once, with who is on call", async () => {
    const { a, slack, later, fire, sent } = setup();
    const schedule = a.saveSchedule(null, {
      name: "DB on call",
      members: [{ name: "Ayşe", mention: "U024BE7LH" }, { name: "Can" }],
      shiftHours: 168,
      startsAt: "2026-10-26T09:00:00Z",
    });
    a.replaceRoutes({
      routes: [
        { name: "Database", matchers: [{ label: "team", value: "db" }], groupBy: ["alertname", "team"], contactPointId: slack.id, scheduleId: schedule.id },
      ],
    });
    fire({ alertname: "DiskFull", team: "db", instance: "db-1" });
    expect(await a.tick()).toBe(0);
    later(10_000);
    fire({ alertname: "DiskFull", team: "db", instance: "db-2" });
    later(DEFAULT_TIMING.groupWaitMs);
    expect(await a.tick()).toBe(1);
    expect(await a.tick()).toBe(0);
    expect(sent()).toEqual(["/db firing 2"]);
    expect(hook.received[0]!.body).toMatchObject({ title: "[FIRING:2] DiskFull (team=db)", onCall: { name: "Ayşe", mention: "U024BE7LH" } });
    expect(hook.received[0]!.body.url).toMatch(/^https:\/\/alerts\.example\.com\/groups\/rt_/);
    const g = a.groups()[0]!;
    expect(g).toMatchObject({ route: { name: "Database" }, firing: 2, onCall: { name: "Ayşe" }, notifiedAt: expect.any(String) });
    expect(a.group(g.key).notifications).toEqual([expect.objectContaining({ kind: "firing", ok: true, contactPoint: "db-team", onCall: "Ayşe" })]);
  });

  it("tells of a change after the group interval, repeats until acknowledged, and tells when it resolves", async () => {
    const { a, slack, later, fire, sent } = setup();
    a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id, repeatMinutes: 60 }] });
    fire({ alertname: "DiskFull", instance: "db-1" });
    later(DEFAULT_TIMING.groupWaitMs);
    await a.tick();
    later(MIN);
    fire({ alertname: "DiskFull", instance: "db-1" });
    fire({ alertname: "DiskFull", instance: "db-2" });
    await a.tick();
    expect(sent()).toEqual(["/db firing 1"]);
    later(DEFAULT_TIMING.groupIntervalMs);
    fire({ alertname: "DiskFull", instance: "db-1" });
    fire({ alertname: "DiskFull", instance: "db-2" });
    await a.tick();
    expect(sent().at(-1)).toBe("/db firing 2");
    const key = a.groups()[0]!.key;
    for (const instance of ["db-1", "db-2"]) fire({ alertname: "DiskFull", instance }, { endsAt: new Date(T0 + 3 * 3_600_000).toISOString() });
    later(60 * MIN);
    await a.tick();
    expect(sent().at(-1)).toBe("/db repeat 2");
    a.acknowledge(key, { acknowledged: true }, "Ayşe");
    later(60 * MIN);
    await a.tick();
    expect(sent().at(-1)).toBe("/db repeat 2");
    expect(a.groups()[0]!.acknowledged).toMatchObject({ by: "Ayşe" });
    for (const instance of ["db-1", "db-2"]) fire({ alertname: "DiskFull", instance }, { status: "resolved" });
    await a.tick();
    expect(sent().at(-1)).toBe("/db resolved 2");
    await a.tick();
    expect(sent().filter((s) => s.includes("resolved"))).toHaveLength(1);
  });

  it("escalates once when nobody acknowledges in time", async () => {
    const { a, slack, pager, later, fire, sent } = setup();
    a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id, escalateMinutes: 15, escalateContactPointId: pager.id }] });
    fire({ alertname: "Down", instance: "api" }, { endsAt: new Date(T0 + 3_600_000).toISOString() });
    later(DEFAULT_TIMING.groupWaitMs);
    await a.tick();
    later(15 * MIN);
    await a.tick();
    await a.tick();
    expect(sent()).toEqual(["/db firing 1", "/pager escalation 1"]);
  });

  it("holds back silenced alerts, and tells nobody of a silenced group", async () => {
    const { a, slack, later, fire, sent } = setup();
    a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id }] });
    const s = a.createSilence(
      { matchers: [{ label: "instance", value: "db-9" }], endsAt: new Date(T0 + 2 * 3_600_000).toISOString(), comment: "Disk swap" },
      "Can",
    );
    expect(s).toMatchObject({ state: "active", createdBy: "Can" });
    fire({ alertname: "DiskFull", instance: "db-9" });
    later(DEFAULT_TIMING.groupWaitMs);
    await a.tick();
    expect(sent()).toEqual([]);
    expect(a.groups()[0]).toMatchObject({ state: "silenced", alerts: [expect.objectContaining({ state: "silenced", silencedBy: [s.id] })] });
    expect(a.silences()[0]!.silenced).toBe(1);
    a.expireSilence(s.id);
    expect(a.silences()[0]!.state).toBe("expired");
    await a.tick();
    expect(sent()).toEqual(["/db firing 1"]);
  });

  it("keeps a failure, and says why", async () => {
    const { a, slack, later, fire } = setup();
    a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id }] });
    hook.fail(500);
    fire({ alertname: "X" });
    later(DEFAULT_TIMING.groupWaitMs);
    await a.tick();
    expect(a.notifications({ ok: false })).toEqual([expect.objectContaining({ ok: false, error: "The contact point answered 500." })]);
    expect(a.summary().notifications.failedLastDay).toBe(1);
    expect(a.contactPoints().find((c) => c.id === slack.id)!.lastSent).toMatchObject({ ok: false });
  });

  it("leaves alerts no route takes unrouted, told to nobody", async () => {
    const { a, slack, later, fire, sent } = setup();
    a.replaceRoutes({ routes: [{ name: "DB", matchers: [{ label: "team", value: "db" }], contactPointId: slack.id }] });
    fire({ alertname: "Other", team: "web" });
    later(DEFAULT_TIMING.groupWaitMs);
    await a.tick();
    expect(sent()).toEqual([]);
    expect(a.summary().groups.unrouted).toBe(1);
  });
});

describe("configuration", () => {
  it("keeps a contact point's address secret", () => {
    const { a, db } = setup();
    const c = a.createContactPoint({ name: "Slack", kind: "slack", url: "https://hooks.slack.com/services/T000/B000/XXXXSECRET" });
    expect(c.target).toBe("hooks.slack.com/services/…");
    expect(JSON.stringify(db.prepare("SELECT url FROM contact_points WHERE id = ?").get(c.id))).not.toContain("SECRET");
    expect(() => a.createContactPoint({ name: "Slack", kind: "slack", url: "https://hooks.slack.com/x" })).toThrow(/exists/);
    expect(() => a.createContactPoint({ name: "Plain", kind: "slack", url: "http://hooks.slack.com/x" })).toThrow(/https/);
    expect(() => a.createContactPoint({ name: "Mail", kind: "email", url: "https://x" })).toThrow(/kind/);
  });

  it("will not delete what a route uses", () => {
    const { a, slack } = setup();
    const s = a.saveSchedule(null, { name: "Ops", members: [{ name: "Ada" }] });
    a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id, scheduleId: s.id }] });
    expect(() => a.deleteContactPoint(slack.id)).toThrow(/route All/);
    expect(() => a.deleteSchedule(s.id)).toThrow(/route All/);
    a.replaceRoutes({ routes: [] });
    a.deleteSchedule(s.id);
    a.deleteContactPoint(slack.id);
  });

  it("checks routes and keeps their ids when they are sent again", () => {
    const { a, slack, pager } = setup();
    const [r] = a.replaceRoutes({ routes: [{ name: "All", contactPointId: slack.id }] });
    expect(r).toMatchObject({ groupBy: ["alertname"], repeatMinutes: 240, escalateMinutes: null, matchers: [] });
    expect(a.replaceRoutes({ routes: [{ ...r, name: "Everything" }] })[0]!.id).toBe(r!.id);
    expect(() => a.replaceRoutes({ routes: [{ name: "x", contactPointId: "nope" }] })).toThrow(/contact point/);
    expect(() => a.replaceRoutes({ routes: [{ name: "x", contactPointId: slack.id, escalateMinutes: 10 }] })).toThrow(/go together/);
    expect(() => a.replaceRoutes({ routes: [{ name: "x", contactPointId: slack.id, matchers: [{ label: "a", op: "=~", value: "(" }] }] })).toThrow(/regular/);
    expect(a.replaceRoutes({ routes: [{ name: "x", contactPointId: slack.id, escalateMinutes: 10, escalateContactPointId: pager.id }] })[0]).toMatchObject({
      escalateMinutes: 10,
    });
  });

  it("refuses silences that would hide everything or never end", () => {
    const { a } = setup();
    const end = new Date(T0 + 3_600_000).toISOString();
    expect(() => a.createSilence({ matchers: [], endsAt: end, comment: "x" }, "Ada")).toThrow(/at least one matcher/);
    expect(() => a.createSilence({ matchers: [{ label: "alertname", op: "=~", value: ".*" }], endsAt: end, comment: "x" }, "Ada")).toThrow(/every alert/);
    expect(() => a.createSilence({ matchers: [{ label: "a", value: "b" }], comment: "x" }, "Ada")).toThrow(/always ends/);
    expect(() =>
      a.createSilence({ matchers: [{ label: "a", value: "b" }], endsAt: new Date(T0 + 40 * 86_400_000).toISOString(), comment: "x" }, "Ada"),
    ).toThrow(/30 days/);
    expect(() => a.createSilence({ matchers: [{ label: "a", value: "b" }], endsAt: end }, "Ada")).toThrow(/comment/);
  });

  it("knows who is on call, and the next shifts", () => {
    const { a, later } = setup();
    const s = a.saveSchedule(null, {
      name: "Ops",
      members: [{ name: "Ada" }, { name: "Ben" }, { name: "Can" }],
      shiftHours: 24,
      startsAt: "2026-10-27T09:00:00Z",
    });
    expect(s.onCall?.name).toBe("Ada");
    expect(s.shifts.map((x) => `${x.member.name} ${x.from}`)).toEqual([
      "Ada 2026-10-27T09:00:00.000Z",
      "Ben 2026-10-28T09:00:00.000Z",
      "Can 2026-10-29T09:00:00.000Z",
    ]);
    later(8 * 3_600_000);
    expect(a.schedules()[0]!.onCall?.name).toBe("Ben");
    expect(() => a.saveSchedule(null, { name: "Empty", members: [] })).toThrow(/members/);
    expect(() => a.saveSchedule(null, { name: "Bad", members: [{ name: "x", mention: "@ada" }] })).toThrow(/Slack/);
    expect(() => a.saveSchedule("missing", { name: "x", members: [{ name: "x" }] })).toThrow(/does not exist/);
  });

  it("sends a test to a contact point", async () => {
    const { a, slack } = setup();
    expect(await a.testContactPoint(slack.id)).toEqual({ ok: true, error: null });
    expect(hook.received[0]!.body).toMatchObject({ kind: "test", title: "[TEST] Test" });
  });
});
