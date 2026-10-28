import { describe, expect, it } from "vitest";
import { payload, title, type Message } from "./notify.ts";

const m: Message = {
  kind: "firing",
  group: { key: "rt-1", labels: { alertname: "DiskFull", team: "db" } },
  alerts: [
    { labels: { alertname: "DiskFull", instance: "db-1" }, annotations: { summary: "Disk 95% full on db-1" }, startsAt: "", endsAt: "", firing: true },
    { labels: { alertname: "DiskFull", instance: "db-2" }, annotations: {}, startsAt: "", endsAt: "", firing: true },
  ],
  onCall: { name: "Ayşe", mention: "U024BE7LH" },
  url: "https://alerts.example.com/groups/rt-1",
};

describe("notifications", () => {
  it("say what fires, for whom", () => {
    expect(title(m)).toBe("[FIRING:2] DiskFull (team=db)");
    expect(title({ ...m, kind: "repeat" })).toBe("[FIRING:2] DiskFull (team=db), still firing");
    expect(title({ ...m, kind: "escalation" })).toBe("[ESCALATED, FIRING:2] DiskFull (team=db)");
    expect(title({ ...m, kind: "resolved", alerts: m.alerts.map((a) => ({ ...a, firing: false })) })).toBe("[RESOLVED] DiskFull (team=db)");
  });

  it("mention the person on call in Slack", () => {
    const text = (payload("slack", m) as { text: string }).text;
    expect(text).toBe(
      "*[FIRING:2] DiskFull (team=db)*\n• Disk 95% full on db-1\n• DiskFull on db-2\nOn call: Ayşe <@U024BE7LH>\n<https://alerts.example.com/groups/rt-1|Open in Alerts>",
    );
  });

  it("send Teams an Adaptive Card, and a webhook the whole group", () => {
    const teams = payload("teams", m) as any;
    expect(teams.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(teams.attachments[0].content.body[0].text).toBe("[FIRING:2] DiskFull (team=db)");
    expect(teams.attachments[0].content.actions[0].url).toBe(m.url);
    expect(payload("webhook", m)).toMatchObject({ version: "1", kind: "firing", group: m.group, onCall: m.onCall, url: m.url });
  });
});
