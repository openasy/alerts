// What a notification says, and how it is sent to each kind of contact point: a Slack or Teams incoming webhook, or
// any webhook with the whole group as JSON (ADR 0059). A call gives up after 10 seconds.

export type ContactKind = "slack" | "teams" | "webhook";
export type NotificationKind = "firing" | "repeat" | "escalation" | "resolved" | "test";

export interface Message {
  kind: NotificationKind;
  group: { key: string; labels: Record<string, string> };
  alerts: Array<{ labels: Record<string, string>; annotations: Record<string, string>; startsAt: string; endsAt: string; firing: boolean }>;
  onCall: { name: string; mention?: string } | null;
  /** The group's page in Alerts. */
  url: string;
}

/** One line for an alert: its summary, else its description, else its name and instance. */
export function line(a: Message["alerts"][number]): string {
  const text = a.annotations.summary || a.annotations.description || [a.labels.alertname, a.labels.instance].filter(Boolean).join(" on ");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

export function title(m: Message): string {
  const firing = m.alerts.filter((a) => a.firing).length;
  const name = m.group.labels.alertname ?? m.alerts[0]?.labels.alertname ?? "Alert";
  const tag = m.kind === "resolved" ? "RESOLVED" : m.kind === "test" ? "TEST" : m.kind === "escalation" ? `ESCALATED, FIRING:${firing}` : `FIRING:${firing}`;
  const labels = Object.entries(m.group.labels)
    .filter(([k]) => k !== "alertname")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `[${tag}] ${name}${labels ? ` (${labels})` : ""}${m.kind === "repeat" ? ", still firing" : ""}`;
}

/** A Slack user or group id becomes a mention; anything else is shown as written. */
const slackMention = (m: string) => (/^[UW][A-Z0-9]{6,}$/.test(m) ? `<@${m}>` : /^S[A-Z0-9]{6,}$/.test(m) ? `<!subteam^${m}>` : m);

export function payload(kind: ContactKind, m: Message): unknown {
  const lines = m.alerts.slice(0, 20).map((a) => `${a.firing ? "" : "(resolved) "}${line(a)}`);
  if (m.alerts.length > 20) lines.push(`and ${m.alerts.length - 20} more`);
  const onCall = m.onCall ? `On call: ${m.onCall.name}` : "";
  if (kind === "slack") {
    const who = m.onCall ? `${onCall}${m.onCall.mention ? ` ${slackMention(m.onCall.mention)}` : ""}` : "";
    return { text: [`*${title(m)}*`, ...lines.map((l) => `• ${l}`), who, `<${m.url}|Open in Alerts>`].filter(Boolean).join("\n") };
  }
  if (kind === "teams") {
    // A Teams workflow ("When a Teams webhook request is received") posts the Adaptive Card it is given.
    return {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: title(m), weight: "Bolder", wrap: true },
              ...lines.map((l) => ({ type: "TextBlock", text: `- ${l}`, wrap: true, spacing: "None" })),
              ...(onCall ? [{ type: "TextBlock", text: onCall, wrap: true }] : []),
            ],
            actions: [{ type: "Action.OpenUrl", title: "Open in Alerts", url: m.url }],
          },
        },
      ],
    };
  }
  return { version: "1", kind: m.kind, title: title(m), group: m.group, alerts: m.alerts, onCall: m.onCall, url: m.url };
}

export async function send(kind: ContactKind, url: string, m: Message, http: typeof fetch = fetch): Promise<void> {
  const res = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "openasy-alerts" },
    body: JSON.stringify(payload(kind, m)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The contact point answered ${res.status}.`);
  await res.body?.cancel();
}
