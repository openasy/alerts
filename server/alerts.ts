import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fingerprint, matches, parseMatchers, type Labels, type Matcher } from "./match.ts";
import { send, type ContactKind, type Message, type NotificationKind } from "./notify.ts";
import type { Sealer } from "./seal.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "not-configured" | "payload-too-large" | "internal-error";

export class AlertsError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const bad = (detail: string) => new AlertsError(422, "invalid-body", detail);
const notFound = (what: string) => new AlertsError(404, "not-found", `${what} does not exist.`);
const conflict = (detail: string) => new AlertsError(409, "conflict", detail);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A resolved alert stays on the screens this long, then only its notifications are kept. */
const RESOLVED_SHOWN_MS = HOUR;

export interface Timing {
  /** Wait this long after a group's first alert, so alerts of the same problem go out together. */
  groupWaitMs: number;
  /** Tell of a change to a group at most this often. */
  groupIntervalMs: number;
  /** An alert sent without an end resolves this long after it was last sent. */
  resolveTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = { groupWaitMs: 30_000, groupIntervalMs: 5 * MINUTE, resolveTimeoutMs: 5 * MINUTE };

export interface Member {
  name: string;
  /** A Slack user or group id such as U024BE7LH, to mention them; empty for none. */
  mention: string;
}

export interface Schedule {
  id: string;
  name: string;
  members: Member[];
  shiftHours: number;
  startsAt: string;
  onCall: Member | null;
  /** The next shifts, from the one now. */
  shifts: Array<{ member: Member; from: string; to: string }>;
}

export interface ContactPoint {
  id: string;
  name: string;
  kind: ContactKind;
  /** Where it posts, without the secret part: the host and the start of the path. */
  target: string;
  createdAt: string;
  lastSent: { at: string; ok: boolean; error: string | null } | null;
}

export interface Route {
  id: string;
  name: string;
  matchers: Matcher[];
  groupBy: string[];
  contactPointId: string;
  scheduleId: string | null;
  repeatMinutes: number;
  escalateMinutes: number | null;
  escalateContactPointId: string | null;
}

export interface Silence {
  id: string;
  matchers: Matcher[];
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
  createdAt: string;
  state: "active" | "pending" | "expired";
  /** Alerts it silences now. */
  silenced: number;
}

export type AlertState = "firing" | "silenced" | "resolved";

export interface Alert {
  fingerprint: string;
  labels: Labels;
  annotations: Labels;
  startsAt: string;
  endsAt: string;
  generatorUrl: string;
  state: AlertState;
  silencedBy: string[];
}

export interface Group {
  key: string;
  route: { id: string; name: string } | null;
  labels: Labels;
  state: AlertState;
  alerts: Alert[];
  firing: number;
  firstAt: string;
  notifiedAt: string | null;
  acknowledged: { by: string; at: string } | null;
  escalatedAt: string | null;
  onCall: Member | null;
}

export interface Notification {
  id: number;
  groupKey: string;
  contactPoint: string;
  kind: NotificationKind;
  at: string;
  ok: boolean;
  error: string | null;
  onCall: string | null;
}

export interface AlertsOptions {
  sealer: Sealer;
  /** The address people open Alerts at, for the link in each notification. */
  publicUrl: string;
  timing?: Partial<Timing>;
  clock?: () => number;
  fetch?: typeof fetch;
  retentionDays?: number;
}

type Row = Record<string, SQLInputValue>;

const text = (v: unknown, name: string, max: number, required = true): string => {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${name} is required.`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const t = v.trim();
  if (required && !t) throw bad(`${name} is required.`);
  if (t.length > max) throw bad(`${name} is at most ${max} characters.`);
  return t;
};

const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function labelsOf(v: unknown, name: string, required: boolean): Labels {
  if (v === undefined && !required) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${name} must be an object of label names and text values.`);
  const out: Labels = {};
  for (const [k, x] of Object.entries(v)) {
    if (!LABEL.test(k)) throw bad(`${name}: ${k} is not a label name.`);
    if (typeof x !== "string") throw bad(`${name}.${k} must be text.`);
    if (x.length > 4000) throw bad(`${name}.${k} is at most 4000 characters.`);
    if (x !== "") out[k] = x;
  }
  if (required && !Object.keys(out).length) throw bad(`${name} needs at least one label, such as alertname.`);
  return out;
}

function time(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "" || v === "0001-01-01T00:00:00Z") return undefined;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw bad(`${name} must be a time, such as 2026-10-28T02:00:00Z.`);
  return t;
}

