import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  OverviewGrid,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  TimeSeriesChart,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  BellOff,
  BellRing,
  CalendarClock,
  Check,
  History,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Plus,
  Send,
  SendHorizontal,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
  Waypoints,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type AlertState,
  type ContactKind,
  type ContactPoint,
  type Group,
  type Labels,
  type Matcher,
  type Notification,
  type Op,
  type ProductLink,
  type Route as AlertRoute,
  type Schedule,
  type Silence,
  type Summary,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { search } from "./search.ts";

const PAGES = ["groups", "silences", "oncall", "routing", "history", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "group"; key: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, key] = path.replace(/^\//, "").split("/");
  if (page === "groups" && key) return { page: "group", key: decodeURIComponent(key) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** A query parameter of the address. */
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

/** Loads a list once and on demand, for the pages that edit what they show. */
function useList<T>(call: Call, path: string, key: string) {
  const [items, setItems] = useState<T[]>();
  const load = useCallback(
    () =>
      void call<Record<string, T[]>>(path).then(
        (r) => setItems(r[key]),
        () => setItems([]),
      ),
    [call, path, key],
  );
  useEffect(load, [load]);
  return [items, load] as const;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const hour = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const labelText = (labels: Labels) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
const groupName = (g: Group) => g.labels.alertname ?? g.alerts[0]?.labels.alertname ?? g.key;
const summaryOf = (a: { labels: Labels; annotations: Labels }) =>
  a.annotations.summary || a.annotations.description || [a.labels.alertname, a.labels.instance].filter(Boolean).join(" on ");

const STATE_TONE: Record<AlertState, Tone> = { firing: "danger", silenced: "neutral", resolved: "success" };

function StateBadge({ state }: { state: AlertState }) {
  const t = useT();
  return <StatusBadge tone={STATE_TONE[state]}>{t(`alertStates.${state}`)}</StatusBadge>;
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">{children}</pre>;
}

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

/** Runs a change and reports its error, the way every form here does. */
function useAction(after: () => void) {
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(undefined);
        after();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [after],
  );
  return [run, error] as const;
}

// ---------------------------------------------------------------- Overview

function useGroupColumns(): Column<Group>[] {
  const t = useT();
  return [
    {
      id: "name",
      header: t("groupsPage.group"),
      width: "36%",
      sortValue: (g) => groupName(g),
      cell: (g) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{groupName(g)}</span>
          <span className="alerts-clamp font-mono text-2xs text-fg-muted" title={labelText(g.labels)}>
            {labelText(g.labels) || "–"}
          </span>
        </span>
      ),
    },
    { id: "state", header: t("groupsPage.state"), width: "120px", sortValue: (g) => g.state, cell: (g) => <StateBadge state={g.state} /> },
    {
      id: "alerts",
      header: t("groupsPage.alerts"),
      width: "80px",
      align: "right",
      mono: true,
      sortValue: (g) => g.firing,
      cell: (g) => g.firing || g.alerts.length,
    },
    {
      id: "route",
      header: t("groupsPage.route"),
      cell: (g) => (g.route ? g.route.name : <Badge tone="warning">{t("groupsPage.unrouted")}</Badge>),
    },
    {
      id: "who",
      header: t("groupsPage.who"),
      cell: (g) =>
        g.acknowledged ? (
          <span className="text-xs">{t("groupsPage.ackedBy", { who: g.acknowledged.by })}</span>
        ) : (
          <span className="text-xs text-fg-muted">{g.onCall ? t("groupsPage.onCall", { who: g.onCall.name }) : "–"}</span>
        ),
    },
    {
      id: "since",
      header: t("groupsPage.since"),
      width: "150px",
      align: "right",
      sortValue: (g) => g.firstAt,
      cell: (g) => <span className="whitespace-nowrap text-fg-muted">{when(g.firstAt)}</span>,
    },
  ];
}

function OverviewPage({ summary }: { summary: Summary }) {
  const t = useT();
  const s = summary;
  const columns = useGroupColumns();
  return (
    <>
      <PageHeader title={t("overviewPage.overview")} description={t("overviewPage.description")} />
      {s.notifications.failedLastDay > 0 && (
        <Callout
          tone="danger"
          title={t("overviewPage.failed", { count: s.notifications.failedLastDay })}
          action={
            <Button size="sm" onClick={() => navigate("/history?failed=true")}>
              {t("overviewPage.see")}
            </Button>
          }
        >
          {t("overviewPage.failedDetail")}
        </Callout>
      )}
      {s.groups.unrouted > 0 && (
        <Callout
          tone="warning"
          title={t("overviewPage.unrouted", { count: s.groups.unrouted })}
          action={
            <Button size="sm" onClick={() => navigate("/routing")}>
              {t("product.routing")}
            </Button>
          }
        >
          {t("overviewPage.unroutedDetail")}
        </Callout>
      )}
      <KpiGrid minWidth={150}>
        <KpiCard
          label={t("overviewPage.firing")}
          value={s.groups.firing}
          unit={t("overviewPage.alertsCount", { count: s.alerts.firing })}
          icon={BellRing}
          tone={s.groups.firing ? "danger" : "success"}
          href="/groups"
        />
        <KpiCard
          label={t("overviewPage.unacknowledged")}
          value={s.groups.unacknowledged}
          icon={TriangleAlert}
          tone={s.groups.unacknowledged ? "warning" : "success"}
          href="/groups"
        />
        <KpiCard
          label={t("overviewPage.silenced")}
          value={s.alerts.silenced}
          unit={t("overviewPage.silencesCount", { count: s.silences })}
          icon={BellOff}
          href="/silences"
        />
        <KpiCard
          label={t("overviewPage.sent24h")}
          value={s.notifications.lastDay}
          icon={Send}
          trend={s.notifications.perHour.map((h) => h.sent)}
          tone={s.notifications.failedLastDay ? "danger" : undefined}
          href="/history"
        />
      </KpiGrid>
      <OverviewGrid>
        <Panel title={t("overviewPage.firingNow")} flush>
          <DataTable
            label={t("overviewPage.firingNow")}
            columns={columns}
            rows={s.firing}
            getRowId={(g) => g.key}
            onRowClick={(g) => navigate(`/groups/${encodeURIComponent(g.key)}`)}
            minWidth={720}
            empty={<EmptyState title={t("overviewPage.quiet")}>{t("overviewPage.quietDetail")}</EmptyState>}
          />
        </Panel>
        <Panel title={t("overviewPage.onCallNow")}>
          {s.onCall.length ? (
            <ul className="alerts-list flex flex-col gap-1.5 text-sm">
              {s.onCall.map((o) => (
                <li key={o.schedule} className="flex items-center justify-between gap-2">
                  <span className="text-fg-muted">{o.schedule}</span>
                  <span className="font-medium">{o.member?.name ?? "–"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={t("overviewPage.noSchedules")} action={<Button onClick={() => navigate("/oncall")}>{t("product.oncall")}</Button>} />
          )}
        </Panel>
      </OverviewGrid>
      <Panel title={t("overviewPage.perHour")} description={t("overviewPage.perHourDetail")}>
        <TimeSeriesChart
          label={t("overviewPage.perHour")}
          labels={s.notifications.perHour.map((h) => hour(h.hour))}
          height={180}
          series={[{ id: "sent", name: t("overviewPage.sent"), data: s.notifications.perHour.map((h) => h.sent) }]}
        />
      </Panel>
    </>
  );
}

/** The first screen, until a route sends somewhere. */
function WelcomePage({ summary }: { summary: Summary }) {
  const t = useT();
  return (
    <>
      <PageHeader title={t("welcomePage.getStarted")} description={t("welcomePage.description")} />
      <Panel title={t("welcomePage.steps")}>
        <ol className="alerts-steps text-sm">
          <li>{t("welcomePage.step1")}</li>
          <li>{t("welcomePage.step2")}</li>
          <li>{t("welcomePage.step3")}</li>
          <li>{t("welcomePage.step4")}</li>
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Waypoints />} onClick={() => navigate("/routing")}>
            {t("product.routing")}
          </Button>
          <Button icon={<Wrench />} onClick={() => navigate("/setup")}>
            {t("product.setup")}
          </Button>
        </div>
      </Panel>
      {summary.alerts.firing > 0 && <Callout tone="warning" title={t("welcomePage.alreadyFiring", { count: summary.alerts.firing })} />}
    </>
  );
}

// ---------------------------------------------------------------- Groups

function GroupsPage({ call }: { call: Call }) {
  const t = useT();
  const [state, setState] = useState<AlertState | "all">("firing");
  const [groups, setGroups] = useState<Group[]>();
  const columns = useGroupColumns();
  useEffect(() => {
    setGroups(undefined);
    void call<{ groups: Group[] }>(`/api/v1/groups${state === "all" ? "" : `?state=${state}`}`).then(
      (r) => setGroups(r.groups),
      () => setGroups([]),
    );
  }, [call, state]);
  return (
    <>
      <PageHeader
        title={t("groupsPage.groups")}
        description={t("groupsPage.description")}
        actions={
          <SegmentedControl
            label={t("groupsPage.state")}
            value={state}
            onChange={setState}
            options={[
              { value: "firing", label: t("alertStates.firing") },
              { value: "silenced", label: t("alertStates.silenced") },
              { value: "resolved", label: t("alertStates.resolved") },
              { value: "all", label: t("groupsPage.all") },
            ]}
          />
        }
      />
      <Panel title={t("groupsPage.groups")} flush>
        <DataTable
          label={t("groupsPage.groups")}
          columns={columns}
          rows={groups ?? []}
          loading={!groups}
          getRowId={(g) => g.key}
          onRowClick={(g) => navigate(`/groups/${encodeURIComponent(g.key)}`)}
          minWidth={820}
          empty={<EmptyState title={t("overviewPage.quiet")}>{t("groupsPage.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

function GroupPage({ call, groupKey, reload }: { call: Call; groupKey: string; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [g, setG] = useState<(Group & { notifications: Notification[] }) | null>();
  const load = useCallback(
    () => void call<Group & { notifications: Notification[] }>(`/api/v1/groups/${encodeURIComponent(groupKey)}`).then(setG, () => setG(null)),
    [call, groupKey],
  );
  useEffect(load, [load]);
  const [run, error] = useAction(
    useCallback(() => {
      load();
      reload();
    }, [load, reload]),
  );
  if (g === null)
    return (
      <EmptyState title={t("groupPage.notFound")} action={<Button onClick={() => navigate("/groups")}>{t("groupPage.back")}</Button>}>
        {t("groupPage.notFoundDetail")}
      </EmptyState>
    );
  if (!g) return <EmptyState title={t("product.loading")} icon={<BellRing />} />;
  const ack = (acknowledged: boolean) =>
    void run(() => call(`/api/v1/groups/${encodeURIComponent(g.key)}`, { method: "PUT", body: JSON.stringify({ acknowledged }) }));
  const silenceHref = `/silences?${new URLSearchParams(Object.entries(g.labels).map(([k, v]) => [`m.${k}`, v])).toString()}`;
  const alertColumns: Column<Group["alerts"][number]>[] = [
    {
      id: "what",
      header: t("groupPage.alert"),
      cell: (a) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{summaryOf(a)}</span>
          <span className="alerts-clamp font-mono text-2xs text-fg-muted" title={labelText(a.labels)}>
            {labelText(a.labels)}
          </span>
        </span>
      ),
    },
    { id: "state", header: t("groupsPage.state"), width: "120px", cell: (a) => <StateBadge state={a.state} /> },
    {
      id: "since",
      header: t("groupsPage.since"),
      width: "150px",
      align: "right",
      cell: (a) => <span className="whitespace-nowrap text-fg-muted">{when(a.startsAt)}</span>,
    },
  ];
  const notifColumns: Column<Notification>[] = [
    { id: "at", header: t("historyPage.when"), width: "150px", cell: (n) => <span className="whitespace-nowrap">{when(n.at)}</span> },
    { id: "kind", header: t("historyPage.kind"), width: "120px", cell: (n) => <Badge>{t(`kinds.${n.kind}`)}</Badge> },
    { id: "to", header: t("historyPage.to"), cell: (n) => `${n.contactPoint}${n.onCall ? ` (${n.onCall})` : ""}` },
    {
      id: "ok",
      header: t("historyPage.result"),
      cell: (n) =>
        n.ok ? (
          <StatusBadge tone="success">{t("historyPage.sent")}</StatusBadge>
        ) : (
          <span className="flex flex-col items-start gap-0.5">
            <StatusBadge tone="danger">{t("historyPage.failed")}</StatusBadge>
            <span className="text-2xs text-danger">{n.error}</span>
          </span>
        ),
    },
  ];
  return (
    <>
      <PageHeader
        title={groupName(g)}
        breadcrumbs={[{ label: t("groupsPage.groups"), href: "/groups" }, { label: labelText(g.labels) || g.key }]}
        description={g.route ? t("groupPage.description", { route: g.route.name, since: when(g.firstAt) }) : t("groupPage.unrouted")}
        meta={<StateBadge state={g.state} />}
        actions={
          can("editor") && (
            <span className="flex flex-wrap gap-1.5">
              {g.state === "firing" &&
                (g.acknowledged ? (
                  <Button onClick={() => ack(false)}>{t("groupPage.unack")}</Button>
                ) : (
                  <Button variant="primary" icon={<Check />} onClick={() => ack(true)}>
                    {t("groupPage.ack")}
                  </Button>
                ))}
              <Button icon={<BellOff />} onClick={() => navigate(silenceHref)}>
                {t("groupPage.silence")}
              </Button>
            </span>
          )
        }
      />
      <ErrorText message={error} />
      {g.acknowledged && (
        <Callout tone="info" title={t("groupPage.acked", { who: g.acknowledged.by, when: when(g.acknowledged.at) })}>
          {t("groupPage.ackedDetail")}
        </Callout>
      )}
      {g.onCall && <p className="m-0 text-sm">{t("groupPage.onCall", { who: g.onCall.name })}</p>}
      <Panel title={t("groupPage.alerts")} flush>
        <DataTable label={t("groupPage.alerts")} columns={alertColumns} rows={g.alerts} getRowId={(a) => a.fingerprint} minWidth={640} />
      </Panel>
      <Panel title={t("groupPage.notifications")} flush>
        <DataTable
          label={t("groupPage.notifications")}
          columns={notifColumns}
          rows={g.notifications}
          getRowId={(n) => String(n.id)}
          minWidth={640}
          empty={<EmptyState title={t("groupPage.noNotifications")}>{g.route ? t("groupPage.noNotificationsDetail") : t("groupPage.unrouted")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Silences

const OPS: Op[] = ["=", "!=", "=~", "!~"];

function MatchersEditor({ value, onChange }: { value: Matcher[]; onChange: (m: Matcher[]) => void }) {
  const t = useT();
  const set = (i: number, m: Partial<Matcher>) => onChange(value.map((x, j) => (j === i ? { ...x, ...m } : x)));
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((m, i) => (
        <div key={i} className="alerts-matcher">
          <TextField label={t("matchers.label")} mono value={m.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="instance" />
          <SelectField
            label={t("matchers.op")}
            value={m.op}
            onChange={(e) => set(i, { op: e.target.value as Op })}
            options={OPS.map((o) => ({ value: o, label: o }))}
          />
          <TextField label={t("matchers.value")} mono value={m.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="db-1" />
          <Button icon={<Trash2 />} aria-label={t("matchers.remove")} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button size="sm" icon={<Plus />} onClick={() => onChange([...value, { label: "", op: "=", value: "" }])}>
          {t("matchers.add")}
        </Button>
      </div>
    </div>
  );
}

const matcherText = (ms: Matcher[]) => ms.map((m) => `${m.label}${m.op}"${m.value}"`).join(", ");

function SilencesPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [silences, load] = useList<Silence>(call, "/api/v1/silences", "silences");
  // A link from a group fills the matchers with its labels.
  const [matchers, setMatchers] = useState<Matcher[]>(() => {
    const from = [...new URLSearchParams(window.location.search)]
      .filter(([k]) => k.startsWith("m."))
      .map(([k, v]) => ({ label: k.slice(2), op: "=" as Op, value: v }));
    return from.length ? from : [{ label: "", op: "=", value: "" }];
  });
  const [hours, setHours] = useState("2");
  const [comment, setComment] = useState("");
  const [run, error] = useAction(
    useCallback(() => {
      load();
      reload();
    }, [load, reload]),
  );
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      call("/api/v1/silences", {
        method: "POST",
        body: JSON.stringify({
          matchers: matchers.filter((m) => m.label.trim()),
          endsAt: new Date(Date.now() + Number(hours) * 3_600_000).toISOString(),
          comment,
        }),
      }),
    ).then((ok) => ok && (setComment(""), setMatchers([{ label: "", op: "=", value: "" }])));
  };
  const columns: Column<Silence>[] = [
    { id: "matchers", header: t("silencesPage.matchers"), cell: (s) => <span className="alerts-wrap font-mono text-xs">{matcherText(s.matchers)}</span> },
    {
      id: "comment",
      header: t("silencesPage.comment"),
      cell: (s) => (
        <span className="flex flex-col text-xs">
          <span>{s.comment}</span>
          <span className="text-fg-muted">{s.createdBy}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: t("silencesPage.state"),
      width: "130px",
      cell: (s) => <StatusBadge tone={s.state === "active" ? "info" : "neutral"}>{t(`silenceStates.${s.state}`)}</StatusBadge>,
    },
    { id: "silenced", header: t("silencesPage.silenced"), width: "90px", align: "right", mono: true, cell: (s) => s.silenced },
    {
      id: "ends",
      header: t("silencesPage.ends"),
      width: "150px",
      align: "right",
      cell: (s) => <span className="whitespace-nowrap text-fg-muted">{when(s.endsAt)}</span>,
    },
    ...(can("editor")
      ? [
          {
            id: "end",
            header: "",
            width: "90px",
            align: "right" as const,
            cell: (s: Silence) =>
              s.state !== "expired" && (
                <Button size="xs" onClick={() => void run(() => call(`/api/v1/silences/${s.id}`, { method: "DELETE" }))}>
                  {t("silencesPage.end")}
                </Button>
              ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader title={t("silencesPage.silences")} description={t("silencesPage.description")} />
      {can("editor") && (
        <Panel title={t("silencesPage.new")} description={t("silencesPage.newDetail")}>
          <form className="flex flex-col gap-2.5" onSubmit={create} aria-label={t("silencesPage.new")}>
            <MatchersEditor value={matchers} onChange={setMatchers} />
            <div className="grid gap-2 sm:grid-cols-2">
              <SelectField
                label={t("silencesPage.for")}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                options={["1", "2", "4", "8", "24", "72"].map((h) => ({ value: h, label: t("silencesPage.hours", { count: Number(h) }) }))}
              />
              <TextField
                label={t("silencesPage.comment")}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t("silencesPage.commentPlaceholder")}
              />
            </div>
            <ErrorText message={error} />
            <div>
              <Button type="submit" variant="primary" icon={<BellOff />} disabled={!comment.trim() || !matchers.some((m) => m.label.trim())}>
                {t("silencesPage.create")}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      <Panel title={t("silencesPage.silences")} flush>
        <DataTable
          label={t("silencesPage.silences")}
          columns={columns}
          rows={silences ?? []}
          loading={!silences}
          getRowId={(s) => s.id}
          minWidth={760}
          empty={<EmptyState title={t("silencesPage.none")} />}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- On-call

/** Members as lines: a name, then a Slack id after a comma to mention them. */
const membersText = (s?: Schedule) => (s ? s.members.map((m) => (m.mention ? `${m.name}, ${m.mention}` : m.name)).join("\n") : "");
const parseMembers = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, mention] = l.split(",").map((x) => x.trim());
      return { name: name ?? "", mention: mention ?? "" };
    });

function ScheduleForm({ call, schedule, onDone }: { call: Call; schedule?: Schedule; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(schedule?.name ?? "");
  const [members, setMembers] = useState(membersText(schedule));
  const [shift, setShift] = useState(String(schedule?.shiftHours ?? 168));
  const [start, setStart] = useState(schedule ? schedule.startsAt.slice(0, 16) : "");
  const [run, error] = useAction(onDone);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      call(schedule ? `/api/v1/schedules/${schedule.id}` : "/api/v1/schedules", {
        method: schedule ? "PUT" : "POST",
        body: JSON.stringify({ name, members: parseMembers(members), shiftHours: Number(shift), ...(start && { startsAt: new Date(start).toISOString() }) }),
      }),
    );
  };
  return (
    <form className="flex flex-col gap-2.5" onSubmit={save} aria-label={schedule ? t("oncallPage.edit", { name: schedule.name }) : t("oncallPage.new")}>
      <div className="alerts-cols-3">
        <TextField label={t("oncallPage.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("oncallPage.namePlaceholder")} />
        <SelectField
          label={t("oncallPage.shift")}
          value={shift}
          onChange={(e) => setShift(e.target.value)}
          options={[
            { value: "12", label: t("oncallPage.shifts.12") },
            { value: "24", label: t("oncallPage.shifts.24") },
            { value: "168", label: t("oncallPage.shifts.168") },
            { value: "336", label: t("oncallPage.shifts.336") },
          ]}
        />
        <TextField
          label={t("oncallPage.start")}
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          hint={t("oncallPage.startHint")}
        />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("oncallPage.members")}</span>
        <textarea
          className="alerts-textarea"
          rows={4}
          value={members}
          onChange={(e) => setMembers(e.target.value)}
          placeholder={"Ayşe Demir, U024BE7LH\nCan Yılmaz"}
        />
        <span className="text-xs text-fg-muted">{t("oncallPage.membersHint")}</span>
      </label>
      <ErrorText message={error} />
      <div>
        <Button type="submit" variant="primary" disabled={!name.trim() || !parseMembers(members).length}>
          {t("oncallPage.save")}
        </Button>
      </div>
    </form>
  );
}

function OncallPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [schedules, load] = useList<Schedule>(call, "/api/v1/schedules", "schedules");
  const [editing, setEditing] = useState<string | null>(null);
  const done = useCallback(() => {
    setEditing(null);
    load();
    reload();
  }, [load, reload]);
  const [run, error] = useAction(done);
  return (
    <>
      <PageHeader
        title={t("oncallPage.oncall")}
        description={t("oncallPage.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
              {t("oncallPage.new")}
            </Button>
          )
        }
      />
      <ErrorText message={error} />
      {editing === "new" && (
        <Panel title={t("oncallPage.new")}>
          <ScheduleForm call={call} onDone={done} />
        </Panel>
      )}
      {schedules && !schedules.length && editing !== "new" && <EmptyState title={t("oncallPage.none")}>{t("oncallPage.noneDetail")}</EmptyState>}
      {schedules?.map((s) => (
        <Panel
          key={s.id}
          title={s.name}
          description={s.onCall ? t("oncallPage.now", { who: s.onCall.name }) : t("oncallPage.notStarted")}
          actions={
            can("editor") && (
              <span className="flex gap-1.5">
                <Button size="sm" onClick={() => setEditing(editing === s.id ? null : s.id)}>
                  {t("oncallPage.change")}
                </Button>
                <Button
                  size="sm"
                  icon={<Trash2 />}
                  aria-label={t("oncallPage.delete", { name: s.name })}
                  onClick={() => void run(() => call(`/api/v1/schedules/${s.id}`, { method: "DELETE" }))}
                />
              </span>
            )
          }
        >
          {editing === s.id ? (
            <ScheduleForm call={call} schedule={s} onDone={done} />
          ) : (
            <ol className="alerts-list flex flex-col gap-1 text-sm" aria-label={t("oncallPage.next", { name: s.name })}>
              {s.shifts.map((x, i) => (
                <li key={x.from} className="alerts-shift">
                  <span className={i === 0 && s.onCall ? "font-medium" : ""}>{x.member.name}</span>
                  <span className="text-xs text-fg-muted">
                    {when(x.from)} → {when(x.to)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- Routing

function RoutingPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const admin = can("admin");
  const [contacts, loadContacts] = useList<ContactPoint>(call, "/api/v1/contact-points", "contactPoints");
  const [schedules] = useList<Schedule>(call, "/api/v1/schedules", "schedules");
  const [routes, setRoutes] = useState<Array<Omit<AlertRoute, "id"> & { id?: string }>>();
  const [saved, setSaved] = useState("");
  const loadRoutes = useCallback(
    () =>
      void call<{ routes: AlertRoute[] }>("/api/v1/routes").then(
        (r) => (setRoutes(r.routes), setSaved(JSON.stringify(r.routes))),
        () => setRoutes([]),
      ),
    [call],
  );
  useEffect(loadRoutes, [loadRoutes]);
  const [cpName, setCpName] = useState("");
  const [cpKind, setCpKind] = useState<ContactKind>("slack");
  const [cpUrl, setCpUrl] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});
  const after = useCallback(() => {
    loadContacts();
    loadRoutes();
    reload();
  }, [loadContacts, loadRoutes, reload]);
  const [run, error] = useAction(after);
  const addContact = (e: FormEvent) => {
    e.preventDefault();
    void run(() => call("/api/v1/contact-points", { method: "POST", body: JSON.stringify({ name: cpName, kind: cpKind, url: cpUrl }) })).then(
      (ok) => ok && (setCpName(""), setCpUrl("")),
    );
  };
  const test = (id: string) =>
    void call<{ ok: boolean; error: string | null }>(`/api/v1/contact-points/${id}/test`, { method: "POST" }).then(
      (r) => (setTested((x) => ({ ...x, [id]: r.ok ? t("routingPage.testOk") : (r.error ?? "") })), loadContacts()),
      (err: Error) => setTested((x) => ({ ...x, [id]: err.message })),
    );
  const change = (i: number, r: Partial<AlertRoute>) => setRoutes((rs) => rs?.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const move = (i: number, d: number) =>
    setRoutes((rs) => {
      if (!rs || i + d < 0 || i + d >= rs.length) return rs;
      const out = [...rs];
      [out[i], out[i + d]] = [out[i + d]!, out[i]!];
      return out;
    });
  const contactOptions = (contacts ?? []).map((c) => ({ value: c.id, label: c.name }));
  const contactColumns: Column<ContactPoint>[] = [
    { id: "name", header: t("routingPage.name"), cell: (c) => <span className="font-medium">{c.name}</span> },
    { id: "kind", header: t("routingPage.kind"), width: "100px", cell: (c) => <Badge>{t(`contactKinds.${c.kind}`)}</Badge> },
    { id: "target", header: t("routingPage.target"), cell: (c) => <span className="alerts-wrap font-mono text-xs">{c.target}</span> },
    {
      id: "last",
      header: t("routingPage.last"),
      cell: (c) =>
        tested[c.id] ? (
          <span className="text-xs">{tested[c.id]}</span>
        ) : c.lastSent ? (
          <StatusBadge tone={c.lastSent.ok ? "success" : "danger"}>{c.lastSent.ok ? when(c.lastSent.at) : c.lastSent.error}</StatusBadge>
        ) : (
          <span className="text-xs text-fg-muted">–</span>
        ),
    },
    {
      id: "act",
      header: "",
      width: "150px",
      align: "right",
      cell: (c) => (
        <span className="flex justify-end gap-1">
          {can("editor") && (
            <Button size="xs" icon={<SendHorizontal />} onClick={() => test(c.id)}>
              {t("routingPage.test")}
            </Button>
          )}
          {admin && (
            <Button
              size="xs"
              icon={<Trash2 />}
              aria-label={t("routingPage.deleteContact", { name: c.name })}
              onClick={() => void run(() => call(`/api/v1/contact-points/${c.id}`, { method: "DELETE" }))}
            />
          )}
        </span>
      ),
    },
  ];
  const blank = (): Omit<AlertRoute, "id"> => ({
    name: "",
    matchers: [],
    groupBy: ["alertname"],
    contactPointId: contacts?.[0]?.id ?? "",
    scheduleId: null,
    repeatMinutes: 240,
    escalateMinutes: null,
    escalateContactPointId: null,
  });
  return (
    <>
      <PageHeader title={t("routingPage.routing")} description={t("routingPage.description")} />
      <ErrorText message={error} />
      <Panel title={t("routingPage.contactPoints")} description={t("routingPage.contactPointsDetail")} flush>
        <DataTable
          label={t("routingPage.contactPoints")}
          columns={contactColumns}
          rows={contacts ?? []}
          loading={!contacts}
          getRowId={(c) => c.id}
          minWidth={720}
          empty={<EmptyState title={t("routingPage.noContacts")}>{t("routingPage.noContactsDetail")}</EmptyState>}
        />
        {admin && (
          <form className="flex flex-col gap-2 border-t border-line px-3 py-3" onSubmit={addContact} aria-label={t("routingPage.addContact")}>
            <div className="alerts-cols-3">
              <TextField label={t("routingPage.name")} value={cpName} onChange={(e) => setCpName(e.target.value)} placeholder="db-team" />
              <SelectField
                label={t("routingPage.kind")}
                value={cpKind}
                onChange={(e) => setCpKind(e.target.value as ContactKind)}
                options={(["slack", "teams", "webhook"] as const).map((k) => ({ value: k, label: t(`contactKinds.${k}`) }))}
              />
              <TextField
                label={t("routingPage.url")}
                mono
                type="password"
                autoComplete="off"
                value={cpUrl}
                onChange={(e) => setCpUrl(e.target.value)}
                hint={t(`contactHints.${cpKind}`)}
              />
            </div>
            <div>
              <Button type="submit" size="sm" variant="primary" icon={<Plus />} disabled={!cpName.trim() || !cpUrl.trim()}>
                {t("routingPage.addContact")}
              </Button>
            </div>
          </form>
        )}
      </Panel>
      <Panel title={t("routingPage.routes")} description={t("routingPage.routesDetail")}>
        {!routes ? null : (
          <div className="flex flex-col gap-3">
            {!routes.length && <p className="m-0 text-sm text-fg-muted">{t("routingPage.noRoutes")}</p>}
            {routes.map((r, i) => (
              <fieldset key={r.id ?? `new-${i}`} className="alerts-route" disabled={!admin}>
                <legend className="text-xs text-fg-muted">{t("routingPage.routeN", { n: i + 1 })}</legend>
                <div className="alerts-cols-3">
                  <TextField
                    label={t("routingPage.name")}
                    value={r.name}
                    onChange={(e) => change(i, { name: e.target.value })}
                    placeholder={t("routingPage.routeName")}
                  />
                  <SelectField
                    label={t("routingPage.sendTo")}
                    value={r.contactPointId}
                    onChange={(e) => change(i, { contactPointId: e.target.value })}
                    options={contactOptions}
                  />
                  <SelectField
                    label={t("routingPage.schedule")}
                    value={r.scheduleId ?? ""}
                    onChange={(e) => change(i, { scheduleId: e.target.value || null })}
                    options={[{ value: "", label: t("routingPage.noSchedule") }, ...(schedules ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                  />
                </div>
                <p className="m-0 text-xs font-medium">{t("routingPage.when")}</p>
                <MatchersEditor value={r.matchers} onChange={(matchers) => change(i, { matchers })} />
                <div className="alerts-cols-4">
                  <TextField
                    label={t("routingPage.groupBy")}
                    mono
                    value={r.groupBy.join(", ")}
                    onChange={(e) =>
                      change(i, {
                        groupBy: e.target.value
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <TextField
                    label={t("routingPage.repeat")}
                    inputMode="numeric"
                    value={String(r.repeatMinutes)}
                    onChange={(e) => change(i, { repeatMinutes: Number(e.target.value) || 0 })}
                  />
                  <TextField
                    label={t("routingPage.escalateAfter")}
                    inputMode="numeric"
                    value={r.escalateMinutes === null ? "" : String(r.escalateMinutes)}
                    onChange={(e) => change(i, { escalateMinutes: e.target.value ? Number(e.target.value) : null })}
                    placeholder={t("routingPage.never")}
                  />
                  <SelectField
                    label={t("routingPage.escalateTo")}
                    value={r.escalateContactPointId ?? ""}
                    onChange={(e) => change(i, { escalateContactPointId: e.target.value || null })}
                    options={[{ value: "", label: t("routingPage.nobody") }, ...contactOptions]}
                  />
                </div>
                {admin && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" onClick={() => move(i, -1)} disabled={i === 0}>
                      {t("routingPage.up")}
                    </Button>
                    <Button size="xs" onClick={() => move(i, 1)} disabled={i === routes.length - 1}>
                      {t("routingPage.down")}
                    </Button>
                    <Button size="xs" icon={<Trash2 />} onClick={() => setRoutes((rs) => rs?.filter((_, j) => j !== i))}>
                      {t("routingPage.remove")}
                    </Button>
                  </div>
                )}
              </fieldset>
            ))}
            {admin && (
              <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Plus />} disabled={!contacts?.length} onClick={() => setRoutes((rs) => [...(rs ?? []), blank()])}>
                  {t("routingPage.addRoute")}
                </Button>
                <Button
                  variant="primary"
                  disabled={JSON.stringify(routes) === saved}
                  onClick={() => void run(() => call("/api/v1/routes", { method: "PUT", body: JSON.stringify({ routes }) }))}
                >
                  {t("routingPage.save")}
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- History and setup

function HistoryPage({ call }: { call: Call }) {
  const t = useT();
  const [failed, setFailed] = useState(param("failed") === "true");
  const [items, setItems] = useState<Notification[]>();
  useEffect(() => {
    setItems(undefined);
    void call<{ notifications: Notification[] }>(`/api/v1/notifications${failed ? "?failed=true" : ""}`).then(
      (r) => setItems(r.notifications),
      () => setItems([]),
    );
  }, [call, failed]);
  const columns: Column<Notification>[] = [
    { id: "at", header: t("historyPage.when"), width: "150px", cell: (n) => <span className="whitespace-nowrap">{when(n.at)}</span> },
    { id: "kind", header: t("historyPage.kind"), width: "120px", cell: (n) => <Badge>{t(`kinds.${n.kind}`)}</Badge> },
    {
      id: "group",
      header: t("historyPage.group"),
      cell: (n) => (n.groupKey === "test" ? "–" : <a href={`/groups/${encodeURIComponent(n.groupKey)}`}>{n.groupKey}</a>),
    },
    { id: "to", header: t("historyPage.to"), cell: (n) => `${n.contactPoint}${n.onCall ? ` (${n.onCall})` : ""}` },
    {
      id: "ok",
      header: t("historyPage.result"),
      cell: (n) => (n.ok ? <StatusBadge tone="success">{t("historyPage.sent")}</StatusBadge> : <span className="text-xs text-danger">{n.error}</span>),
    },
  ];
  return (
    <>
      <PageHeader
        title={t("historyPage.history")}
        description={t("historyPage.description")}
        actions={
          <SegmentedControl
            label={t("historyPage.result")}
            value={failed ? "failed" : "all"}
            onChange={(v) => setFailed(v === "failed")}
            options={[
              { value: "all", label: t("groupsPage.all") },
              { value: "failed", label: t("historyPage.failed") },
            ]}
          />
        }
      />
      <Panel title={t("historyPage.history")} flush>
        <DataTable
          label={t("historyPage.history")}
          columns={columns}
          rows={items ?? []}
          loading={!items}
          getRowId={(n) => String(n.id)}
          minWidth={760}
          empty={<EmptyState title={t("historyPage.none")} />}
        />
      </Panel>
    </>
  );
}

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  const host = window.location.host;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.description")} />
      <Panel title={t("setupPage.prometheus")} description={t("setupPage.prometheusDetail")}>
        <Code>{`# prometheus.yml (vmalert takes -notifier.url=${origin} and -notifier.bearerToken)
alerting:
  alertmanagers:
    - scheme: ${origin.startsWith("https") ? "https" : "http"}
      authorization:
        credentials: <ALERTS_INGEST_TOKEN>
      static_configs:
        - targets: ["${host}"]`}</Code>
      </Panel>
      <Panel title={t("setupPage.script")} description={t("setupPage.scriptDetail")}>
        <Code>{`curl -sf -X POST -H "Authorization: Bearer $ALERTS_INGEST_TOKEN" -H 'content-type: application/json' \\
  --data '[{"labels":{"alertname":"BackupFailed","team":"db"},"annotations":{"summary":"Nightly backup of db-1 failed"}}]' \\
  ${origin}/api/v1/alerts`}</Code>
      </Panel>
      <Panel title={t("setupPage.alertmanager")} description={t("setupPage.alertmanagerDetail")}>
        <Code>{`receivers:
  - name: openasy
    webhook_configs:
      - url: ${origin}/api/v1/alerts
        http_config:
          authorization: { credentials: <ALERTS_INGEST_TOKEN> }`}</Code>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "alerts" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const nav = [
    { id: "overview", label: msg("product.overview"), icon: LayoutDashboard },
    { id: "groups", label: msg("product.groups"), icon: BellRing, count: summary?.groups.firing || undefined },
    { id: "silences", label: msg("product.silences"), icon: BellOff, count: summary?.silences || undefined },
    { id: "oncall", label: msg("product.oncall"), icon: CalendarClock },
    { id: "routing", label: msg("product.routing"), icon: Waypoints },
    { id: "history", label: msg("product.history"), icon: History },
    { id: "setup", label: msg("product.setup"), icon: Wrench },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens";

  return (
    <AppShell
      product="alerts"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={route.page === "group" ? "groups" : route.page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={route.page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<BellRing />}>
          {msg("product.reading")}
        </EmptyState>
      ) : route.page === "overview" && !summary.configured.routes ? (
        <WelcomePage summary={summary} />
      ) : route.page === "overview" ? (
        <OverviewPage summary={summary} />
      ) : route.page === "groups" ? (
        <GroupsPage call={call} />
      ) : route.page === "group" ? (
        <GroupPage key={route.key} call={call} groupKey={route.key} reload={reload} />
      ) : route.page === "silences" ? (
        <SilencesPage key={window.location.search} call={call} reload={reload} />
      ) : route.page === "oncall" ? (
        <OncallPage call={call} reload={reload} />
      ) : route.page === "routing" ? (
        <RoutingPage call={call} reload={reload} />
      ) : route.page === "history" ? (
        <HistoryPage key={window.location.search} call={call} />
      ) : (
        <SetupPage />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Alerts">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
