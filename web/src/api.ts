// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Labels = Record<string, string>;
export type AlertState = "firing" | "silenced" | "resolved";
export type Op = "=" | "!=" | "=~" | "!~";
export type ContactKind = "slack" | "teams" | "webhook";
export type NotificationKind = "firing" | "repeat" | "escalation" | "resolved" | "test";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Matcher {
  label: string;
  op: Op;
  value: string;
}

export interface Member {
  name: string;
  mention: string;
}

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

export interface Silence {
  id: string;
  matchers: Matcher[];
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
  createdAt: string;
  state: "active" | "pending" | "expired";
  silenced: number;
}

export interface Schedule {
  id: string;
  name: string;
  members: Member[];
  shiftHours: number;
  startsAt: string;
  onCall: Member | null;
  shifts: Array<{ member: Member; from: string; to: string }>;
}

export interface ContactPoint {
  id: string;
  name: string;
  kind: ContactKind;
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

export interface Summary {
  groups: { firing: number; unacknowledged: number; silenced: number; unrouted: number };
  alerts: { firing: number; silenced: number };
  silences: number;
  notifications: { lastDay: number; failedLastDay: number; perHour: Array<{ hour: string; sent: number }> };
  onCall: Array<{ schedule: string; member: Member | null }>;
  configured: { routes: number; contactPoints: number };
  firing: Group[];
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