/** The contact point's address without its secret, which sits in the path or query of a webhook. */
function target(url: string): string {
  const u = new URL(url);
  const first = u.pathname.split("/").filter(Boolean)[0];
  return `${u.host}${first ? `/${first}/…` : ""}`;
}

export function createAlerts(db: DatabaseSync, { sealer, publicUrl, timing: t, clock = Date.now, fetch: http = fetch, retentionDays = 90 }: AlertsOptions) {
  const timing = { ...DEFAULT_TIMING, ...t };
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const page = publicUrl.replace(/\/$/, "");

  // ---------------------------------------------------------------- reading the configuration

  const routeRows = () => db.prepare("SELECT * FROM routes ORDER BY position").all() as Row[];
  const toRoute = (r: Row): Route => ({
    id: r.id as string,
    name: r.name as string,
    matchers: JSON.parse(r.matchers as string) as Matcher[],
    groupBy: JSON.parse(r.group_by as string) as string[],
    contactPointId: r.contact_point_id as string,
    scheduleId: (r.schedule_id as string | null) ?? null,
    repeatMinutes: Number(r.repeat_minutes),
    escalateMinutes: r.escalate_minutes === null ? null : Number(r.escalate_minutes),
    escalateContactPointId: (r.escalate_contact_point_id as string | null) ?? null,
  });

  function onCallOf(members: Member[], shiftHours: number, startsAt: string, at: number): { member: Member; index: number; from: number } | null {
    const start = Date.parse(startsAt);
    if (!members.length || at < start) return null;
    const shift = Math.floor((at - start) / (shiftHours * HOUR));
    return { member: members[shift % members.length]!, index: shift, from: start + shift * shiftHours * HOUR };
  }

  function toSchedule(r: Row): Schedule {
    const members = JSON.parse(r.members as string) as Member[];
    const shiftHours = Number(r.shift_hours);
    const now = clock();
    const current = onCallOf(members, shiftHours, r.starts_at as string, now);
    const start = Date.parse(r.starts_at as string);
    const firstFrom = current ? current.from : start;
    const shifts = members.length
      ? Array.from({ length: Math.min(6, Math.max(members.length, 3)) }, (_, i) => {
          const from = firstFrom + i * shiftHours * HOUR;
          const index = Math.floor((from - start) / (shiftHours * HOUR));
          return { member: members[((index % members.length) + members.length) % members.length]!, from: iso(from), to: iso(from + shiftHours * HOUR) };
        })
      : [];
    return { id: r.id as string, name: r.name as string, members, shiftHours, startsAt: r.starts_at as string, onCall: current?.member ?? null, shifts };
  }

  function silenceRows(): Array<Silence & { active: boolean }> {
    const now = iso();
    return (db.prepare("SELECT * FROM silences ORDER BY ends_at DESC").all() as Row[]).map((r) => {
      const starts = r.starts_at as string;
      const ends = r.ends_at as string;
      const state = ends <= now ? "expired" : starts > now ? "pending" : "active";
      return {
        id: r.id as string,
        matchers: JSON.parse(r.matchers as string) as Matcher[],
        startsAt: starts,
        endsAt: ends,
        comment: r.comment as string,
        createdBy: r.created_by as string,
        createdAt: r.created_at as string,
        state,
        silenced: 0,
        active: state === "active",
      };
    });
  }

  /** The alerts to show: firing, and resolved in the last hour. */
  function alertRows(): Array<Omit<Alert, "state" | "silencedBy"> & { firing: boolean }> {
    const now = clock();
    return (db.prepare("SELECT * FROM alerts WHERE ends_at > ? ORDER BY starts_at DESC").all(iso(now - RESOLVED_SHOWN_MS)) as Row[]).map((r) => ({
      fingerprint: r.fingerprint as string,
      labels: JSON.parse(r.labels as string) as Labels,
      annotations: JSON.parse(r.annotations as string) as Labels,
      startsAt: r.starts_at as string,
      endsAt: r.ends_at as string,
      generatorUrl: r.generator_url as string,
      firing: Date.parse(r.ends_at as string) > now,
    }));
  }

  /** Every alert shown, in its group: by the first route that takes it and the values of that route's group labels. */
  function grouped(): Array<Group & { route: Route | null }> {
    const routes = routeRows().map(toRoute);
    const silences = silenceRows().filter((s) => s.active);
    const schedules = new Map((db.prepare("SELECT * FROM schedules").all() as Row[]).map((r) => [r.id as string, r]));
    const states = new Map((db.prepare("SELECT * FROM groups").all() as Row[]).map((r) => [r.key as string, r]));
    const groups = new Map<string, Group & { route: Route | null }>();
    for (const a of alertRows()) {
      const route = routes.find((r) => matches(r.matchers, a.labels)) ?? null;
      const groupLabels: Labels = {};
      for (const k of route?.groupBy ?? ["alertname"]) if (a.labels[k] !== undefined) groupLabels[k] = a.labels[k]!;
      const key = `${route ? route.id : "unrouted"}-${fingerprint(groupLabels)}`;
      const silencedBy = silences.filter((s) => matches(s.matchers, a.labels)).map((s) => s.id);
      const alert: Alert = { ...a, state: !a.firing ? "resolved" : silencedBy.length ? "silenced" : "firing", silencedBy };
      let g = groups.get(key);
      if (!g) {
        const st = states.get(key);
        const sch = route?.scheduleId ? schedules.get(route.scheduleId) : undefined;
        g = {
          key,
          route,
          labels: groupLabels,
          state: "resolved",
          alerts: [],
          firing: 0,
          firstAt: (st?.first_at as string | undefined) ?? a.startsAt,
          notifiedAt: (st?.notified_at as string | undefined) ?? null,
          acknowledged: st?.acked_by ? { by: st.acked_by as string, at: st.acked_at as string } : null,
          escalatedAt: (st?.escalated_at as string | undefined) ?? null,
          onCall: sch
            ? (onCallOf(JSON.parse(sch.members as string) as Member[], Number(sch.shift_hours), sch.starts_at as string, clock())?.member ?? null)
            : null,
        };
        groups.set(key, g);
      }
      g.alerts.push(alert);
    }
    for (const g of groups.values()) {
      g.firing = g.alerts.filter((a) => a.state === "firing").length;
      g.state = g.firing ? "firing" : g.alerts.some((a) => a.state === "silenced") ? "silenced" : "resolved";
    }
    return [...groups.values()].sort((a, b) =>
      a.state === b.state ? b.firstAt.localeCompare(a.firstAt) : a.state === "firing" ? -1 : b.state === "firing" ? 1 : 0,
    );
  }

  const publicGroup = (g: Group & { route: Route | null }): Group => ({ ...g, route: g.route ? { id: g.route.id, name: g.route.name } : null });

  function contactRow(id: string): Row {
    const r = db.prepare("SELECT * FROM contact_points WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("The contact point");
    return r;
  }

  async function notify(g: Group & { route: Route | null }, contactId: string, kind: NotificationKind): Promise<boolean> {
    const cp = contactRow(contactId);
    const message: Message = {
      kind,
      group: { key: g.key, labels: g.labels },
      alerts: g.alerts
        .filter((a) => (kind === "resolved" ? true : a.state === "firing"))
        .map((a) => ({ labels: a.labels, annotations: a.annotations, startsAt: a.startsAt, endsAt: a.endsAt, firing: a.state === "firing" })),
      onCall: g.onCall ? { name: g.onCall.name, ...(g.onCall.mention && { mention: g.onCall.mention }) } : null,
      url: `${page}/groups/${encodeURIComponent(g.key)}`,
    };
    let error: string | null = null;
    try {
      await send(cp.kind as ContactKind, sealer.open(cp.url as string), message, http);
    } catch (err) {
      error = ((err as Error).name === "TimeoutError" ? "The contact point did not answer in 10 seconds." : (err as Error).message).slice(0, 300);
    }
    db.prepare("INSERT INTO notifications (group_key, contact_point_id, kind, at, ok, error, on_call) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      g.key,
      contactId,
      kind,
      iso(),
      error ? 0 : 1,
      error,
      g.onCall?.name ?? null,
    );
    return !error;
  }

  return {
    // ---------------------------------------------------------------- alerts in

    /**
     * Takes alerts as Prometheus sends them to an Alertmanager: [{ labels, annotations, startsAt, endsAt,
     * generatorURL }], or an Alertmanager webhook's { alerts: [...] } with a status. An alert sent again updates the
     * one with the same labels. One without an end resolves when it is not sent again for the resolve timeout.
     */
    ingest(body: unknown): { received: number; firing: number } {
      const list = Array.isArray(body)
        ? body
        : body && typeof body === "object" && Array.isArray((body as { alerts?: unknown }).alerts)
          ? (body as { alerts: unknown[] }).alerts
          : null;
      if (!list) throw bad("Send a list of alerts, or { alerts: [...] }.");
      if (list.length > 10_000) throw bad("Send at most 10,000 alerts at a time.");
      const now = clock();
      const items = list.map((x, i) => {
        if (!x || typeof x !== "object") throw bad(`alerts[${i}] must be an object.`);
        const a = x as Record<string, unknown>;
        const labels = labelsOf(a.labels, `alerts[${i}].labels`, true);
        const annotations = labelsOf(a.annotations, `alerts[${i}].annotations`, false);
        const startsAt = time(a.startsAt, `alerts[${i}].startsAt`) ?? now;
        let endsAt = time(a.endsAt, `alerts[${i}].endsAt`);
        if (a.status === "resolved" && (endsAt === undefined || endsAt > now)) endsAt = now;
        const generatorUrl = typeof a.generatorURL === "string" ? a.generatorURL.slice(0, 2000) : "";
        return { labels, annotations, startsAt, endsAt: endsAt ?? now + timing.resolveTimeoutMs, generatorUrl };
      });
      db.exec("BEGIN");
      try {
        for (const a of items) {
          const fp = fingerprint(a.labels);
          const cur = db.prepare("SELECT starts_at, ends_at FROM alerts WHERE fingerprint = ?").get(fp) as Row | undefined;
          // While it still fires it keeps its first start; once resolved, a new send is a new occurrence.
          const stillFiring = cur && Date.parse(cur.ends_at as string) > now;
          const startsAt = stillFiring ? (cur.starts_at as string) : iso(a.startsAt);
          db.prepare(
            "INSERT INTO alerts (fingerprint, labels, annotations, starts_at, ends_at, updated_at, generator_url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET labels = excluded.labels, annotations = excluded.annotations, starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at, generator_url = excluded.generator_url",
          ).run(fp, JSON.stringify(a.labels), JSON.stringify(a.annotations), startsAt, iso(a.endsAt), iso(now), a.generatorUrl);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { received: items.length, firing: items.filter((a) => a.endsAt > now).length };
    },

    // ---------------------------------------------------------------- groups

    groups(state?: string | null): Group[] {
      if (state && !["firing", "silenced", "resolved"].includes(state)) throw bad("state is firing, silenced or resolved.");
      return grouped()
        .filter((g) => !state || g.state === state)
        .map(publicGroup);
    },

    group(key: string): Group & { notifications: Notification[] } {
      const g = grouped().find((x) => x.key === key);
      if (!g) throw notFound("The group");
      return { ...publicGroup(g), notifications: this.notifications({ group: key }, 50) };
    },

    /** Someone is on it: repeats and escalation stop until the group changes. */
    acknowledge(key: string, body: Record<string, unknown>, actor: string): Group {
      const g = grouped().find((x) => x.key === key);
      if (!g) throw notFound("The group");
      if (typeof body.acknowledged !== "boolean") throw bad("acknowledged must be true or false.");
      db.prepare("INSERT INTO groups (key, route_id, labels, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(
        key,
        g.route?.id ?? "",
        JSON.stringify(g.labels),
        g.firstAt,
      );
      db.prepare("UPDATE groups SET acked_by = ?, acked_at = ? WHERE key = ?").run(body.acknowledged ? actor : null, body.acknowledged ? iso() : null, key);
      return publicGroup(grouped().find((x) => x.key === key)!);
    },

    /**
     * One turn of the notifier. A group is told of when it first fires (after the group wait), when its firing alerts
     * change (at most every group interval), again every repeat interval until someone acknowledges it, to the
     * escalation contact once nobody has after the escalation time, and when it resolves.
     */
    async tick(): Promise<number> {
      const now = clock();
      let sent = 0;
      for (const g of grouped()) {
        if (!g.route) continue;
        const firing = g.alerts.filter((a) => a.state === "firing");
        const hash = firing
          .map((a) => a.fingerprint)
          .sort()
          .join(",");
        // The group wait counts from its earliest firing alert, so alerts that fired before a restart go out at once.
        if (firing.length)
          db.prepare("INSERT INTO groups (key, route_id, labels, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(
            g.key,
            g.route.id,
            JSON.stringify(g.labels),
            iso(Math.min(now, ...firing.map((a) => Date.parse(a.startsAt)))),
          );
        const st = db.prepare("SELECT * FROM groups WHERE key = ?").get(g.key) as Row | undefined;
        if (!st) continue;
        const notifiedAt = st.notified_at ? Date.parse(st.notified_at as string) : null;
        const lastHash = (st.notified_hash as string | null) ?? null;
        if (firing.length) {
          let kind: NotificationKind | null = null;
          if (lastHash === null) {
            if (now - Date.parse(st.first_at as string) >= timing.groupWaitMs) kind = "firing";
          } else if (hash !== lastHash) {
            if (notifiedAt === null || now - notifiedAt >= timing.groupIntervalMs) kind = "firing";
          } else if (!st.acked_by && notifiedAt !== null && now - notifiedAt >= g.route.repeatMinutes * MINUTE) kind = "repeat";
          if (kind) {
            // A new alert in the group needs a new acknowledgement.
            const added = lastHash !== null && hash.split(",").some((f) => !lastHash.split(",").includes(f));
            if (await notify(g, g.route.contactPointId, kind)) sent++;
            db.prepare(
              "UPDATE groups SET notified_hash = ?, notified_at = ?, acked_by = CASE WHEN ? THEN NULL ELSE acked_by END, acked_at = CASE WHEN ? THEN NULL ELSE acked_at END WHERE key = ?",
            ).run(hash, iso(now), added ? 1 : 0, added ? 1 : 0, g.key);
          }
          const fresh = db.prepare("SELECT * FROM groups WHERE key = ?").get(g.key) as Row;
          if (
            g.route.escalateMinutes !== null &&
            g.route.escalateContactPointId &&
            fresh.notified_at &&
            !fresh.acked_by &&
            !fresh.escalated_at &&
            now - Date.parse(fresh.first_at as string) >= g.route.escalateMinutes * MINUTE
          ) {
            if (await notify(g, g.route.escalateContactPointId, "escalation")) sent++;
            db.prepare("UPDATE groups SET escalated_at = ? WHERE key = ?").run(iso(now), g.key);
          }
        } else if (lastHash !== null && g.state === "resolved") {
          // Told of while it fired, so told when it ends; a silence alone ends nothing.
          if (await notify(g, g.route.contactPointId, "resolved")) sent++;
          // A new firing starts over: a new wait, acknowledgement and escalation.
          db.prepare("DELETE FROM groups WHERE key = ?").run(g.key);
        }
      }
      return sent;
    },

    // ---------------------------------------------------------------- contact points

    contactPoints(): ContactPoint[] {
      return (db.prepare("SELECT * FROM contact_points ORDER BY name").all() as Row[]).map((r) => {
        const last = db.prepare("SELECT at, ok, error FROM notifications WHERE contact_point_id = ? ORDER BY id DESC LIMIT 1").get(r.id as string) as
          Row | undefined;
        return {
          id: r.id as string,
          name: r.name as string,
          kind: r.kind as ContactKind,
          target: target(sealer.open(r.url as string)),
          createdAt: r.created_at as string,
          lastSent: last ? { at: last.at as string, ok: last.ok === 1, error: (last.error as string | null) ?? null } : null,
        };
      });
    },

    createContactPoint(body: Record<string, unknown>): ContactPoint {
      const name = text(body.name, "name", 80);
      const kind = body.kind;
      if (kind !== "slack" && kind !== "teams" && kind !== "webhook") throw bad("kind is slack, teams or webhook.");
      const url = text(body.url, "url", 2000);
      if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw bad("url must be an http(s) address.");
      if (kind !== "webhook" && new URL(url).protocol !== "https:") throw bad("A Slack or Teams webhook is an https:// address.");
      const id = `cp_${randomUUID().slice(0, 12)}`;
      try {
        db.prepare("INSERT INTO contact_points (id, name, kind, url, created_at) VALUES (?, ?, ?, ?, ?)").run(id, name, kind, sealer.seal(url), iso());
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw conflict("A contact point with this name exists.");
        throw err;
      }
      return this.contactPoints().find((c) => c.id === id)!;
    },

    deleteContactPoint(id: string): void {
      contactRow(id);
      const used = db.prepare("SELECT name FROM routes WHERE contact_point_id = ? OR escalate_contact_point_id = ? LIMIT 1").get(id, id) as Row | undefined;
      if (used) throw conflict(`The route ${used.name as string} sends to it: change the route first.`);
      db.prepare("DELETE FROM notifications WHERE contact_point_id = ?").run(id);
      db.prepare("DELETE FROM contact_points WHERE id = ?").run(id);
    },

    /** Sends a test message, so a wrong webhook shows now rather than at 02:00. */
    async testContactPoint(id: string): Promise<{ ok: boolean; error: string | null }> {
      contactRow(id);
      const g = {
        key: "test",
        route: null,
        labels: { alertname: "Test" },
        state: "firing" as const,
        alerts: [
          {
            fingerprint: "test",
            labels: { alertname: "Test" },
            annotations: { summary: "A test from OpenAsy Alerts: this contact point works." },
            startsAt: iso(),
            endsAt: iso(),
            generatorUrl: "",
            state: "firing" as const,
            silencedBy: [],
          },
        ],
        firing: 1,
        firstAt: iso(),
        notifiedAt: null,
        acknowledged: null,
        escalatedAt: null,
        onCall: null,
      };
      const ok = await notify(g, id, "test");
      const last = db.prepare("SELECT error FROM notifications WHERE contact_point_id = ? ORDER BY id DESC LIMIT 1").get(id) as Row;
      return { ok, error: (last.error as string | null) ?? null };
    },

    // ---------------------------------------------------------------- schedules

    schedules(): Schedule[] {
      return (db.prepare("SELECT * FROM schedules ORDER BY name").all() as Row[]).map(toSchedule);
    },

    saveSchedule(id: string | null, body: Record<string, unknown>): Schedule {
      if (id && !db.prepare("SELECT 1 FROM schedules WHERE id = ?").get(id)) throw notFound("The schedule");
      const name = text(body.name, "name", 80);
      if (!Array.isArray(body.members) || !body.members.length || body.members.length > 50) throw bad("members is a list of 1 to 50 people.");
      const members = body.members.map((m, i) => {
        const x = (m ?? {}) as Record<string, unknown>;
        const mention = text(x.mention, `members[${i}].mention`, 40, false);
        if (mention && !/^[A-Z0-9]+$/.test(mention)) throw bad(`members[${i}].mention is a Slack user or group id, such as U024BE7LH.`);
        return { name: text(x.name, `members[${i}].name`, 80), mention };
      });
      const shiftHours = body.shiftHours ?? 168;
      if (!Number.isInteger(shiftHours) || (shiftHours as number) < 1 || (shiftHours as number) > 24 * 28)
        throw bad("shiftHours is a whole number of hours, 1 to 672.");
      const startsAt = time(body.startsAt, "startsAt") ?? clock();
      const sid = id ?? `sc_${randomUUID().slice(0, 12)}`;
      try {
        db.prepare(
          "INSERT INTO schedules (id, name, members, shift_hours, starts_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, members = excluded.members, shift_hours = excluded.shift_hours, starts_at = excluded.starts_at",
        ).run(sid, name, JSON.stringify(members), shiftHours as number, iso(startsAt));
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw conflict("A schedule with this name exists.");
        throw err;
      }
      return toSchedule(db.prepare("SELECT * FROM schedules WHERE id = ?").get(sid) as Row);
    },

    deleteSchedule(id: string): void {
      if (!db.prepare("SELECT 1 FROM schedules WHERE id = ?").get(id)) throw notFound("The schedule");
      const used = db.prepare("SELECT name FROM routes WHERE schedule_id = ? LIMIT 1").get(id) as Row | undefined;
      if (used) throw conflict(`The route ${used.name as string} uses it: change the route first.`);
      db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    },

    // ---------------------------------------------------------------- routes

    routes(): Route[] {
      return routeRows().map(toRoute);
    },

    /** Replaces every route, in order: the first that matches an alert takes it. */
    replaceRoutes(body: Record<string, unknown>): Route[] {
      if (!Array.isArray(body.routes) || body.routes.length > 200) throw bad("routes is a list of at most 200 routes.");
      const contacts = new Set((db.prepare("SELECT id FROM contact_points").all() as Row[]).map((r) => r.id as string));
      const schedules = new Set((db.prepare("SELECT id FROM schedules").all() as Row[]).map((r) => r.id as string));
      const old = new Set(routeRows().map((r) => r.id as string));
      const routes = body.routes.map((raw, i) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        let matchers: Matcher[];
        try {
          matchers = parseMatchers(r.matchers ?? [], `routes[${i}].matchers`);
        } catch (err) {
          throw bad((err as Error).message);
        }
        const groupBy = r.groupBy ?? ["alertname"];
        if (!Array.isArray(groupBy) || groupBy.length > 10 || groupBy.some((g) => typeof g !== "string" || !LABEL.test(g)))
          throw bad(`routes[${i}].groupBy is a list of at most 10 label names.`);
        if (typeof r.contactPointId !== "string" || !contacts.has(r.contactPointId)) throw bad(`routes[${i}].contactPointId must name a contact point.`);
        const scheduleId = r.scheduleId ?? null;
        if (scheduleId !== null && (typeof scheduleId !== "string" || !schedules.has(scheduleId))) throw bad(`routes[${i}].scheduleId must name a schedule.`);
        const repeat = r.repeatMinutes ?? 240;
        if (!Number.isInteger(repeat) || (repeat as number) < 5 || (repeat as number) > 10_080) throw bad(`routes[${i}].repeatMinutes is 5 to 10080.`);
        const escalate = r.escalateMinutes ?? null;
        const escalateTo = r.escalateContactPointId ?? null;
        if (escalate !== null && (!Number.isInteger(escalate) || (escalate as number) < 1 || (escalate as number) > 1440))
          throw bad(`routes[${i}].escalateMinutes is 1 to 1440.`);
        if ((escalate === null) !== (escalateTo === null)) throw bad(`routes[${i}]: escalateMinutes and escalateContactPointId go together.`);
        if (escalateTo !== null && (typeof escalateTo !== "string" || !contacts.has(escalateTo)))
          throw bad(`routes[${i}].escalateContactPointId must name a contact point.`);
        const id = typeof r.id === "string" && old.has(r.id) ? r.id : `rt_${randomUUID().slice(0, 12)}`;
        return {
          id,
          name: text(r.name, `routes[${i}].name`, 80),
          matchers,
          groupBy: groupBy as string[],
          contactPointId: r.contactPointId,
          scheduleId: scheduleId as string | null,
          repeatMinutes: repeat as number,
          escalateMinutes: escalate as number | null,
          escalateContactPointId: escalateTo as string | null,
        };
      });
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM routes");
        routes.forEach((r, i) =>
          db
            .prepare(
              "INSERT INTO routes (id, position, name, matchers, group_by, contact_point_id, schedule_id, repeat_minutes, escalate_minutes, escalate_contact_point_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              r.id,
              i,
              r.name,
              JSON.stringify(r.matchers),
              JSON.stringify(r.groupBy),
              r.contactPointId,
              r.scheduleId,
              r.repeatMinutes,
              r.escalateMinutes,
              r.escalateContactPointId,
            ),
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return this.routes();
    },

    // ---------------------------------------------------------------- silences

    silences(): Silence[] {
      const alerts = alertRows().filter((a) => a.firing);
      return silenceRows().map(({ active, ...s }) => ({ ...s, silenced: active ? alerts.filter((a) => matches(s.matchers, a.labels)).length : 0 }));
    },

    createSilence(body: Record<string, unknown>, actor: string): Silence {
      let matchers: Matcher[];
      try {
        matchers = parseMatchers(body.matchers);
      } catch (err) {
        throw bad((err as Error).message);
      }
      if (!matchers.length) throw bad("A silence needs at least one matcher: one with none would silence everything.");
      if (matchers.every((m) => (m.op === "=~" && /^\.[*+]$/.test(m.value)) || (m.op === "!=" && m.value === "")))
        throw bad("These matchers silence every alert: name what the maintenance is about.");
      const now = clock();
      const startsAt = time(body.startsAt, "startsAt") ?? now;
      const endsAt = time(body.endsAt, "endsAt");
      if (endsAt === undefined) throw bad("endsAt is required: a silence always ends.");
      if (endsAt <= Math.max(startsAt, now)) throw bad("endsAt must be after startsAt and in the future.");
      if (endsAt - startsAt > 30 * 24 * HOUR) throw bad("A silence lasts at most 30 days.");
      const id = `si_${randomUUID().slice(0, 12)}`;
      db.prepare("INSERT INTO silences (id, matchers, starts_at, ends_at, comment, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        JSON.stringify(matchers),
        iso(startsAt),
        iso(endsAt),
        text(body.comment, "comment", 500),
        actor,
        iso(now),
      );
      return this.silences().find((s) => s.id === id)!;
    },

    /** Ends a silence now; it stays in the list as expired. */
    expireSilence(id: string): void {
      const r = db.prepare("SELECT ends_at FROM silences WHERE id = ?").get(id) as Row | undefined;
      if (!r) throw notFound("The silence");
      if ((r.ends_at as string) > iso()) db.prepare("UPDATE silences SET ends_at = ?, starts_at = MIN(starts_at, ?) WHERE id = ?").run(iso(), iso(), id);
    },

    // ---------------------------------------------------------------- history and overview

    notifications(filter: { group?: string | null; ok?: boolean } = {}, limit = 100): Notification[] {
      const where: string[] = [];
      const args: SQLInputValue[] = [];
      if (filter.group) (where.push("n.group_key = ?"), args.push(filter.group));
      if (filter.ok !== undefined) (where.push("n.ok = ?"), args.push(filter.ok ? 1 : 0));
      return (
        db
          .prepare(
            `SELECT n.*, c.name AS contact FROM notifications n LEFT JOIN contact_points c ON c.id = n.contact_point_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY n.id DESC LIMIT ?`,
          )
          .all(...args, limit) as Row[]
      ).map((r) => ({
        id: Number(r.id),
        groupKey: r.group_key as string,
        contactPoint: (r.contact as string | null) ?? "",
        kind: r.kind as NotificationKind,
        at: r.at as string,
        ok: r.ok === 1,
        error: (r.error as string | null) ?? null,
        onCall: (r.on_call as string | null) ?? null,
      }));
    },

    summary() {
      const groups = grouped();
      const day = iso(clock() - 24 * HOUR);
      const count = (sql: string, ...args: SQLInputValue[]) => (db.prepare(sql).get(...args) as { n: number }).n;
      const perHour = new Map(
        (db.prepare("SELECT substr(at, 1, 13) AS hour, COUNT(*) AS n FROM notifications WHERE at >= ? AND kind != 'test' GROUP BY hour").all(day) as Row[]).map(
          (r) => [r.hour as string, Number(r.n)],
        ),
      );
      const hourStart = Math.floor(clock() / HOUR) * HOUR;
      return {
        groups: {
          firing: groups.filter((g) => g.state === "firing").length,
          unacknowledged: groups.filter((g) => g.state === "firing" && g.route && !g.acknowledged).length,
          silenced: groups.filter((g) => g.state === "silenced").length,
          unrouted: groups.filter((g) => !g.route && g.state === "firing").length,
        },
        alerts: {
          firing: groups.reduce((n, g) => n + g.firing, 0),
          silenced: groups.reduce((n, g) => n + g.alerts.filter((a) => a.state === "silenced").length, 0),
        },
        silences: this.silences().filter((s) => s.state === "active").length,
        notifications: {
          lastDay: count("SELECT COUNT(*) AS n FROM notifications WHERE at >= ? AND kind != 'test'", day),
          failedLastDay: count("SELECT COUNT(*) AS n FROM notifications WHERE at >= ? AND ok = 0", day),
          perHour: Array.from({ length: 24 }, (_, i) => {
            const h = iso(hourStart - (23 - i) * HOUR).slice(0, 13);
            return { hour: `${h}:00:00.000Z`, sent: perHour.get(h) ?? 0 };
          }),
        },
        onCall: this.schedules().map((s) => ({ schedule: s.name, member: s.onCall })),
        configured: { routes: count("SELECT COUNT(*) AS n FROM routes"), contactPoints: count("SELECT COUNT(*) AS n FROM contact_points") },
        firing: groups
          .filter((g) => g.state === "firing")
          .slice(0, 10)
          .map(publicGroup),
      };
    },

    gauges() {
      const s = this.summary();
      return { firing: s.alerts.firing, unacknowledged: s.groups.unacknowledged, silenced: s.alerts.silenced, failedLastDay: s.notifications.failedLastDay };
    },

    /** Alerts resolved long ago, ended silences and old notifications are deleted after the retention. */
    purge(): number {
      const before = iso(clock() - retentionDays * 24 * HOUR);
      const keys = new Set(grouped().map((g) => g.key));
      let n = Number(db.prepare("DELETE FROM alerts WHERE ends_at < ?").run(iso(clock() - RESOLVED_SHOWN_MS)).changes);
      n += Number(db.prepare("DELETE FROM silences WHERE ends_at < ?").run(before).changes);
      n += Number(db.prepare("DELETE FROM notifications WHERE at < ?").run(before).changes);
      for (const r of db.prepare("SELECT key FROM groups WHERE notified_hash IS NULL").all() as Row[])
        if (!keys.has(r.key as string)) db.prepare("DELETE FROM groups WHERE key = ?").run(r.key as string);
      return n;
    },
  };
}

export type Alerts = ReturnType<typeof createAlerts>;
