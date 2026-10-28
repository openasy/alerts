// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  firing: number;
  unacknowledged: number;
  silenced: number;
  failedLastDay: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="alerts",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_alerts_firing Alerts firing now, without silenced ones.",
    "# TYPE openasy_alerts_firing gauge",
    `openasy_alerts_firing ${g.firing}`,
    "# HELP openasy_alerts_groups_unacknowledged Firing groups nobody has acknowledged.",
    "# TYPE openasy_alerts_groups_unacknowledged gauge",
    `openasy_alerts_groups_unacknowledged ${g.unacknowledged}`,
    "# HELP openasy_alerts_silenced Firing alerts a silence holds back.",
    "# TYPE openasy_alerts_silenced gauge",
    `openasy_alerts_silenced ${g.silenced}`,
    "# HELP openasy_alerts_notifications_failed Notifications that did not get through in the last 24 hours. Watch this from another system.",
    "# TYPE openasy_alerts_notifications_failed gauge",
    `openasy_alerts_notifications_failed ${g.failedLastDay}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
