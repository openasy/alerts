// What the search window (Cmd+K) finds in Alerts: groups by their labels and the names of their alerts. They are read
// whole and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { BellRing } from "lucide-react";
import type { Group } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const { groups } = await call<{ groups: Group[] }>("/api/v1/groups", { signal });
    return groups
      .filter((g) => g.alerts.some((a) => Object.values(a.labels).some((v) => v.toLowerCase().includes(q))))
      .slice(0, 8)
      .map((g): SearchResult => ({
        id: `group:${g.key}`,
        label: g.labels.alertname ?? Object.values(g.labels).join(" ") ?? g.key,
        detail: t(`alertStates.${g.state}`),
        kind: t("search.group"),
        icon: BellRing,
        severity: g.state === "firing" ? "high" : undefined,
        href: `/groups/${encodeURIComponent(g.key)}`,
      }));
  };
}
